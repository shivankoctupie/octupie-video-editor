/**
 * Capability model for the full-parity layer.
 *
 * A capability is a provider-neutral promise the engine intends to keep, defined
 * by a TypeScript contract (see `contracts.ts`) and gated by an executable
 * acceptance manifest (see `../../ACCEPTANCE_MANIFEST.json`). The registry can
 * report a capability's real status without ever claiming an unimplemented
 * feature. Three states, no lying:
 *
 *   - `unavailable` the contract exists but has no working backing here.
 *   - `configured`  a backing provider or config is present but unproven.
 *   - `verified`    an acceptance gate for this capability has actually passed.
 *
 * `verified` is only reachable through gate evidence; a probe cannot self-assert
 * it (the registry downgrades an unproven claim). This is the anti-overclaim rule.
 */

import type { PermissionAction } from "../permissions/policy.js";

export const CAPABILITY_STATUSES = ["unavailable", "configured", "verified"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** A stable, portable description of one parity capability. */
export interface CapabilityDescriptor {
  id: string;
  /** Short human title. */
  title: string;
  /** One-paragraph description of the intended, provider-neutral behavior. */
  summary: string;
  /** Name of the TypeScript contract interface in `contracts.ts`. */
  contract: string;
  /** Permission actions this capability must hold grants for before it can act. */
  requiresPermissions: PermissionAction[];
  /** Acceptance-manifest gate ids that must pass before this capability is `verified`. */
  acceptanceGateIds: string[];
}

/** What a probe returns. A probe reports the real backing state; it does not implement the capability. */
export interface CapabilityProbeResult {
  status: CapabilityStatus;
  detail: string;
  /**
   * Required to legitimately claim `verified`: the acceptance-gate id that
   * actually passed. Must belong to this capability, or the claim is downgraded.
   */
  verifiedByGateId?: string;
}

export type CapabilityProbe = () => Promise<CapabilityProbeResult>;

/** The truthful, diagnosed status of one capability. */
export interface CapabilityDiagnostic {
  id: string;
  title: string;
  contract: string;
  status: CapabilityStatus;
  detail: string;
  requiresPermissions: PermissionAction[];
  acceptanceGateIds: string[];
  /** True only when the capability is `configured` or `verified`; false for `unavailable`. */
  claimed: boolean;
}
