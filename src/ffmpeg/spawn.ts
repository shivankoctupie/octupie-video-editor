import { spawn } from "node:child_process";

/**
 * Deterministic FFmpeg/FFprobe process wrappers.
 *
 * Every call uses an explicit argument array and spawn without a shell, so no
 * user string is ever interpolated into a command line. Binaries are resolved
 * from environment overrides or PATH.
 */

export function ffmpegBinary(): string {
  return process.env.OVE_FFMPEG_PATH?.trim() || "ffmpeg";
}

export function ffprobeBinary(): string {
  return process.env.OVE_FFPROBE_PATH?.trim() || "ffprobe";
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(binary: string, args: readonly string[]): Promise<RunResult> {
  if (!Array.isArray(args)) {
    throw new TypeError("args must be an array; string commands are not allowed");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export function runFfmpeg(args: readonly string[]): Promise<RunResult> {
  return run(ffmpegBinary(), ["-nostdin", "-hide_banner", ...args]);
}

export function runFfprobe(args: readonly string[]): Promise<RunResult> {
  return run(ffprobeBinary(), ["-hide_banner", ...args]);
}

/** True when the binary responds to -version. Used by `doctor`. */
export async function binaryAvailable(binary: string): Promise<boolean> {
  try {
    const res = await run(binary, ["-version"]);
    return res.code === 0;
  } catch {
    return false;
  }
}
