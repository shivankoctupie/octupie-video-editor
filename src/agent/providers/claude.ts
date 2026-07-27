import type { Provider, ProviderRequest, ProviderResult, ProviderDiagnostic } from "./types.js";
import { execProcess, type ExecFn } from "../exec.js";

/**
 * Claude CLI adapter.
 *
 * Uses the standalone `claude` binary in noninteractive print mode with
 * structured JSON output. The prompt is delivered on stdin, never on argv, so
 * nothing is interpolated into a command line. Auth comes from the user's own
 * `claude` login session or standard API env vars; this adapter reads no auth
 * files itself and never touches another tool's private credential store.
 */

const DEFAULT_TIMEOUT = 120_000;

export function claudeBinary(): string {
  return process.env.OVE_CLAUDE_BIN?.trim() || "claude";
}

/** Argument array for a single noninteractive, JSON-output print-mode call. */
export function buildClaudeArgs(system: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--no-session-persistence",
    "--append-system-prompt",
    system,
  ];
}

export interface ClaudeOutput {
  ok: boolean;
  text: string;
  error?: string;
}

/** Parse the `--output-format json` envelope; fall back to raw text. */
export function parseClaudeOutput(raw: string): ClaudeOutput {
  const trimmed = raw.trim();
  try {
    const env = JSON.parse(trimmed) as { is_error?: boolean; result?: unknown; error?: unknown };
    if (env && typeof env === "object" && ("result" in env || "is_error" in env)) {
      if (env.is_error) {
        return { ok: false, text: String(env.result ?? env.error ?? ""), error: String(env.result ?? env.error ?? "claude error") };
      }
      return { ok: true, text: typeof env.result === "string" ? env.result : JSON.stringify(env.result) };
    }
  } catch {
    /* not the JSON envelope; treat as raw text */
  }
  if (trimmed.length === 0) return { ok: false, text: "", error: "empty claude output" };
  return { ok: true, text: trimmed };
}

export interface ClaudeProviderOptions {
  exec?: ExecFn;
  binary?: string;
  timeoutMs?: number;
}

export function createClaudeProvider(opts: ClaudeProviderOptions = {}): Provider {
  const exec = opts.exec ?? execProcess;
  const binary = opts.binary ?? claudeBinary();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  return {
    id: "claude-cli",
    async generate(req: ProviderRequest): Promise<ProviderResult> {
      const args = buildClaudeArgs(req.system);
      const res = await exec(binary, args, { input: req.prompt, timeoutMs });
      const meta = { provider: "claude-cli", binary, args, code: res.code, timedOut: res.timedOut };
      if (res.spawnError) {
        return { ok: false, text: "", error: `claude not available: ${res.spawnError}`, meta };
      }
      if (res.timedOut) {
        return { ok: false, text: "", error: `claude timed out after ${timeoutMs}ms`, meta };
      }
      if (res.code !== 0) {
        return { ok: false, text: res.stdout, error: `claude exited ${res.code}: ${res.stderr.trim()}`, meta };
      }
      const parsed = parseClaudeOutput(res.stdout);
      return { ok: parsed.ok, text: parsed.text, ...(parsed.error ? { error: parsed.error } : {}), meta };
    },
    async diagnose(): Promise<ProviderDiagnostic> {
      const res = await exec(binary, ["--version"], { timeoutMs: 15_000 });
      const available = !res.spawnError && !res.timedOut && res.code === 0;
      const auth = available
        ? await exec(binary, ["auth", "status", "--text"], { timeoutMs: 15_000 })
        : undefined;
      const authenticated = process.env.ANTHROPIC_API_KEY?.trim()
        ? true
        : auth
          ? !auth.spawnError && !auth.timedOut && auth.code === 0
          : false;
      return {
        id: "claude-cli",
        available,
        authenticated,
        authSource: process.env.ANTHROPIC_API_KEY?.trim()
          ? "ANTHROPIC_API_KEY environment variable"
          : "standalone claude CLI login",
        binary,
        detail: available
          ? `claude responded: ${res.stdout.trim().split("\n")[0] ?? "ok"}; auth ${authenticated ? "ready" : "not ready"}`
          : `claude unavailable: ${res.spawnError ?? (res.stderr.trim() || `exit ${res.code}`)}`,
      };
    },
  };
}
