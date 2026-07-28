/**
 * Deterministic rollback engine for applied improvement proposals (parity phase 7).
 *
 * Rollback is Gate 2: it restores the EXACT prior bytes of every file an applied
 * proposal touched. It requires ALL of:
 *
 *   1. a valid proposal and its embedded structured patch;
 *   2. a valid rollback-action decision whose `proposalId` matches and whose
 *      `approved` is true;
 *   3. an unexpired `code-change` PermissionPolicy grant, checked BEFORE any write;
 *   4. a prior applied audit record that passes its integrity check and whose
 *      patch hash matches this proposal;
 *   5. every current file being either already at its prior bytes (idempotent no-op)
 *      or exactly at the recorded applied hash. Any other content is treated as
 *      tampering and refused.
 *
 * It restores prior bytes atomically and verifies each restored file hashes back to
 * `beforeSha256`. No shell is ever invoked.
 */

import { dirname, join, resolve } from "node:path";
import { requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import { assertContainedPath } from "../util/paths.js";
import { sha256String } from "../util/hash.js";
import { checkPortableAllowedPath } from "./guard.js";
import {
  ImprovementGateError,
  auditIntegrityHash,
  auditRecordPath,
  loadAppliedAudit,
  requireDecision,
  validateProposalArtifact,
  defaultImprovementFs,
  AUDIT_FORMAT,
  type ImprovementFs,
} from "./apply.js";
import type { ReplaceOperationValue } from "./schemas.js";

export interface RollbackResult {
  proposalId: string;
  status: "rolled-back";
  /** True when the files were already at their prior bytes; no write was performed. */
  alreadyRolledBack: boolean;
  operations: { path: string; restoredSha256: string }[];
  auditPath?: string;
}

export interface RollbackProposalInput {
  proposal: unknown;
  decision: unknown;
  policy: PermissionPolicy;
  projectRoot?: string;
  stateRoot: string;
  now?: Date;
  fs?: ImprovementFs;
}

interface PreparedRollback {
  op: ReplaceOperationValue;
  canonicalPath: string;
  state: "before" | "applied" | "other";
  currentSha: string;
}

function resolveCanonical(op: ReplaceOperationValue, projectRoot: string, canonicalRoot: string, fs: ImprovementFs): string {
  const pathError = checkPortableAllowedPath(op.path);
  if (pathError) throw new ImprovementGateError("bad-path", `Operation path rejected: ${pathError}`);
  const absPath = resolve(projectRoot, op.path);
  assertContainedPath(absPath, projectRoot, "operation path");
  const st = fs.lstat(absPath);
  if (!st.exists) throw new ImprovementGateError("missing-file", `Target file does not exist: ${op.path}`);
  if (st.isSymlink) throw new ImprovementGateError("symlink", `Target is a symlink, which is refused: ${op.path}`);
  if (!st.isFile) throw new ImprovementGateError("not-regular", `Target is not a regular file: ${op.path}`);
  const realParent = fs.realpath(dirname(absPath));
  assertContainedPath(realParent, canonicalRoot, "canonical operation parent");
  const canonicalPath = join(realParent, op.path.split("/").pop()!);
  assertContainedPath(canonicalPath, canonicalRoot, "canonical operation path");
  return canonicalPath;
}

/** Restore an applied proposal to its exact prior bytes. Idempotent and tamper-safe. */
export async function rollbackProposal(input: RollbackProposalInput): Promise<RollbackResult> {
  const fs = input.fs ?? defaultImprovementFs;
  const now = input.now ?? new Date();
  const projectRoot = resolve(input.projectRoot ?? process.cwd());
  const stateRoot = resolve(input.stateRoot);

  const { value: proposal, patch } = validateProposalArtifact(input.proposal);
  requireDecision(input.decision, proposal.id, "rollback");

  // Gate: the code-change grant is checked BEFORE any filesystem write.
  requireGrant("code-change", input.policy, now);

  // A prior applied audit record must exist and pass its integrity check.
  const audit = loadAppliedAudit(stateRoot, proposal.id, fs);
  if (audit.patchSha256 !== sha256String(proposal.patch)) {
    throw new ImprovementGateError("patch-mismatch", `Proposal patch does not match the applied audit record for '${proposal.id}'.`);
  }
  const appliedByPath = new Map(audit.operations.map((o) => [o.path, o]));
  if (audit.operations.length !== patch.operations.length) {
    throw new ImprovementGateError("audit-mismatch", "Applied audit operation count does not match the proposal patch.");
  }
  for (const op of patch.operations) {
    const recorded = appliedByPath.get(op.path);
    if (!recorded) {
      throw new ImprovementGateError("audit-mismatch", `Applied audit record has no operation for path '${op.path}'.`);
    }
    if (recorded.beforeSha256 !== op.beforeSha256 || recorded.afterSha256 !== sha256String(op.afterText)) {
      throw new ImprovementGateError("audit-mismatch", `Applied audit hashes do not match the proposal for path '${op.path}'.`);
    }
  }

  const canonicalRoot = fs.realpath(projectRoot);
  const prepared: PreparedRollback[] = patch.operations.map((op) => {
    const canonicalPath = resolveCanonical(op, projectRoot, canonicalRoot, fs);
    const current = fs.readFileBytes(canonicalPath);
    const currentSha = sha256String(current);
    const applied = appliedByPath.get(op.path)!;
    let state: PreparedRollback["state"] = "other";
    if (currentSha === op.beforeSha256) state = "before";
    else if (currentSha === applied.afterSha256) state = "applied";
    return { op, canonicalPath, state, currentSha };
  });

  // Any file that is neither at its prior bytes nor at the recorded applied hash
  // has been changed out from under us. Refuse rather than clobber the change.
  const tampered = prepared.filter((p) => p.state === "other");
  if (tampered.length) {
    throw new ImprovementGateError(
      "changed-file",
      `Refusing rollback: file(s) changed since apply: ${tampered.map((p) => p.op.path).join(", ")}.`,
    );
  }

  // Idempotent: everything already at prior bytes means the rollback is a no-op.
  if (prepared.every((p) => p.state === "before")) {
    return {
      proposalId: proposal.id,
      status: "rolled-back",
      alreadyRolledBack: true,
      operations: prepared.map((p) => ({ path: p.op.path, restoredSha256: p.op.beforeSha256 })),
    };
  }

  // Restore exact prior bytes transactionally. Files already at their prior bytes
  // are left untouched. If any write, verification, or audit write fails, every
  // file changed by this rollback is returned to its recorded applied bytes.
  const toRestore = prepared.filter((p) => p.state === "applied");
  const restored: { path: string; restoredSha256: string }[] = [];
  const restoreAppliedState = (): string[] => {
    const errors: string[] = [];
    for (const p of toRestore) {
      try {
        fs.writeFile(p.canonicalPath, p.op.afterText);
      } catch (err) {
        errors.push(`${p.op.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return errors;
  };

  try {
    for (const p of toRestore) {
      fs.writeFile(p.canonicalPath, p.op.beforeText);
      const after = sha256String(fs.readFileBytes(p.canonicalPath));
      if (after !== p.op.beforeSha256) {
        throw new ImprovementGateError("restore-verify", `Restored bytes for '${p.op.path}' do not hash to the prior digest.`);
      }
    }
    for (const p of prepared) {
      restored.push({ path: p.op.path, restoredSha256: p.op.beforeSha256 });
    }

    const base = {
      format: AUDIT_FORMAT,
      kind: "rollback" as const,
      proposalId: proposal.id,
      patchSha256: audit.patchSha256,
      appliedAuditIntegrity: audit.integrity,
      rolledBackAt: now.toISOString(),
      status: "rolled-back" as const,
      operations: restored,
    };
    const integrity = auditIntegrityHash(base);
    const auditPath = join(dirname(auditRecordPath(stateRoot, proposal.id)), "rollback.json");
    fs.writeFile(auditPath, JSON.stringify({ ...base, integrity }, null, 2) + "\n");
    return { proposalId: proposal.id, status: "rolled-back", alreadyRolledBack: false, operations: restored, auditPath };
  } catch (err) {
    const recoveryErrors = restoreAppliedState();
    const detail = err instanceof Error ? err.message : String(err);
    throw new ImprovementGateError(
      "rollback-failed",
      recoveryErrors.length === 0
        ? `Rollback failed and applied bytes were restored: ${detail}`
        : `Rollback failed and recovery was incomplete: ${detail}; ${recoveryErrors.join("; ")}`,
    );
  }
}
