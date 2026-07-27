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
import type { CapabilityProbe } from "./types.js";

const PY_IMPORT_TIMEOUT_MS = 30_000;

/**
 * Probe for automatic transcription and editorial analysis. `configured` when the
 * local faster-whisper library imports; `unavailable` otherwise. Never `verified`:
 * the word-timing, diarization, and filler/silence/take gates require real
 * end-to-end evidence that unit tests do not provide.
 */
export function transcriptionAnalysisProbe(pythonExe: string, runner: ExecFn = execProcess): CapabilityProbe {
  return async () => {
    try {
      const res = await runner(pythonExe, ["-c", "import faster_whisper"], { timeoutMs: PY_IMPORT_TIMEOUT_MS });
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
 * Probe for direct semantic video understanding. Always `unavailable`: there is no
 * local multimodal provider, and none is claimed. Diarization and semantic
 * understanding are explicitly not implemented in phase 2A.
 */
export function semanticVideoUnderstandingProbe(): CapabilityProbe {
  return async () => ({
    status: "unavailable",
    detail: "No multimodal video-understanding provider is configured; semantic segments are not produced locally.",
  });
}

export interface CapabilityProbeDeps {
  pythonExe?: string;
  runner?: ExecFn;
}

/** Build the real per-capability probes keyed by capability id. */
export function buildCapabilityProbes(deps: CapabilityProbeDeps = {}): Record<string, CapabilityProbe> {
  const pythonExe = deps.pythonExe ?? process.env.OVE_PYTHON?.trim() ?? "python";
  const runner = deps.runner ?? execProcess;
  return {
    "transcription-analysis": transcriptionAnalysisProbe(pythonExe, runner),
    "semantic-video-understanding": semanticVideoUnderstandingProbe(),
  };
}
