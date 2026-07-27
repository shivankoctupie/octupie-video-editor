/**
 * Deterministic silence and audio facts from FFmpeg.
 *
 * A single FFmpeg pass runs `silencedetect` (for dead-air regions) and
 * `volumedetect` (for mean/max level) over the extracted audio and writes to the
 * null muxer, so no file is produced. The stderr log is parsed into an auditable
 * {@link AudioFactsValue}: the exact silence regions, how much of the clip is
 * speech versus silence, and the thresholds used. These are acoustic measurements,
 * not editorial judgements; the editorial layer decides what to cut.
 *
 * Every call uses an argument array through the existing shell:false FFmpeg
 * runner. The runner is injectable so the parser and math are unit-tested offline.
 */

import { runFfmpeg, type RunResult } from "../ffmpeg/spawn.js";
import { audioFactsSchema, type AudioFactsValue } from "./schemas.js";

export interface SilenceRegion {
  startSeconds: number;
  endSeconds: number;
}

export interface SilenceLog {
  regions: SilenceRegion[];
  meanVolumeDb?: number;
  maxVolumeDb?: number;
}

const START_RE = /silence_start:\s*(-?\d+(?:\.\d+)?)/g;
const END_RE = /silence_end:\s*(-?\d+(?:\.\d+)?)/g;
const MEAN_RE = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/;
const MAX_RE = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/;

/**
 * Parse an FFmpeg silencedetect+volumedetect stderr log. A `silence_start` with
 * no matching `silence_end` is a run of silence to the end of the clip; the
 * caller closes it with the known duration.
 */
export function parseSilenceLog(stderr: string, durationSeconds: number): SilenceLog {
  const starts: number[] = [];
  const ends: number[] = [];
  let m: RegExpExecArray | null;
  START_RE.lastIndex = 0;
  END_RE.lastIndex = 0;
  while ((m = START_RE.exec(stderr)) !== null) starts.push(Number(m[1]));
  while ((m = END_RE.exec(stderr)) !== null) ends.push(Number(m[1]));

  const regions: SilenceRegion[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = Math.max(0, starts[i]!);
    const rawEnd = ends[i];
    const end = rawEnd === undefined ? durationSeconds : rawEnd;
    const clampedEnd = Math.min(Math.max(end, start), durationSeconds);
    if (clampedEnd > start) regions.push({ startSeconds: round3(start), endSeconds: round3(clampedEnd) });
  }

  const log: SilenceLog = { regions };
  const mean = MEAN_RE.exec(stderr);
  if (mean) log.meanVolumeDb = Number(mean[1]);
  const max = MAX_RE.exec(stderr);
  if (max) log.maxVolumeDb = Number(max[1]);
  return log;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface SilenceOptions {
  /** Noise floor in dBFS below which audio counts as silent. Default -30. */
  thresholdDb?: number;
  /** Minimum silent run to report, in seconds. Default 0.5. */
  minSilenceSeconds?: number;
}

const DEFAULT_THRESHOLD_DB = -30;
const DEFAULT_MIN_SILENCE = 0.5;

/** Build the single-pass FFmpeg argument array for silence + volume detection. */
export function buildSilenceDetectArgs(audioPath: string, thresholdDb: number, minSilenceSeconds: number): string[] {
  return [
    "-i",
    audioPath,
    "-af",
    `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSeconds},volumedetect`,
    "-f",
    "null",
    "-",
  ];
}

/** Turn a parsed silence log plus a known duration into validated audio facts. */
export function silenceLogToAudioFacts(
  log: SilenceLog,
  durationSeconds: number,
  thresholdDb: number,
  minSilenceSeconds: number,
): AudioFactsValue {
  const silenceSeconds = round3(log.regions.reduce((sum, r) => sum + (r.endSeconds - r.startSeconds), 0));
  const dur = Math.max(durationSeconds, 0);
  const bounded = Math.min(silenceSeconds, dur);
  const speechSeconds = round3(Math.max(0, dur - bounded));
  const speechRatio = dur > 0 ? round3(speechSeconds / dur) : 0;
  const facts = {
    durationSeconds: round3(dur),
    speechSeconds,
    silenceSeconds: round3(bounded),
    speechRatio,
    silenceThresholdDb: thresholdDb,
    minSilenceSeconds,
    silences: log.regions,
    ...(log.meanVolumeDb !== undefined ? { meanVolumeDb: log.meanVolumeDb } : {}),
    ...(log.maxVolumeDb !== undefined ? { maxVolumeDb: log.maxVolumeDb } : {}),
  };
  return audioFactsSchema.parse(facts);
}

export interface DetectSilenceInput {
  audioPath: string;
  durationSeconds: number;
  options?: SilenceOptions;
  /** Injected FFmpeg runner for offline tests. Defaults to the real runner. */
  runner?: (args: readonly string[]) => Promise<RunResult>;
}

/** Run FFmpeg silence/volume detection and return validated audio facts. */
export async function detectSilence(input: DetectSilenceInput): Promise<AudioFactsValue> {
  const thresholdDb = input.options?.thresholdDb ?? DEFAULT_THRESHOLD_DB;
  const minSilence = input.options?.minSilenceSeconds ?? DEFAULT_MIN_SILENCE;
  const runner = input.runner ?? runFfmpeg;
  const res = await runner(buildSilenceDetectArgs(input.audioPath, thresholdDb, minSilence));
  // silencedetect/volumedetect write to stderr and return 0 even with no audio;
  // a nonzero code means the decode itself failed.
  if (res.code !== 0) {
    throw new Error(`Silence detection failed: ${res.stderr.trim().slice(0, 400)}`);
  }
  const log = parseSilenceLog(res.stderr, input.durationSeconds);
  return silenceLogToAudioFacts(log, input.durationSeconds, thresholdDb, minSilence);
}
