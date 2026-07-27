/**
 * Local source-analysis orchestrator (parity phase 2A).
 *
 * Ties the pieces together into one validated artifact, fully on-device:
 *   1. resolve the input clip through the real asset-root containment + is-file
 *      guard, so nothing outside the configured root is ever opened;
 *   2. extract a small mono 16 kHz WAV into the run/output directory (never beside
 *      the source media);
 *   3. transcribe it with the local faster-whisper bridge;
 *   4. measure silence and audio facts with FFmpeg;
 *   5. run the deterministic editorial pass (fillers, crew prompts, repeated
 *      takes, candidate hooks);
 *   6. optionally sample frames and measure them with the OpenCV bridge;
 *   7. assemble a {@link SourceAnalysisValue}, validate it, and write the analysis
 *      JSON plus transcript JSON, SRT, and VTT under the output directory.
 *
 * Every heavy step is injectable so the whole flow is exercised offline; the real
 * defaults spawn only through the bounded, shell:false runners.
 */

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolveExistingAssetPath } from "../util/assetRoot.js";
import { sha256String } from "../util/hash.js";
import { probe as ffprobe } from "../ffmpeg/ffprobe.js";
import { runFfmpeg, type RunResult } from "../ffmpeg/spawn.js";
import { transcribeWithWhisper, type WhisperConfig } from "./whisper.js";
import { detectSilence, type SilenceOptions } from "./silence.js";
import { extractSampledFrames, computeFrameMetrics } from "./frames.js";
import { analyzeEditorial } from "./editorial.js";
import { toSrt, toVtt } from "./srt.js";
import {
  parseSourceAnalysis,
  SOURCE_ANALYSIS_FORMAT,
  type AssetRefValue,
  type TranscriptValue,
  type AudioFactsValue,
  type FrameMetricValue,
  type SourceAnalysisValue,
} from "./schemas.js";

const ANALYSIS_NOTES = [
  "Marks (filler, silence, crew-prompt) are explicit lexical and acoustic heuristics, not semantic certainty.",
  "Repeated-take groups are token-similarity guesses; a human still selects the take to keep.",
  "Candidate hooks are heuristic scores over timed words, not a claim of editorial quality.",
  "Speaker diarization is not implemented; speaker labels are empty unless a real diarizing provider supplies them.",
];

/** Build the FFmpeg args to extract a mono 16 kHz WAV for transcription/analysis. */
export function buildAudioExtractArgs(videoPath: string, outWav: string): string[] {
  return ["-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", outWav];
}

/** Default output directory for a clip's analysis, under the ignored output tree. */
export function defaultAnalysisOutDir(clipRelPath: string): string {
  const short = sha256String(clipRelPath).slice(0, 8);
  const name = basename(clipRelPath).replace(/[^a-zA-Z0-9._-]/g, "_");
  return resolve(process.cwd(), "output", "analysis", `${name}-${short}`);
}

export interface AnalyzeSourceInput {
  clipRelPath: string;
  outDir: string;
  model?: string;
  language?: string;
  /** Explicitly allow Faster Whisper to download a missing named model. Default false. */
  allowModelDownload?: boolean;
  /** Sample and measure frames with OpenCV. Off by default (expensive). */
  includeFrames?: boolean;
  frameIntervalSeconds?: number;
  silenceOptions?: SilenceOptions;
  whisperConfig?: Partial<WhisperConfig>;
  now?: Date;

  // Injectable steps (real defaults below). Present so the whole flow runs offline.
  resolveClipPath?: (rel: string) => string;
  probeDuration?: (absPath: string) => Promise<number>;
  extractAudio?: (absPath: string, outWav: string) => Promise<void>;
  transcribe?: (args: {
    clip: AssetRefValue;
    mediaPath: string;
    durationSeconds: number;
    config?: Partial<WhisperConfig>;
  }) => Promise<TranscriptValue>;
  detectSilenceFn?: (args: { audioPath: string; durationSeconds: number; options?: SilenceOptions }) => Promise<AudioFactsValue>;
  analyzeFrames?: (absPath: string, outDir: string) => Promise<FrameMetricValue[]>;
  ensureDir?: (dir: string) => void;
  writeFile?: (path: string, data: string) => void;
}

export interface AnalyzeSourceResult {
  analysisPath: string;
  transcriptPath: string;
  srtPath: string;
  vttPath: string;
  analysis: SourceAnalysisValue;
}

function defaultResolveClip(rel: string): string {
  return resolveExistingAssetPath(rel, `source clip '${rel}'`);
}

async function defaultProbeDuration(absPath: string): Promise<number> {
  const p = await ffprobe(absPath);
  const dur = Number(p.format.duration);
  if (!Number.isFinite(dur) || dur <= 0) throw new Error(`Could not determine duration of ${absPath}`);
  return dur;
}

