/**
 * Real, honest capability probes for parity phase 2A.
 *
 * A probe reports the true backing state of a capability; it never implements it
 * and never asserts `verified` on its own (the registry downgrades any `verified`
 * claim that no passed acceptance gate proves, and no gate passes from unit tests
 * alone). Phase 2A backs exactly one capability locally: transcription-analysis,
 * via the faster-whisper bridge. When `faster_whisper` imports, the probe reports
 * `configured` (present but unproven end-to-end). Everything else, including
 * semantic-video-understanding, stays `unavailable` until a true provider exists.
 */

import { execProcess, type ExecFn } from "../agent/exec.js";
import { claudeBinary } from "../agent/providers/claude.js";
import type { CapabilityProbe } from "./types.js";

const PY_IMPORT_TIMEOUT_MS = 30_000;
const CLAUDE_VERSION_TIMEOUT_MS = 15_000;

/**
 * Probe for automatic transcription and editorial analysis. `configured` when the
 * local faster-whisper library imports; `unavailable` otherwise. Never `verified`:
 * the word-timing, diarization, and filler/silence/take gates require real
 * end-to-end evidence that unit tests do not provide.
 */
export function transcriptionAnalysisProbe(pythonExe: string, runner: ExecFn = execProcess): CapabilityProbe {
  return async () => {
    try {
      const res = await runner(
        pythonExe,
        ["-c", "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('faster_whisper') else 1)"],
        { timeoutMs: PY_IMPORT_TIMEOUT_MS },
      );
      if (res.spawnError) {
        return { status: "unavailable", detail: `Python not runnable ('${pythonExe}'): ${res.spawnError}` };
      }
      if (res.code === 0) {
        return {
          status: "configured",
          detail:
            "faster_whisper importable via the local bridge; word-timing/diarization/filler gates not yet passed with executable evidence.",
        };
      }
      return { status: "unavailable", detail: `faster_whisper not importable (python exit ${res.code}).` };
    } catch (err) {
      return { status: "unavailable", detail: `Transcription probe error: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}

/**
 * Offline-default probe for direct semantic video understanding: always
 * `unavailable`. Used when no restricted vision provider is configured. Kept as
 * the honest fallback so a machine with no `claude` binary reports the truth.
 */
export function semanticVideoUnderstandingProbe(): CapabilityProbe {
  return async () => ({
    status: "unavailable",
    detail: "No multimodal video-understanding provider is configured; semantic segments are not produced locally.",
  });
}

/**
 * Real probe for direct semantic video understanding. The only backing is the
 * restricted Claude Code vision adapter, which needs the standalone `claude`
 * binary. `configured` when `claude` responds to `--version`; `unavailable`
 * otherwise. Never `verified`: the semantic-segments gate needs real-media
 * evidence that a unit test does not provide (the registry downgrades any
 * unproven `verified` claim regardless).
 */
export function semanticVisionProbe(claudeBin: string, runner: ExecFn = execProcess): CapabilityProbe {
  return async () => {
    try {
      const res = await runner(claudeBin, ["--version"], { timeoutMs: CLAUDE_VERSION_TIMEOUT_MS });
      if (res.spawnError) {
        return { status: "unavailable", detail: `Restricted vision provider unavailable: '${claudeBin}' not runnable (${res.spawnError}).` };
      }
      if (res.code === 0) {
        return {
          status: "configured",
          detail:
            "Restricted Claude Code vision provider is available; semantic-segments gate not yet passed with real-media evidence.",
        };
      }
      return { status: "unavailable", detail: `Restricted vision provider unavailable ('${claudeBin}' exit ${res.code}).` };
    } catch (err) {
      return { status: "unavailable", detail: `Semantic vision probe error: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}

/**
 * Probe for optional speaker diarization (a sub-gate of transcription-analysis).
 * `configured` when the local `pyannote.audio` library imports; `unavailable`
 * otherwise. Reported as capability detail; it never flips a gate green, which
 * requires a real two-speaker acceptance clip.
 */
export function diarizationProbe(pythonExe: string, runner: ExecFn = execProcess): CapabilityProbe {
  return async () => {
    try {
      const res = await runner(
        pythonExe,
        [
          "-c",
          "import importlib.util,sys; p=importlib.util.find_spec('pyannote'); sys.exit(0 if p and importlib.util.find_spec('pyannote.audio') else 1)",
        ],
        { timeoutMs: PY_IMPORT_TIMEOUT_MS },
      );
      if (res.spawnError) {
        return { status: "unavailable", detail: `Python not runnable ('${pythonExe}'): ${res.spawnError}` };
      }
      if (res.code === 0) {
        return {
          status: "configured",
          detail: "pyannote.audio importable via the local bridge; the two-speaker diarization gate is not yet passed with real-media evidence.",
        };
      }
      return { status: "unavailable", detail: `pyannote.audio not importable (python exit ${res.code}).` };
    } catch (err) {
      return { status: "unavailable", detail: `Diarization probe error: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}

export interface CapabilityProbeDeps {
  pythonExe?: string;
  runner?: ExecFn;
  /** Binary for the restricted vision provider. Defaults to the configured `claude`. */
  claudeBin?: string;
}

/** Build the real per-capability probes keyed by capability id. */
export function buildCapabilityProbes(deps: CapabilityProbeDeps = {}): Record<string, CapabilityProbe> {
  const pythonExe = deps.pythonExe ?? process.env.OVE_PYTHON?.trim() ?? "python";
  const runner = deps.runner ?? execProcess;
  const claudeBin = deps.claudeBin ?? claudeBinary();
  return {
    "transcription-analysis": transcriptionAnalysisProbe(pythonExe, runner),
    "semantic-video-understanding": semanticVisionProbe(claudeBin, runner),
  };
}
