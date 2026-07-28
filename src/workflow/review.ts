/**
 * Human review flow (parity phase 8).
 *
 * Review never mutates an existing version. An editor submits a draft to review by
 * appending a NEW in-review version. An approver (or admin) decides an in-review
 * version by appending a NEW approved/rejected version; the in-review version stays
 * immutable. A decision must target an immutable in-review version, is signed only
 * by the `approver` or `admin` role, cannot be repeated (a second decision on the
 * same in-review version is refused), and can never render or publish; this module
 * has no dependency on the queue or the publishing layer, so an approval is inert
 * beyond recording the new version.
 */

import { requireAuthorized } from "./rbac.js";
import { appendVersionTransition, listVersions, loadVersion, type VersionStoreContext } from "./versions.js";
import {
  parseReviewDecision,
  type ReviewDecisionValue,
  type VersionRecordValue,
  type WorkflowRole,
} from "./schemas.js";

/** Thrown for a review gate failure (wrong state, duplicate decision, bad artifact). */
export class ReviewGateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReviewGateError";
    this.code = code;
  }
}

export interface SubmitForReviewInput {
  role: WorkflowRole;
  projectId: string;
  /** The draft version being submitted. Must be the current latest draft. */
  versionId: string;
  submittedBy: string;
}

/**
 * Submit a draft to review by appending a new in-review version. Requires the
 * `submit-review` action (editor or admin). The base must be an existing draft.
 */
export function submitForReview(ctx: VersionStoreContext, input: SubmitForReviewInput): VersionRecordValue {
  requireAuthorized(input.role, "submit-review");
  const base = loadVersion(ctx, input.projectId, input.versionId);
  if (base.status !== "draft") {
    throw new ReviewGateError("not-draft", `Version '${input.versionId}' is '${base.status}', not a draft; cannot submit for review.`);
  }
  return appendVersionTransition(ctx, {
    role: input.role,
    projectId: input.projectId,
    creator: input.submittedBy,
    planPath: base.planPath,
    ...(base.masterPath !== undefined ? { masterPath: base.masterPath } : {}),
    status: "in-review",
    parentVersionId: base.id,
  });
}

export interface DecideReviewInput {
  role: WorkflowRole;
  projectId: string;
  /** The signed decision artifact (validated here). Its `versionId` targets the in-review version. */
  decision: unknown;
}

/**
 * Decide an in-review version. Requires the `decide-review` action (approver or
 * admin), a valid decision artifact whose role is `approver`/`admin`, an immutable
 * in-review target, and no prior decision on that target. Appends a NEW
 * approved/rejected version; never mutates the in-review record and never publishes.
 */
export function decideReview(ctx: VersionStoreContext, input: DecideReviewInput): { decision: ReviewDecisionValue; version: VersionRecordValue } {
  requireAuthorized(input.role, "decide-review");

  const parsed = parseReviewDecision(input.decision);
  if (!parsed.ok || !parsed.data) {
    throw new ReviewGateError("invalid-decision", `Invalid review decision: ${parsed.errors.join("; ")}`);
  }
  const decision = parsed.data;

  // The signing role in the artifact must also be permitted to decide. The decision
  // schema already restricts `role` to approver|admin, but enforce consistency.
  if (!authorizedDecider(decision.role)) {
    throw new ReviewGateError("bad-role", `Decision role '${decision.role}' may not decide a review.`);
  }

  const target = loadVersion(ctx, input.projectId, decision.versionId);
  if (target.status !== "in-review") {
    throw new ReviewGateError(
      "not-in-review",
      `Version '${decision.versionId}' is '${target.status}', not in-review; cannot decide it.`,
    );
  }

  // Duplicate-decision guard: refuse if any version already descends from this
  // in-review target with an approved/rejected status.
  const existing = listVersions(ctx, input.projectId).find(
    (v) => v.parentVersionId === target.id && (v.status === "approved" || v.status === "rejected"),
  );
  if (existing) {
    throw new ReviewGateError("duplicate", `Version '${target.id}' already has a decision (version '${existing.id}').`);
  }

  const version = appendVersionTransition(ctx, {
    role: input.role,
    projectId: input.projectId,
    creator: decision.approver,
    planPath: target.planPath,
    ...(target.masterPath !== undefined ? { masterPath: target.masterPath } : {}),
    status: decision.approved ? "approved" : "rejected",
    parentVersionId: target.id,
  });
  return { decision, version };
}

function authorizedDecider(role: string): boolean {
  return role === "approver" || role === "admin";
}
