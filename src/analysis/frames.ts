/**
 * Sampled-frame extraction and local OpenCV frame metrics.
 *
 * FFmpeg samples frames at a fixed interval into the run/output directory (never
 * beside the source), and the checked-in Python bridge (`python/frame_metrics.py`)
 * measures each frame with OpenCV: blur, brightness, face boxes, and visual
 * discontinuity from the previous frame. Both boundaries use an explicit argument
 * array with no shell, and both runners are injectable so the argument builders,
 * the manifest writer, and the output parsing are unit-tested fully offline.
 *
 * This is visual measurement, not semantic understanding. A face box is a Haar
 * cascade detection, and "discontinuity" is a histogram delta, nothing more.
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { execProcess, type ExecFn } from "../agent/exec.js";
import { runFfmpeg, type RunResult } from "../ffmpeg/spawn.js";
import { frameMetricSchema, type FrameMetricValue } from "./schemas.js";

/** Absolute path to the checked-in OpenCV frame-metrics bridge. */
export function frameMetricsScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "python", "frame_metrics.py");
}

export interface SampledFrame {
  /** Absolute path to the extracted frame image. */
  path: string;
  atSeconds: number;
}

const DEFAULT_INTERVAL_SECONDS = 2;

/** Build the FFmpeg argument array to sample frames at a fixed interval into outDir. */
export function buildFrameExtractArgs(videoPath: string, outDir: string, intervalSeconds: number): string[] {
  const fps = 1 / intervalSeconds;
  return [
    "-i",
    videoPath,
    "-vf",
    `fps=${fps}`,
    "-q:v",
    "2",
    "-y",
    join(outDir, "frame_%05d.jpg"),
  ];
}

export interface ExtractFramesInput {
  videoPath: string;
  outDir: string;
  intervalSeconds?: number;
  /** Number of frames actually produced, discovered by the caller (fs listing). */
  frameFiles: string[];
  runner?: (args: readonly string[]) => Promise<RunResult>;
}

/**
 * Extract sampled frames with FFmpeg, then pair each produced file with its source
 * timestamp. The caller supplies the sorted list of produced files (kept out of
 * this module so the fs listing stays injectable); frame k maps to k * interval.
 */
export async function extractSampledFrames(input: ExtractFramesInput): Promise<SampledFrame[]> {
  const interval = input.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const runner = input.runner ?? runFfmpeg;
  const res = await runner(buildFrameExtractArgs(input.videoPath, input.outDir, interval));
  if (res.code !== 0) {
    throw new Error(`Frame extraction failed: ${res.stderr.trim().slice(0, 400)}`);
  }
  return input.frameFiles.map((path, i) => ({ path, atSeconds: Math.round(i * interval * 1000) / 1000 }));
}

/** Build the argument array for the Python metrics bridge. */
export function buildFrameMetricsArgs(scriptPath: string, manifestPath: string): string[] {
  return [scriptPath, "--manifest", manifestPath];
}

/** Validate the bridge's stdout into frame metrics. Throws on malformed output. */
export function parseFrameMetrics(stdout: string): FrameMetricValue[] {
  let parsed: { frames?: unknown[] };
  try {
    parsed = JSON.parse(stdout) as { frames?: unknown[] };
  } catch (err) {
    throw new Error(`Frame-metrics bridge did not return JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const frames = parsed.frames ?? [];
  return frames.map((f, i) => {
    const r = frameMetricSchema.safeParse(f);
    if (!r.success) {
      throw new Error(`Frame ${i} failed validation: ${r.error.issues.map((x) => x.message).join("; ")}`);
    }
    return r.data;
  });
}

export interface ComputeFrameMetricsInput {
  frames: SampledFrame[];
  /** Where the frame manifest JSON is written for the bridge to read. */
  manifestPath: string;
  pythonExe?: string;
  scriptPath?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  runner?: ExecFn;
  /** Injected file writer for offline tests. Defaults to fs writeFileSync. */
  writeFile?: (path: string, data: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/** Write the frame manifest, run the OpenCV bridge, and return validated metrics. */
export async function computeFrameMetrics(input: ComputeFrameMetricsInput): Promise<FrameMetricValue[]> {
  const pythonExe = input.pythonExe ?? process.env.OVE_PYTHON?.trim() ?? "python";
  const script = input.scriptPath ?? frameMetricsScriptPath();
  const runner = input.runner ?? execProcess;
  const write = input.writeFile ?? ((p: string, d: string) => writeFileSync(p, d, "utf8"));

  write(input.manifestPath, JSON.stringify(input.frames.map((f) => ({ path: f.path, atSeconds: f.atSeconds }))));

  const res = await runner(pythonExe, buildFrameMetricsArgs(script, input.manifestPath), {
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: input.maxBuffer ?? DEFAULT_MAX_BUFFER,
  });

  if (res.spawnError) throw new Error(`Could not start frame-metrics bridge ('${pythonExe}'): ${res.spawnError}`);
  if (res.timedOut) throw new Error(`Frame metrics timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`);
  if (res.truncated) throw new Error(`Frame-metrics output exceeded the buffer limit and was rejected.`);
  if (res.code !== 0) throw new Error(`Frame-metrics bridge exited ${res.code}: ${res.stderr.trim().slice(0, 400)}`);

  return parseFrameMetrics(res.stdout);
}
