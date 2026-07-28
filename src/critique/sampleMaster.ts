/**
 * Deterministic FFmpeg sampling of an already-rendered master into a run/output
 * directory (parity phase 3).
 *
 * The master is resolved under an explicit output root with both a lexical and a
 * realpath containment check, so a symlink cannot make sampling read or write
 * outside the root. The master must be a regular file, and frames are always
 * written into a directory separate from the master, so the master can never be
 * overwritten. Before sampling, only files whose names exactly match the
 * generated frame pattern are removed; foreign files are never touched. Every
 * spawn uses an explicit argument array through the bounded, shell:false runner
 * with a hard timeout and a capped output buffer, and `-y` applies only to the
 * generated frame output, never to the master (which is an input).
 */

import { mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execProcess, type ExecFn } from "../agent/exec.js";
import { ffmpegBinary } from "../ffmpeg/spawn.js";
import { assertContainedPath } from "../util/paths.js";

/** The exact name FFmpeg writes generated frames to (`printf` template). */
export const CRITIQUE_FRAME_PATTERN = "critique_frame_%05d.jpg";
/** Matches exactly the names {@link CRITIQUE_FRAME_PATTERN} produces. */
export const CRITIQUE_FRAME_RE = /^critique_frame_\d{5}\.jpg$/i;

const DEFAULT_INTERVAL_SECONDS = 2;
const DEFAULT_MAX_FRAMES = 24;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** One sampled frame of the rendered master: its on-disk file and source time. */
export interface SampledMasterFrame {
  absPath: string;
  atSeconds: number;
}

/** Build the FFmpeg argument array to sample the master at a fixed interval. */
export function buildMasterSampleArgs(masterPath: string, frameDir: string, intervalSeconds: number): string[] {
  const fps = 1 / intervalSeconds;
  return [
    "-nostdin",
    "-hide_banner",
    "-i",
    masterPath,
    "-vf",
    `fps=${fps}`,
    "-q:v",
    "2",
    // -y only overwrites the generated frame output below; the master is -i input.
    "-y",
    join(frameDir, CRITIQUE_FRAME_PATTERN),
  ];
}

export interface SampleMasterInput {
  /** Path to the already-rendered master (relative to cwd or absolute). */
  masterPath: string;
  /** Explicit output root the master and frames must both stay under. */
  outputRoot: string;
  /** Where frames are written. Defaults to `<masterDir>/critique-frames`. */
  frameDir?: string;
  intervalSeconds?: number;
  maxFrames?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;

  // Injectable steps (real defaults below).
  runner?: ExecFn;
  realpathPath?: (p: string) => string;
  statFile?: (p: string) => { isFile: boolean };
  listFrames?: (dir: string) => string[];
  removeFile?: (p: string) => void;
  ensureDir?: (dir: string) => void;
}

export interface SampleMasterResult {
  /** Canonical absolute path of the master that was sampled. */
  masterPath: string;
  /** Canonical absolute frame directory the generated frames live in. */
  frameDir: string;
  frames: SampledMasterFrame[];
}

function defaultStat(p: string): { isFile: boolean } {
  return { isFile: statSync(p).isFile() };
}

/** Even, endpoint-preserving subset so a long master respects the provider cap. */
function selectEvenly(frames: SampledMasterFrame[], maxFrames: number): SampledMasterFrame[] {
  if (frames.length <= maxFrames) return frames;
  if (maxFrames === 1) return [frames[0]!];
  const out: SampledMasterFrame[] = [];
  for (let i = 0; i < maxFrames; i++) {
    out.push(frames[Math.round((i * (frames.length - 1)) / (maxFrames - 1))]!);
  }
  return out;
}

/**
 * Sample a rendered master into a contained run directory and return each
 * produced frame paired with its source time. Throws on any containment breach,
 * a non-regular-file master, a shared master/frame directory, or a spawn,
 * timeout, truncation, or nonzero-exit failure. Nothing outside the frame
 * directory is ever written or removed.
 */
export async function sampleRenderedMaster(input: SampleMasterInput): Promise<SampleMasterResult> {
  const interval = input.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const maxFrames = input.maxFrames ?? DEFAULT_MAX_FRAMES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const runner = input.runner ?? execProcess;
  const realpath = input.realpathPath ?? realpathSync;
  const stat = input.statFile ?? defaultStat;
  const list = input.listFrames ?? ((d: string) => readdirSync(d));
  const remove = input.removeFile ?? ((p: string) => rmSync(p, { force: true }));
  const ensureDir = input.ensureDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));

  if (!Number.isFinite(interval) || interval <= 0) throw new Error("intervalSeconds must be a positive number.");

  // --- Containment: master under the output root, lexically and by real path. ---
  const root = resolve(input.outputRoot);
  const realRoot = realpath(root);
  const masterAbs = isAbsolute(input.masterPath) ? resolve(input.masterPath) : resolve(process.cwd(), input.masterPath);
  assertContainedPath(masterAbs, root, "master");
  const realMaster = realpath(masterAbs);
  assertContainedPath(realMaster, realRoot, "real master");
  if (!stat(realMaster).isFile) throw new Error(`Master must be a regular file: ${JSON.stringify(input.masterPath)}`);

  // --- Frame directory: contained, and always separate from the master. ---
  const frameDirAbs = input.frameDir
    ? isAbsolute(input.frameDir)
      ? resolve(input.frameDir)
      : resolve(process.cwd(), input.frameDir)
    : join(dirname(realMaster), "critique-frames");
  assertContainedPath(frameDirAbs, root, "frame directory");
  ensureDir(frameDirAbs);
  const realFrameDir = realpath(frameDirAbs);
  assertContainedPath(realFrameDir, realRoot, "real frame directory");
  if (realFrameDir === dirname(realMaster)) {
    throw new Error("The frame directory must be separate from the master so the master is never overwritten.");
  }

  // --- Clean only exact generated frame names, never foreign files. ---
  for (const name of list(realFrameDir)) {
    if (CRITIQUE_FRAME_RE.test(name)) remove(join(realFrameDir, name));
  }

  // --- Sample through the bounded, shell:false runner. ---
  const args = buildMasterSampleArgs(realMaster, realFrameDir, interval);
  const res = await runner(ffmpegBinary(), args, { timeoutMs, maxBuffer });
  if (res.spawnError) throw new Error(`Could not start FFmpeg to sample the master: ${res.spawnError}`);
  if (res.timedOut) throw new Error(`Master frame sampling timed out after ${timeoutMs}ms.`);
  if (res.truncated) throw new Error(`Master frame sampling output exceeded the ${maxBuffer}-byte limit and was rejected.`);
  if (res.code !== 0) throw new Error(`Master frame sampling failed (ffmpeg exit ${res.code}): ${res.stderr.trim().slice(0, 400)}`);

  // --- Collect only generated frames, in order, paired with interval times. ---
  const produced = list(realFrameDir)
    .filter((f) => CRITIQUE_FRAME_RE.test(f))
    .sort();
  if (produced.length === 0) {
    throw new Error(`No sampled frames were produced under ${realFrameDir}.`);
  }
  const frames: SampledMasterFrame[] = produced.map((name, i) => ({
    absPath: join(realFrameDir, basename(name)),
    atSeconds: Math.round(i * interval * 1000) / 1000,
  }));

  return { masterPath: realMaster, frameDir: realFrameDir, frames: selectEvenly(frames, maxFrames) };
}
