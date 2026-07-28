/**
 * Local pyannote.audio speaker-diarization adapter (parity phase 2B, scope B).
 *
 * This is the deterministic-engine side of the checked-in Python bridge
 * (`python/diarize_pyannote.py`). It never builds a command line: the bridge is
 * invoked through the bounded, shell:false process runner with an explicit
 * argument array, a hard timeout, and a capped output buffer. It is prompt-free;
 * no prompt flag is ever emitted.
 *
 * Diarization is OPTIONAL. When pyannote.audio is not installed, or the model is
 * not cached and a download was not explicitly allowed, this adapter reports
 * `available: false` and never throws, so transcription and the rest of the
 * pipeline keep working. It supports either a local model path (fully offline,
 * no token) or the standard pyannote model with an operator-supplied `HF_TOKEN`.
 * The token is passed to the child process environment only; it is never placed
 * on the argument array, never read from a file here, and never printed.
 *
 * The bridge's stdout JSON is untrusted until it passes {@link speakerTurnSchema}.
 * Validated turns are aligned to already-validated word timings by maximum
 * temporal overlap.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { execProcess, type ExecFn } from "../agent/exec.js";
import type { WordValue } from "./schemas.js";

/** Absolute path to the checked-in pyannote diarization bridge. */
export function diarizeScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "python", "diarize_pyannote.py");
}

/** The default named model. A local path may be used instead for fully offline runs. */
export const DEFAULT_DIARIZE_MODEL = "pyannote/speaker-diarization-3.1";

/** Exit code the bridge returns when pyannote.audio cannot be imported. */
const IMPORT_UNAVAILABLE_EXIT = 3;
/** Exit code the bridge returns when the model could not be loaded (e.g. not cached). */
const MODEL_UNAVAILABLE_EXIT = 4;

