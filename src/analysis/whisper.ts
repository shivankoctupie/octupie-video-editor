/**
 * Local faster-whisper transcription adapter.
 *
 * This is the deterministic-engine side of the checked-in Python bridge
 * (`python/transcribe_faster_whisper.py`). It never builds a command line: the
 * bridge is invoked through the bounded, shell:false process runner with an
 * explicit argument array, a hard timeout, and a capped output buffer. The
 * Python executable, the model, and the language are configurable; the prompt is
 * not, and no prompt flag is ever emitted, so the transcription cannot be steered
 * by injected text. Named models are cached or local-only by default. A caller
 * must explicitly allow a missing named model to be downloaded.
 *
 * The bridge's stdout JSON is untrusted until it passes {@link transcriptSchema}:
 * timings must be monotonic and lie within the clip duration probed by FFprobe,
 * which is authoritative here.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execProcess, type ExecFn } from "../agent/exec.js";
import type { AssetRefValue, TranscriptValue } from "./schemas.js";
import { parseTranscript } from "./schemas.js";

/** Absolute path to the checked-in Python transcription bridge. */
export function whisperScriptPath(): string {
  // src/analysis/ -> repo root is two levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "python", "transcribe_faster_whisper.py");
}

export interface WhisperConfig {
  pythonExe: string;
  model: string;
  language?: string;
  device: string;
  computeType: string;
  beamSize: number;
  allowModelDownload: boolean;
  timeoutMs: number;
  maxBuffer: number;
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000; // Whole-clip local transcription can be slow on CPU.
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/** Resolve config from explicit overrides then environment, with safe defaults. */
export function resolveWhisperConfig(overrides: Partial<WhisperConfig> = {}): WhisperConfig {
  return {
    pythonExe: overrides.pythonExe ?? process.env.OVE_PYTHON?.trim() ?? "python",
    model: overrides.model ?? process.env.OVE_WHISPER_MODEL?.trim() ?? "base.en",
    ...(overrides.language !== undefined
      ? { language: overrides.language }
      : process.env.OVE_WHISPER_LANGUAGE?.trim()
        ? { language: process.env.OVE_WHISPER_LANGUAGE.trim() }
        : {}),
    device: overrides.device ?? process.env.OVE_WHISPER_DEVICE?.trim() ?? "cpu",
    computeType: overrides.computeType ?? process.env.OVE_WHISPER_COMPUTE?.trim() ?? "int8",
    beamSize: overrides.beamSize ?? 5,
    allowModelDownload: overrides.allowModelDownload ?? false,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: overrides.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };
}

/**
 * Build the argument array passed to the Python executable. Never contains a
 * prompt of any kind; the first element is the bridge script path.
 */
export function buildWhisperArgs(scriptPath: string, audioPath: string, cfg: WhisperConfig): string[] {
  const args = [scriptPath, "--audio", audioPath, "--model", cfg.model];
  if (cfg.language) args.push("--language", cfg.language);
  if (cfg.allowModelDownload) args.push("--allow-model-download");
  args.push("--device", cfg.device, "--compute-type", cfg.computeType, "--beam-size", String(cfg.beamSize));
  return args;
}

interface BridgeWord {
  text: string;
  start: number;
  end: number;
  probability?: number;
}

interface BridgeOutput {
  language?: string;
  duration?: number;
  words?: BridgeWord[];
  segments?: Array<{ id: string; start: number; end: number; text: string; words?: BridgeWord[] }>;
}

export interface TranscribeInput {
  /** Portable relative reference recorded on the transcript. */
  clip: AssetRefValue;
  /** Absolute path to the on-disk audio/video the bridge reads. */
  mediaPath: string;
  /** Authoritative clip duration from FFprobe; words are validated against it. */
  durationSeconds: number;
  config?: Partial<WhisperConfig>;
  /** Injected process runner for offline tests. Defaults to the bounded runner. */
  runner?: ExecFn;
  /** Script path override (tests). */
  scriptPath?: string;
}

function mapWord(w: BridgeWord) {
  return {
    text: w.text,
    startSeconds: w.start,
    endSeconds: w.end,
    ...(w.probability !== undefined ? { confidence: w.probability } : {}),
  };
}

/** Run the local bridge and return a schema-validated transcript. Throws on any failure. */
export async function transcribeWithWhisper(input: TranscribeInput): Promise<TranscriptValue> {
  const cfg = resolveWhisperConfig(input.config ?? {});
  const script = input.scriptPath ?? whisperScriptPath();
  const runner = input.runner ?? execProcess;
  const args = buildWhisperArgs(script, input.mediaPath, cfg);

  const res = await runner(cfg.pythonExe, args, { timeoutMs: cfg.timeoutMs, maxBuffer: cfg.maxBuffer });

  if (res.spawnError) {
    throw new Error(`Could not start Python transcription bridge ('${cfg.pythonExe}'): ${res.spawnError}`);
  }
  if (res.timedOut) {
    throw new Error(`Transcription timed out after ${cfg.timeoutMs}ms; raise timeout or use a smaller model.`);
  }
  if (res.truncated) {
    throw new Error(`Transcription output exceeded the ${cfg.maxBuffer}-byte limit and was rejected.`);
  }
  if (res.code !== 0) {
    throw new Error(`Transcription bridge exited ${res.code}: ${res.stderr.trim().slice(0, 500)}`);
  }

  let bridge: BridgeOutput;
  try {
    bridge = JSON.parse(res.stdout) as BridgeOutput;
  } catch (err) {
    throw new Error(`Transcription bridge did not return JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const language = (input.config?.language ?? cfg.language ?? bridge.language ?? "unknown").toString();
  const words = (bridge.words ?? []).map(mapWord);
  const segments = (bridge.segments ?? []).map((s) => ({
    id: s.id,
    startSeconds: s.start,
    endSeconds: s.end,
    text: s.text,
    words: (s.words ?? []).map(mapWord),
  }));

  const candidate = {
    clip: input.clip,
    durationSeconds: input.durationSeconds,
    language,
    words,
    segments,
    speakers: [] as string[],
  };

  const parsed = parseTranscript(candidate);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`Transcription failed validation: ${parsed.errors.join("; ")}`);
  }
  return parsed.data;
}
