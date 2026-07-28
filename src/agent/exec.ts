import { spawn } from "node:child_process";

/**
 * Bounded, non-shell process runner for CLI providers.
 *
 * Every provider call goes through this: an explicit argument array, shell:false
 * so no string is ever interpolated into a command line, a hard timeout, and a
 * capped output buffer so a runaway process can neither hang the agent nor
 * exhaust memory. The prompt is delivered on stdin, never on the command line.
 * This module reads no credentials and no auth files of any kind.
 */

export interface ExecOptions {
  /** Text written to the child's stdin, then closed. */
  input?: string;
  /** Kill the child after this many milliseconds. */
  timeoutMs?: number;
  /** Cap on combined stdout+stderr characters retained. */
  maxBuffer?: number;
  /** Extra environment. Merged over process.env unless replaceEnv is true. */
  env?: NodeJS.ProcessEnv;
  /** Child working directory. Use this to narrow provider filesystem scope. */
  cwd?: string;
  /** Use exactly `env` instead of inheriting process.env. Default false. */
  replaceEnv?: boolean;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Present when the process could not be spawned at all (e.g. ENOENT). */
  spawnError?: string;
  /** True when output was clamped at maxBuffer. */
  truncated?: boolean;
}

export type ExecFn = (
  binary: string,
  args: readonly string[],
  opts?: ExecOptions,
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export const execProcess: ExecFn = (binary, args, opts = {}) => {
  if (!Array.isArray(args)) {
    throw new TypeError("args must be an array; string commands are not allowed");
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise<ExecResult>((resolvePromise) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      shell: false,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: opts.replaceEnv ? (opts.env ?? {}) : opts.env ? { ...process.env, ...opts.env } : process.env,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const cap = (existing: string, chunk: string): string => {
      if (existing.length >= maxBuffer) {
        truncated = true;
        return existing;
      }
      const room = maxBuffer - existing.length;
      if (chunk.length > room) {
        truncated = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        return existing + chunk.slice(0, room);
      }
      return existing + chunk;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout = cap(stdout, d.toString())));
    child.stderr.on("data", (d) => (stderr = cap(stderr, d.toString())));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr, timedOut, spawnError: err.message, truncated });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: code ?? null, stdout, stderr, timedOut, truncated });
    });

    if (opts.input !== undefined) {
      child.stdin.on("error", () => {
        /* ignore EPIPE if the child exits before reading stdin */
      });
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
};
