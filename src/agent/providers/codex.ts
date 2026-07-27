import type { Provider, ProviderRequest, ProviderResult, ProviderDiagnostic } from "./types.js";
import { execProcess, type ExecFn } from "../exec.js";

/**
 * Codex CLI adapter.
 *
 * Uses the standalone `codex` binary in noninteractive `exec` mode with JSON
 * event output. Codex has no separate system channel in exec mode, so the
 * system text and prompt are merged and delivered on stdin, never on argv. Auth
 * comes from the user's own `codex` login or standard API env vars; this adapter
 * reads no auth files and never touches another tool's private credential store.
 */

const DEFAULT_TIMEOUT = 120_000;

export function codexBinary(): string {
  return process.env.OVE_CODEX_BIN?.trim() || "codex";
}

/** Argument array for a single noninteractive JSON exec call (prompt on stdin). */
export function buildCodexArgs(): string[] {
  return ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-"];
}

export interface CodexOutput {
  ok: boolean;
  text: string;
  error?: string;
}

/** Extract the final agent message from codex JSON/JSONL event output. */
export function parseCodexOutput(raw: string): CodexOutput {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let last: string | undefined;
  for (const line of lines) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    // Newer shape: { type: "item.completed", item: { type: "agent_message", text } }
    if (ev?.item?.type === "agent_message" && typeof ev.item.text === "string") {
      last = ev.item.text;
    }
    // Alternate shape: { msg: { type: "agent_message", message } }
    if (ev?.msg?.type === "agent_message" && typeof ev.msg.message === "string") {
      last = ev.msg.message;
    }
  }
  if (last !== undefined) return { ok: true, text: last };
  if (lines.length === 0) return { ok: false, text: "", error: "empty codex output" };
  // Fall back to the raw text; the loop's JSON extractor may still recover a plan.
  return { ok: true, text: raw.trim() };
}

export interface CodexProviderOptions {
  exec?: ExecFn;
  binary?: string;
  timeoutMs?: number;
}

export function createCodexProvider(opts: CodexProviderOptions = {}): Provider {
  const exec = opts.exec ?? execProcess;
  const binary = opts.binary ?? codexBinary();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  return {
    id: "codex-cli",
    async generate(req: ProviderRequest): Promise<ProviderResult> {
      const args = buildCodexArgs();
      const input = `${req.system}\n\n${req.prompt}`;
      const res = await exec(binary, args, { input, timeoutMs });
      const meta = { provider: "codex-cli", binary, args, code: res.code, timedOut: res.timedOut };
      if (res.spawnError) {
        return { ok: false, text: "", error: `codex not available: ${res.spawnError}`, meta };
      }
      if (res.timedOut) {
        return { ok: false, text: "", error: `codex timed out after ${timeoutMs}ms`, meta };
      }
      if (res.code !== 0) {
        return { ok: false, text: res.stdout, error: `codex exited ${res.code}: ${res.stderr.trim()}`, meta };
      }
      const parsed = parseCodexOutput(res.stdout);
      return { ok: parsed.ok, text: parsed.text, ...(parsed.error ? { error: parsed.error } : {}), meta };
    },
    async diagnose(): Promise<ProviderDiagnostic> {
      const res = await exec(binary, ["--version"], { timeoutMs: 15_000 });
      const available = !res.spawnError && !res.timedOut && res.code === 0;
      return {
        id: "codex-cli",
        available,
        authenticated: "unknown",
        authSource: "standalone codex CLI login or API env var",
        binary,
        detail: available
          ? `codex responded: ${res.stdout.trim().split("\n")[0] ?? "ok"}`
          : `codex unavailable: ${res.spawnError ?? (res.stderr.trim() || `exit ${res.code}`)}`,
      };
    },
  };
}