export interface DiarizeConfig {
  pythonExe: string;
  model: string;
  device: string;
  allowModelDownload: boolean;
  timeoutMs: number;
  maxBuffer: number;
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000; // Diarization on CPU can be slow.
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/** Resolve config from explicit overrides then environment, with safe defaults. */
export function resolveDiarizeConfig(overrides: Partial<DiarizeConfig> = {}): DiarizeConfig {
  return {
    pythonExe: overrides.pythonExe ?? process.env.OVE_PYTHON?.trim() ?? "python",
    model: overrides.model ?? process.env.OVE_DIARIZE_MODEL?.trim() ?? DEFAULT_DIARIZE_MODEL,
    device: overrides.device ?? process.env.OVE_DIARIZE_DEVICE?.trim() ?? "cpu",
    allowModelDownload: overrides.allowModelDownload ?? false,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: overrides.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };
}

/**
 * Build the argument array passed to the Python executable. Never contains a
 * prompt and NEVER contains a token; the token travels only in the child's
 * environment. The first element is the bridge script path.
 */
export function buildDiarizeArgs(scriptPath: string, audioPath: string, cfg: DiarizeConfig): string[] {
  const args = [scriptPath, "--audio", audioPath, "--model", cfg.model, "--device", cfg.device];
  if (cfg.allowModelDownload) args.push("--allow-model-download");
  return args;
}

export const speakerTurnSchema = z
  .object({
    speaker: z.string().min(1),
    start: z.number().finite().min(0, "turn start must not be negative"),
    end: z.number().finite(),
  })
  .strict()
  .refine((t) => t.end >= t.start, { message: "turn end must be >= start", path: ["end"] });

const bridgeOutputSchema = z
  .object({
    model: z.string().optional(),
    turns: z.array(speakerTurnSchema),
  })
  .strict();

/** A validated speaker turn in engine-standard `Seconds` naming. */
export interface SpeakerTurn {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
}

export interface DiarizationResult {
  /** False when pyannote is absent or the model is unavailable; the pipeline continues regardless. */
  available: boolean;
  turns: SpeakerTurn[];
  /** Distinct speaker labels found, in first-seen order. */
  speakers: string[];
  /** Human-readable status, safe to log (never contains a token). */
  detail: string;
}

const UNAVAILABLE = (detail: string): DiarizationResult => ({ available: false, turns: [], speakers: [], detail });

/** Parse and validate the bridge stdout into speaker turns. Throws on malformed output. */
export function parseSpeakerTurns(stdout: string): SpeakerTurn[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Diarization bridge did not return JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = bridgeOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Diarization output failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data.turns.map((t) => ({ speaker: t.speaker, startSeconds: t.start, endSeconds: t.end }));
}

/** Distinct speaker labels in first-seen order. */
function distinctSpeakers(turns: SpeakerTurn[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of turns) {
    if (!seen.has(t.speaker)) {
      seen.add(t.speaker);
      out.push(t.speaker);
    }
  }
  return out;
}

export interface DiarizeInput {
  /** Absolute path to the local mono WAV the bridge reads. */
  audioPath: string;
  config?: Partial<DiarizeConfig>;
  /** Injected process runner for offline tests. Defaults to the bounded runner. */
  runner?: ExecFn;
  /** Script path override (tests). */
  scriptPath?: string;
  /**
   * Operator-supplied Hugging Face token for the named model. Passed to the
   * child environment only, never the argv, never logged. Defaults to
   * `process.env.HF_TOKEN`.
   */
  hfToken?: string;
}

/**
 * Run the local diarization bridge. Returns validated speaker turns, or an
 * `available: false` result when pyannote or the model is absent. Never throws
 * on an absence, so transcription is never broken; a genuinely malformed but
 * present result is reported unavailable with a safe detail rather than trusted.
 */
export async function diarize(input: DiarizeInput): Promise<DiarizationResult> {
  const cfg = resolveDiarizeConfig(input.config ?? {});
  const script = input.scriptPath ?? diarizeScriptPath();
  const runner = input.runner ?? execProcess;
  const args = buildDiarizeArgs(script, input.audioPath, cfg);

  // The token travels only in the environment, and only when present.
  const token = input.hfToken ?? process.env.HF_TOKEN;
  const env = token ? { HF_TOKEN: token } : undefined;

  const res = await runner(cfg.pythonExe, args, {
    timeoutMs: cfg.timeoutMs,
    maxBuffer: cfg.maxBuffer,
    ...(env ? { env } : {}),
  });

  if (res.spawnError) {
    return UNAVAILABLE(`Diarization unavailable: could not start Python ('${cfg.pythonExe}'): ${res.spawnError}`);
  }
  if (res.timedOut) {
    return UNAVAILABLE(`Diarization unavailable: timed out after ${cfg.timeoutMs}ms.`);
  }
  if (res.truncated) {
    return UNAVAILABLE(`Diarization unavailable: output exceeded the ${cfg.maxBuffer}-byte limit.`);
  }
  if (res.code === IMPORT_UNAVAILABLE_EXIT) {
    return UNAVAILABLE("Diarization unavailable: pyannote.audio is not installed.");
  }
  if (res.code === MODEL_UNAVAILABLE_EXIT) {
    return UNAVAILABLE(
      "Diarization unavailable: model not cached. Provide a local model path, or pass an explicit download allowance and HF_TOKEN.",
    );
  }
  if (res.code !== 0) {
    return UNAVAILABLE(`Diarization unavailable: bridge exited ${res.code}.`);
  }

  try {
    const turns = parseSpeakerTurns(res.stdout);
    return { available: true, turns, speakers: distinctSpeakers(turns), detail: `Diarization produced ${turns.length} turn(s).` };
  } catch (err) {
    return UNAVAILABLE(`Diarization unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Overlap in seconds between a word and a turn (0 when disjoint). */
function overlapSeconds(word: WordValue, turn: SpeakerTurn): number {
  const start = Math.max(word.startSeconds, turn.startSeconds);
  const end = Math.min(word.endSeconds, turn.endSeconds);
  return Math.max(0, end - start);
}

/**
 * Assign each word the speaker of the turn it overlaps most. A word with no
 * overlapping turn keeps its existing speaker (usually none). On a tie, the
 * earlier turn wins, for deterministic output.
 */
export function alignWordsToTurns(words: readonly WordValue[], turns: readonly SpeakerTurn[]): WordValue[] {
  return words.map((w) => {
    let best: SpeakerTurn | undefined;
    let bestOverlap = 0;
    for (const t of turns) {
      const ov = overlapSeconds(w, t);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = t;
      }
    }
    if (best && bestOverlap > 0) {
      return { ...w, speaker: best.speaker };
    }
    return { ...w };
  });
}
