/**
 * Standalone (offline) orchestration for parity phase 6.
 *
 * Hermes is optional. This module produces a deterministic, DATA-ONLY
 * orchestration result with NO network access and NO dependency on Hermes, so the
 * engine's plan-to-master pipeline is never coupled to an external agent. It is
 * the default: when Hermes is absent or not opted into, the engine still returns
 * useful, bounded guidance and defers every real action to a human.
 *
 * Two shapes are offered:
 *   - `standaloneOrchestrate`: a deterministic offline result derived only from
 *     the structured request.
 *   - `skippedOrchestration`: an explicit "skipped" marker when the caller chose
 *     not to orchestrate at all.
 *
 * Neither calls the network. Both validate against the same DATA-ONLY response
 * schema the official adapter uses, so downstream code sees one contract.
 */

import {
  parseHermesOrchestrationRequest,
  parseHermesOrchestrationResponse,
  type HermesOrchestrationRequestValue,
  type HermesOrchestrationResponseValue,
} from "./schemas.js";

export interface StandaloneOrchestrationResult {
  mode: "standalone";
  standalonePreserved: true;
  usedNetwork: false;
  data: HermesOrchestrationResponseValue;
  producedAt: string;
}

export interface SkippedOrchestrationResult {
  mode: "skipped";
  standalonePreserved: true;
  usedNetwork: false;
  reason: string;
  producedAt: string;
}

export interface StandaloneOrchestrateArgs {
  /** The structured request; re-validated here. */
  request: unknown;
  now?: Date;
}

/**
 * Deterministic offline orchestration. Derives a bounded, data-only result from
 * the request alone. It always requires human approval and never claims to have
 * acted. No network is touched.
 */
export function standaloneOrchestrate(args: StandaloneOrchestrateArgs): StandaloneOrchestrationResult {
  const parsed = parseHermesOrchestrationRequest(args.request);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`Invalid orchestration request: ${parsed.errors.join("; ")}`);
  }
  const request: HermesOrchestrationRequestValue = parsed.data;
  const now = args.now ?? new Date();

  const summary =
    `Standalone offline guidance for stage '${request.workflowStage}': ${request.objective}. ` +
    `No external agent was consulted; the deterministic engine remains the source of truth.`;

  const data: HermesOrchestrationResponseValue = {
    summary,
    recommendedNextStep: `Advance the deterministic pipeline for stage '${request.workflowStage}' and have a human review the result.`,
    orderedActions: [
      `Validate the current edit plan for stage '${request.workflowStage}'.`,
      "Render or re-render the master with the deterministic pipeline.",
      "Run QA on the rendered master.",
      "Route the result to a human for review before any publish.",
    ],
    warnings: ["Generated offline without Hermes; treat all guidance as advisory data only."],
    requiresHumanApproval: true,
  };

  // Round-trip through the shared schema so offline and official paths agree.
  const check = parseHermesOrchestrationResponse(data);
  if (!check.ok || !check.data) {
    throw new Error(`Standalone result failed validation: ${check.errors.join("; ")}`);
  }

  return {
    mode: "standalone",
    standalonePreserved: true,
    usedNetwork: false,
    data: check.data,
    producedAt: now.toISOString(),
  };
}

/** An explicit, network-free "skipped" result. */
export function skippedOrchestration(reason: string, now: Date = new Date()): SkippedOrchestrationResult {
  return {
    mode: "skipped",
    standalonePreserved: true,
    usedNetwork: false,
    reason: reason.trim().length > 0 ? reason.trim() : "orchestration skipped",
    producedAt: now.toISOString(),
  };
}
