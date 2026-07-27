/**
 * Permission and approval contract for the full-parity layer.
 *
 * The engine is default-deny for every operation that reaches beyond the local,
 * offline, plan-to-master boundary. Four operation classes are gated:
 *
 *   - `network`      any outbound network call (model APIs, web/Drive discovery)
 *   - `media-upload` sending media bytes to a remote service
 *   - `publishing`   pushing a rendered draft to an external destination
 *   - `code-change`  modifying the engine's own source, skills, or prompts
 *
 * Nothing in these classes runs without a matching, unexpired, explicit grant.
 * A grant is data an operator supplies; the engine never mints one for itself,
 * and a model reply can never become a grant. This keeps standalone offline
 * behavior the default and makes every boundary-crossing an audited decision.
 */

export const PERMISSION_ACTIONS = [
  "network",
  "media-upload",
  "publishing",
  "code-change",
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export function isPermissionAction(value: string): value is PermissionAction {
  return (PERMISSION_ACTIONS as readonly string[]).includes(value);
}

/** An explicit operator grant for one action. */
export interface PermissionGrant {
  action: PermissionAction;
  /** Who authorized it (operator id, ticket, or "operator"). Recorded, not trusted for auth. */
  grantedBy: string;
  /** ISO-8601 timestamp the grant was made. */
  grantedAt: string;
  /** Optional ISO-8601 expiry. A grant at or after this instant is treated as absent. */
  expiresAt?: string;
  /** Optional human reason, surfaced in audit logs. */
  reason?: string;
}

export interface PermissionPolicy {
  readonly grants: readonly PermissionGrant[];
}

export interface PermissionDecision {
  action: PermissionAction;
  allowed: boolean;
  /** Human-readable explanation, always populated. */
  reason: string;
}

/** Thrown by {@link requireGrant} at an enforcement point when an action is denied. */
export class PermissionDeniedError extends Error {
  readonly action: PermissionAction;
  constructor(decision: PermissionDecision) {
    super(`Permission denied for '${decision.action}': ${decision.reason}`);
    this.name = "PermissionDeniedError";
    this.action = decision.action;
  }
}

/**
 * Build a policy from a list of grants. Rejects grants for unknown actions so a
 * typo or a hostile config can never silently widen access.
 */
export function createPolicy(grants: readonly PermissionGrant[]): PermissionPolicy {
  for (const g of grants) {
    if (!isPermissionAction(g.action)) {
      throw new Error(`Unknown permission action in grant: '${g.action}'`);
    }
  }
  return { grants: [...grants] };
}

function isExpired(grant: PermissionGrant, at: Date): boolean {
  if (grant.expiresAt === undefined) return false;
  const exp = Date.parse(grant.expiresAt);
  if (Number.isNaN(exp)) return true; // an unparseable expiry is treated as expired, never as valid.
  return at.getTime() >= exp;
}

/**
 * Decide whether an action is allowed under a policy. Default deny: allowed only
 * when a matching, unexpired grant exists. `at` defaults to now for expiry checks.
 */
export function evaluatePermission(
  action: PermissionAction,
  policy: PermissionPolicy,
  at: Date = new Date(),
): PermissionDecision {
  const matching = policy.grants.filter((g) => g.action === action);
  if (matching.length === 0) {
    return { action, allowed: false, reason: `Denied: no explicit grant for '${action}'.` };
  }
  const live = matching.filter((g) => !isExpired(g, at));
  if (live.length === 0) {
    return { action, allowed: false, reason: `Denied: grant for '${action}' has expired.` };
  }
  const by = live[0]!.grantedBy;
  return { action, allowed: true, reason: `Allowed: explicit grant by ${by}.` };
}

/** Enforcement point. Throws {@link PermissionDeniedError} unless the action is granted. */
export function requireGrant(
  action: PermissionAction,
  policy: PermissionPolicy,
  at: Date = new Date(),
): PermissionDecision {
  const decision = evaluatePermission(action, policy, at);
  if (!decision.allowed) throw new PermissionDeniedError(decision);
  return decision;
}
