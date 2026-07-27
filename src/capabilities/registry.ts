/**
 * The capability registry and its truthful diagnostics.
 *
 * `CAPABILITIES` is the single source of truth for the eight parity areas. Each
 * descriptor names its provider-neutral contract, the permission actions it must
 * hold before acting, and the acceptance gates that must pass before it may ever
 * be reported `verified`. `diagnoseCapabilities` reports the real state: with no
 * backing it says `unavailable`, and it structurally refuses to echo an
 * unproven `verified` claim.
 */

import type {
  CapabilityDescriptor,
  CapabilityDiagnostic,
  CapabilityProbe,
  CapabilityProbeResult,
} from "./types.js";

export { CAPABILITY_STATUSES } from "./types.js";
export type {
  CapabilityDescriptor,
  CapabilityDiagnostic,
  CapabilityProbe,
  CapabilityProbeResult,
  CapabilityStatus,
} from "./types.js";

export const CAPABILITIES: readonly CapabilityDescriptor[] = [
  {
    id: "semantic-video-understanding",
    title: "Direct semantic video understanding",
    summary:
      "Read source footage directly and return time-ranged semantic segments (what happens, salience, tags) so the planner sees meaning, not just FFprobe metadata.",
    contract: "VideoUnderstandingProvider",
    requiresPermissions: ["network"],
    acceptanceGateIds: ["gate:semantic-video-understanding:segments"],
  },
  {
    id: "transcription-analysis",
    title: "Automatic transcription and editorial analysis",
    summary:
      "Produce word-level timing with diarization, and mark filler words, dead silence, off-camera crew prompts, and repeated takes for editorial cutting.",
    contract: "TranscriptionProvider",
    requiresPermissions: ["network"],
    acceptanceGateIds: [
      "gate:transcription-analysis:word-timing",
      "gate:transcription-analysis:diarization",
      "gate:transcription-analysis:filler-silence-take",
    ],
  },
  {
    id: "draft-critique-revision",
    title: "Rendered-draft multimodal critique and bounded revision",
    summary:
      "Critique the actually-rendered master (not just the plan) with frame-anchored notes, then propose a bounded revision plan that the engine re-validates and re-renders.",
    contract: "DraftCritiqueProvider",
    requiresPermissions: ["network", "media-upload"],
    acceptanceGateIds: [
      "gate:draft-critique-revision:frame-notes",
      "gate:draft-critique-revision:bounded-rounds",
    ],
  },
  {
    id: "asset-discovery",
    title: "Rights-safe local, Drive, and web asset discovery",
    summary:
      "Find candidate assets across local disk, Google Drive, and the web, returning only licensed references with explicit license and attribution data. Never returns unlicensed bytes.",
    contract: "AssetDiscoveryProvider",
    requiresPermissions: ["network"],
    acceptanceGateIds: [
      "gate:asset-discovery:local",
      "gate:asset-discovery:rights-metadata",
    ],
  },
  {
    id: "hook-variant-production",
    title: "Complete hook-variant production",
    summary:
      "Generate the full requested set of distinct hook variants, each expressed as a renderer-ready plan fragment, not just prose suggestions.",
    contract: "HookVariantProducer",
    requiresPermissions: ["network"],
    acceptanceGateIds: ["gate:hook-variant-production:full-set"],
  },
  {
    id: "hermes-integration",
    title: "Optional Hermes integration via official surfaces",
    summary:
      "Optionally connect to Hermes only through official MCP, API, or plugin surfaces, never a private credential store, while standalone offline operation stays fully intact.",
    contract: "HermesIntegration",
    requiresPermissions: ["network"],
    acceptanceGateIds: [
      "gate:hermes-integration:official-surface",
      "gate:hermes-integration:standalone-preserved",
    ],
  },
  {
    id: "improvement-proposals",
    title: "Reviewed improvement proposals with approval and rollback",
    summary:
      "Draft code, skill, or prompt improvements as reviewed proposals that carry tests and a rollback plan, applied only after explicit approval. Never silent self-modification.",
    contract: "ImprovementProposalProvider",
    requiresPermissions: ["code-change"],
    acceptanceGateIds: [
      "gate:improvement-proposals:approval-required",
      "gate:improvement-proposals:rollback",
    ],
  },
  {
    id: "review-publishing",
    title: "Human review and publishing",
    summary:
      "Support human review with frame comments, approvals, version comparison, review queues, versioned storage, publishing adapters, and role-based access control.",
    contract: "ReviewPublishingProvider",
    requiresPermissions: ["publishing", "media-upload"],
    acceptanceGateIds: [
      "gate:review-publishing:frame-comments",
      "gate:review-publishing:approvals-rbac",
      "gate:review-publishing:version-compare",
      "gate:review-publishing:publish-adapter",
    ],
  },
] as const;

export const CAPABILITY_IDS = CAPABILITIES.map((c) => c.id) as readonly string[];

export function getCapability(id: string): CapabilityDescriptor {
  const c = CAPABILITIES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown capability '${id}'.`);
  return c;
}

export interface DiagnoseOptions {
  /** Per-capability probe overrides. Absent probes default to `unavailable`. */
  probes?: Record<string, CapabilityProbe>;
  /** Gate ids backed by executable pass evidence from the acceptance runner. */
  passedGateIds?: readonly string[];
}

/** The default probe: nothing is implemented, so every capability is unavailable. */
const UNAVAILABLE: CapabilityProbeResult = {
  status: "unavailable",
  detail: "Contract defined; no backing provider is implemented yet.",
};

/**
 * Diagnose every capability truthfully. A probe may report a real backing state,
 * but a `verified` claim survives only if it cites an acceptance gate that
 * actually belongs to this capability; otherwise it is downgraded to `configured`
 * and annotated, so the diagnostics can never overclaim.
 */
export async function diagnoseCapabilities(
  opts: DiagnoseOptions = {},
): Promise<CapabilityDiagnostic[]> {
  const out: CapabilityDiagnostic[] = [];
  for (const cap of CAPABILITIES) {
    const probe = opts.probes?.[cap.id];
    let result: CapabilityProbeResult;
    try {
      result = probe ? await probe() : UNAVAILABLE;
    } catch (err) {
      result = {
        status: "unavailable",
        detail: `Probe error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let status = result.status;
    let detail = result.detail;
    if (status === "verified") {
      const cites = result.verifiedByGateId;
      const belongs = cites !== undefined && cap.acceptanceGateIds.includes(cites);
      if (!belongs) {
        status = "configured";
        detail = `Claimed verified but no acceptance gate for '${cap.id}' proves it; reporting configured. ${detail}`;
      } else if (!(opts.passedGateIds ?? []).includes(cites)) {
        status = "configured";
        detail = `Claimed verified but acceptance gate '${cites}' has not passed with executable evidence; reporting configured. ${detail}`;
      }
    }

    out.push({
      id: cap.id,
      title: cap.title,
      contract: cap.contract,
      status,
      detail,
      requiresPermissions: cap.requiresPermissions,
      acceptanceGateIds: cap.acceptanceGateIds,
      claimed: status !== "unavailable",
    });
  }
  return out;
}