async function defaultExtractAudio(absPath: string, outWav: string): Promise<void> {
  const res: RunResult = await runFfmpeg(buildAudioExtractArgs(absPath, outWav));
  if (res.code !== 0) throw new Error(`Audio extraction failed: ${res.stderr.trim().slice(0, 400)}`);
}

async function defaultAnalyzeFrames(
  absPath: string,
  outDir: string,
  intervalSeconds: number,
): Promise<FrameMetricValue[]> {
  const framesDir = join(outDir, "frames");
  mkdirSync(framesDir, { recursive: true });
  for (const file of readdirSync(framesDir)) {
    if (/^frame_\d{5}\.jpg$/i.test(file)) unlinkSync(join(framesDir, file));
  }
  const runRes = await runFfmpeg([
    "-i",
    absPath,
    "-vf",
    `fps=${1 / intervalSeconds}`,
    "-q:v",
    "2",
    "-y",
    join(framesDir, "frame_%05d.jpg"),
  ]);
  if (runRes.code !== 0) throw new Error(`Frame extraction failed: ${runRes.stderr.trim().slice(0, 400)}`);
  const files = readdirSync(framesDir)
    .filter((f) => /^frame_\d{5}\.jpg$/i.test(f))
    .sort()
    .map((f) => join(framesDir, f));
  const frames = files.map((path, i) => ({ path, atSeconds: Math.round(i * intervalSeconds * 1000) / 1000 }));
  if (frames.length === 0) return [];
  return computeFrameMetrics({ frames, manifestPath: join(outDir, "frame-manifest.json") });
}

/** Run the full local source analysis and write validated artifacts. */
export async function analyzeSource(input: AnalyzeSourceInput): Promise<AnalyzeSourceResult> {
  const now = input.now ?? new Date();
  const resolveClip = input.resolveClipPath ?? defaultResolveClip;
  const probeDuration = input.probeDuration ?? defaultProbeDuration;
  const extractAudio = input.extractAudio ?? defaultExtractAudio;
  const transcribe = input.transcribe ?? ((a) => transcribeWithWhisper(a));
  const detectSilenceFn = input.detectSilenceFn ?? ((a) => detectSilence(a));
  const ensureDir = input.ensureDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const writeFile = input.writeFile ?? ((p: string, d: string) => writeFileSync(p, d, "utf8"));
  const frameInterval = input.frameIntervalSeconds ?? 2;
  const analyzeFrames =
    input.analyzeFrames ?? ((abs: string, dir: string) => defaultAnalyzeFrames(abs, dir, frameInterval));

  // 1. Containment guard: throws on any escape or non-file.
  const absClip = resolveClip(input.clipRelPath);
  const clipRef: AssetRefValue = { path: input.clipRelPath };

  // 2. All outputs and temporaries live under the output directory.
  ensureDir(input.outDir);
  const audioPath = join(input.outDir, "audio.wav");

  const durationSeconds = await probeDuration(absClip);
  await extractAudio(absClip, audioPath);

  const transcript = await transcribe({
    clip: clipRef,
    mediaPath: audioPath,
    durationSeconds,
    config: {
      ...(input.model ? { model: input.model } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.allowModelDownload ? { allowModelDownload: true } : {}),
      ...input.whisperConfig,
    },
  });

  const audio = await detectSilenceFn({
    audioPath,
    durationSeconds,
    ...(input.silenceOptions ? { options: input.silenceOptions } : {}),
  });

  const editorial = analyzeEditorial(transcript, audio);

  let frames: FrameMetricValue[] | undefined;
  if (input.includeFrames) {
    frames = await analyzeFrames(absClip, input.outDir);
  }

  const analysisCandidate = {
    format: SOURCE_ANALYSIS_FORMAT,
    clip: clipRef,
    durationSeconds,
    generatedAt: now.toISOString(),
    transcription: {
      provider: "faster-whisper",
      model: input.model ?? input.whisperConfig?.model ?? process.env.OVE_WHISPER_MODEL?.trim() ?? "base.en",
      language: transcript.language,
    },
    transcript,
    marks: editorial.marks,
    takes: editorial.takes,
    candidateHooks: editorial.candidateHooks,
    audio,
    ...(frames ? { frames } : {}),
    notes: ANALYSIS_NOTES,
  };

  const parsed = parseSourceAnalysis(analysisCandidate);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`Assembled source analysis failed validation: ${parsed.errors.join("; ")}`);
  }

  const analysisPath = join(input.outDir, "analysis.json");
  const transcriptPath = join(input.outDir, "transcript.json");
  const srtPath = join(input.outDir, "captions.srt");
  const vttPath = join(input.outDir, "captions.vtt");

  writeFile(analysisPath, JSON.stringify(parsed.data, null, 2) + "\n");
  writeFile(transcriptPath, JSON.stringify(transcript, null, 2) + "\n");
  writeFile(srtPath, toSrt(transcript.segments));
  writeFile(vttPath, toVtt(transcript.segments));

  return { analysisPath, transcriptPath, srtPath, vttPath, analysis: parsed.data };
}
