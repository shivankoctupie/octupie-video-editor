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

import { statSync } from "node:fs";
import { resolve } from "node:path";
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
 * Real probe for rendered-draft critique and bounded revision. The only backing
 * is the restricted Claude Code critique adapter, which needs the standalone
 * `claude` binary. `configured` when `claude` responds to `--version`;
 * `unavailable` otherwise. Never `verified`: the frame-notes and bounded-rounds
 * gates need real end-to-end evidence that a unit test does not provide (the
 * registry downgrades any unproven `verified` claim regardless).
 */
export function draftCritiqueRevisionProbe(claudeBin: string, runner: ExecFn = execProcess): CapabilityProbe {
  return async () => {
    try {
      const res = await runner(claudeBin, ["--version"], { timeoutMs: CLAUDE_VERSION_TIMEOUT_MS });
      if (res.spawnError) {
        return { status: "unavailable", detail: `Draft-critique provider unavailable: '${claudeBin}' not runnable (${res.spawnError}).` };
      }
      if (res.code === 0) {
        return {
          status: "configured",
          detail:
            "Restricted Claude Code critique provider is available; the frame-notes and bounded-rounds gates are not yet passed with real-media evidence.",
        };
      }
      return { status: "unavailable", detail: `Draft-critique provider unavailable ('${claudeBin}' exit ${res.code}).` };
    } catch (err) {
      return { status: "unavailable", detail: `Draft-critique probe error: ${err instanceof Error ? err.message : String(err)}` };
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

/**
 * Real probe for rights-safe asset discovery. Reports `configured` when a real
 * local provider is usable (the asset root exists as a directory) OR an
 * explicitly configured remote adapter (Drive or web) is present; `unavailable`
 * otherwise. Never `verified`: the `local` and `rights-metadata` gates need
 * executable end-to-end evidence that a unit test does not provide (the registry
 * downgrades any unproven `verified` claim regardless).
 */
export function assetDiscoveryProbe(
  assetRootDir: string,
  opts: { driveConfigured?: boolean; webConfigured?: boolean; dirExists?: (p: string) => boolean } = {},
): CapabilityProbe {
  const dirExists =
    opts.dirExists ??
    ((p: string) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  return async () => {
    const localUsable = dirExists(resolve(assetRootDir));
    const remoteConfigured = opts.driveConfigured === true || opts.webConfigured === true;
    if (localUsable || remoteConfigured) {
      const parts: string[] = [];
      if (localUsable) parts.push(`local asset root '${assetRootDir}' is present`);
      if (opts.driveConfigured) parts.push("a Drive adapter is configured");
      if (opts.webConfigured) parts.push("a web adapter is configured");
      return {
        status: "configured",
        detail: `${parts.join("; ")}; the local and rights-metadata gates are not yet passed with executable evidence.`,
      };
    }
    return {
      status: "unavailable",
      detail: `No usable local asset root at '${assetRootDir}' and no configured remote adapter.`,
    };
  };
}

/**
 * Probe for complete hook-variant production. The deterministic offline producer
 * is always present, so this reports `configured` (a backing exists but the
 * full-set gate has not passed with executable evidence). It never reports
 * `verified`: only a passed acceptance gate can, and the registry downgrades any
 * unproven claim regardless. The optional restricted Claude text provider is
 * reported diagnostically only; its absence never changes the status, because the
 * deterministic producer stands alone offline.
 */
export function hookVariantProductionProbe(claudeBin: string, runner: ExecFn = execProcess): CapabilityProbe {
  return async () => {
    let claudeNote = "the optional Claude text provider was not checked";
    try {
      const res = await runner(claudeBin, ["--version"], { timeoutMs: CLAUDE_VERSION_TIMEOUT_MS });
      if (res.spawnError) claudeNote = `the optional Claude text provider is unavailable ('${claudeBin}' not runnable)`;
      else if (res.code === 0) claudeNote = "an optional restricted Claude text provider is also available";
      else claudeNote = `the optional Claude text provider is unavailable ('${claudeBin}' exit ${res.code})`;
    } catch (err) {
      claudeNote = `the optional Claude text provider check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return {
      status: "configured",
      detail: `Deterministic offline hook-variant producer is present; ${claudeNote}. The full-set gate is not yet passed with executable evidence.`,
    };
  };
}

/**
 * Probe for reviewed improvement proposals. The deterministic apply/rollback
 * engine is always present, so this reports `configured` (a real backing exists
 * but the approval-required and rollback gates have not passed with executable
 * evidence). It never reports `verified`; only a passed acceptance gate can, and
 * the registry downgrades any unproven claim regardless. It reads no files and
 * never proposes or applies anything.
 */
export function improvementProposalsProbe(): CapabilityProbe {
  return async () => ({
    status: "configured",
    detail:
      "Deterministic improvement apply/rollback engine is present; applying requires an explicit human approval decision plus a code-change grant. The approval-required and rollback gates are not yet passed with executable evidence.",
  });
}

/**
 * Offline probe for optional Hermes integration. It NEVER hits the network: it
 * reports based only on whether an endpoint and a token are configured. Without
 * both it is `unavailable` (standalone offline default in effect). With both it
 * is `configured` (present but unproven). It never reports `verified`; only a
 * passed acceptance gate can, and the registry downgrades any unproven claim
 * regardless. No private Hermes config or credential store is ever read.
 */
export function hermesIntegrationProbe(opts: { endpoint?: string; tokenPresent?: boolean } = {}): CapabilityProbe {
  return async () => {
    const endpoint = opts.endpoint?.trim();
    const hasEndpoint = endpoint !== undefined && endpoint.length > 0;
    const hasToken = opts.tokenPresent === true;
    if (hasEndpoint && hasToken) {
      return {
        status: "configured",
        detail:
          `A Hermes API endpoint and token are configured; the official-surface and standalone-preserved ` +
          `gates are not yet passed with executable evidence. Standalone offline operation remains the default.`,
      };
    }
    return {
      status: "unavailable",
      detail:
        "No Hermes endpoint and/or token configured; standalone offline operation is the default and Hermes is not consulted.",
    };
  };
}

export interface CapabilityProbeDeps {
  pythonExe?: string;
  runner?: ExecFn;
  /** Binary for the restricted vision provider. Defaults to the configured `claude`. */
  claudeBin?: string;
  /** Absolute asset root for the local discovery probe. Defaults to `OVE_ASSET_ROOT` or `assets`. */
  assetRootDir?: string;
  /** Whether an explicit Drive adapter is configured (for the discovery probe). */
  driveConfigured?: boolean;
  /** Whether an explicit web adapter is configured (for the discovery probe). */
  webConfigured?: boolean;
  /** Optional Hermes endpoint for the integration probe. Defaults to `OCTUPIE_HERMES_ENDPOINT`. */
  hermesEndpoint?: string;
  /** Whether the Hermes token env is present. Defaults to `OCTUPIE_HERMES_API_KEY` being set. */
  hermesTokenPresent?: boolean;
}

/** Build the real per-capability probes keyed by capability id. */
export function buildCapabilityProbes(deps: CapabilityProbeDeps = {}): Record<string, CapabilityProbe> {
  const pythonExe = deps.pythonExe ?? process.env.OVE_PYTHON?.trim() ?? "python";
  const runner = deps.runner ?? execProcess;
  const claudeBin = deps.claudeBin ?? claudeBinary();
  const assetRootDir = deps.assetRootDir ?? process.env.OVE_ASSET_ROOT?.trim() ?? "assets";
  const hermesEndpoint = deps.hermesEndpoint ?? process.env.OCTUPIE_HERMES_ENDPOINT?.trim();
  const hermesTokenPresent =
    deps.hermesTokenPresent ?? (process.env.OCTUPIE_HERMES_API_KEY?.trim() ?? "").length > 0;
  return {
    "transcription-analysis": transcriptionAnalysisProbe(pythonExe, runner),
    "semantic-video-understanding": semanticVisionProbe(claudeBin, runner),
    "draft-critique-revision": draftCritiqueRevisionProbe(claudeBin, runner),
    "asset-discovery": assetDiscoveryProbe(assetRootDir, {
      ...(deps.driveConfigured !== undefined ? { driveConfigured: deps.driveConfigured } : {}),
      ...(deps.webConfigured !== undefined ? { webConfigured: deps.webConfigured } : {}),
    }),
    "hook-variant-production": hookVariantProductionProbe(claudeBin, runner),
    "improvement-proposals": improvementProposalsProbe(),
    "hermes-integration": hermesIntegrationProbe({
      ...(hermesEndpoint !== undefined ? { endpoint: hermesEndpoint } : {}),
      tokenPresent: hermesTokenPresent,
    }),
  };
}
