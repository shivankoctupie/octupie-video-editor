/**
 * Deterministic apply engine for reviewed improvement proposals (parity phase 7).
 *
 * There is no silent self-modification path. Applying a proposal requires ALL of:
 *
 *   1. a structurally valid proposal and a valid decision whose `proposalId`
 *      exactly matches and whose `approved` is true (an apply-action decision);
 *   2. an unexpired `code-change` PermissionPolicy grant, checked BEFORE any write;
 *   3. every operation passing preflight (portable allowed path, lexical AND
 *      canonical containment, a real regular non-symlink file, and current bytes
 *      whose hash and content exactly match the declared `beforeSha256`/`beforeText`).
 *
 * Only after every gate and every preflight passes does the engine write. It first
 * records exact backups and an integrity-stamped audit artifact under a state root
 * outside the source tree, then writes each file atomically (temp + rename). If any
 * write or any injected test-runner command fails, it automatically restores every
 * touched file to its exact prior bytes, marks the proposal `failed`, and records
 * `rolledBack: true`. No shell is ever invoked here; the test runner is injected.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PermissionDeniedError, requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import { assertContainedPath } from "../util/paths.js";
import { sha256String } from "../util/hash.js";
import { atomicWrite } from "../agent/audit.js";
import { checkPortableAllowedPath } from "./guard.js";
import {
  isAllowedTestCommand,
  parseImprovementDecision,
  parseImprovementProposal,
  parseStructuredPatchString,
  type ImprovementDecisionValue,
  type ImprovementProposalValue,
  type ReplaceOperationValue,
  type StructuredPatchValue,
} from "./schemas.js";

export const AUDIT_FORMAT = "octupie-improvement-audit/v1";

/** Thrown for any gate or preflight failure. When raised, NOTHING has been written. */
export class ImprovementGateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ImprovementGateError";
    this.code = code;
  }
}

/** One injected test-runner outcome. */
export interface TestRunResult {
  command: string;
  ok: boolean;
  detail: string;
}

/** Runs one allowlisted test command. Injected; the core never shells out. */
export type TestRunner = (command: string) => Promise<TestRunResult>;

/** Minimal filesystem surface, injectable so failure paths are testable. */
export interface ImprovementFs {
  readFileBytes(absPath: string): string;
  writeFile(absPath: string, data: string): void;
  ensureDir(absPath: string): void;
  /** Lexically-safe existence + type probe (does not follow the final symlink). */
  lstat(absPath: string): { exists: boolean; isFile: boolean; isSymlink: boolean };
  /** Canonical (symlink-resolved) real path. Used to defeat symlinked-parent escapes. */
  realpath(absPath: string): string;
}

export const defaultImprovementFs: ImprovementFs = {
  readFileBytes: (p) => readFileSync(p, "utf8"),
  writeFile: (p, data) => atomicWrite(p, data),
  ensureDir: (p) => mkdirSync(p, { recursive: true }),
  lstat: (p) => {
    if (!existsSync(p)) return { exists: false, isFile: false, isSymlink: false };
    const st = lstatSync(p);
    return { exists: true, isFile: st.isFile(), isSymlink: st.isSymbolicLink() };
  },
  realpath: (p) => realpathSync(p),
};

export interface ApplyOperationRecord {
  path: string;
  beforeSha256: string;
  afterSha256: string;
}

export interface ImprovementAuditRecord {
  format: typeof AUDIT_FORMAT;
  kind: "apply";
  proposalId: string;
  patchSha256: string;
  approver: string;
  decidedAt: string;
  appliedAt: string;
  status: "applied";
  operations: ApplyOperationRecord[];
  integrity: string;
}

export interface ApplyResult {
  proposalId: string;
  status: "applied" | "failed";
  rolledBack: boolean;
  operations: ApplyOperationRecord[];
  auditPath?: string;
  tests: TestRunResult[];
  failure?: string;
}

export interface ApplyProposalInput {
  proposal: unknown;
  decision: unknown;
  policy: PermissionPolicy;
  testRunner: TestRunner;
  /** The source tree every operation must resolve under. Defaults to cwd. */
  projectRoot?: string;
  /** State root OUTSIDE the source tree where audit + backups live. */
  stateRoot: string;
  now?: Date;
  fs?: ImprovementFs;
}

/** Stable JSON (sorted keys) so an audit hash is independent of key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Integrity hash of an audit record, computed over every field except `integrity`. */
export function auditIntegrityHash(record: object): string {
  return sha256String(stableStringify(record));
}

/** The per-proposal audit directory under a state root. */
export function auditDirFor(stateRoot: string, proposalId: string): string {
  return resolve(stateRoot, "audit", proposalId);
}

export function auditRecordPath(stateRoot: string, proposalId: string): string {
  return join(auditDirFor(stateRoot, proposalId), "record.json");
}

interface PreparedOp {
  op: ReplaceOperationValue;
  absPath: string;
  canonicalPath: string;
  afterSha256: string;
}

/** Validate the proposal artifact and its embedded structured patch. */
export function validateProposalArtifact(proposal: unknown): { value: ImprovementProposalValue; patch: StructuredPatchValue } {
  const parsed = parseImprovementProposal(proposal);
  if (!parsed.ok || !parsed.data) {
    throw new ImprovementGateError("invalid-proposal", `Invalid improvement proposal: ${parsed.errors.join("; ")}`);
  }
  const patch = parseStructuredPatchString(parsed.data.patch);
  if (!patch.ok || !patch.data) {
    throw new ImprovementGateError("invalid-patch", `Invalid structured patch: ${patch.errors.join("; ")}`);
  }
  // Every declared test command must be allowlisted (defense in depth beyond schema).
  for (const t of parsed.data.tests) {
    if (!isAllowedTestCommand(t)) {
      throw new ImprovementGateError("bad-test-command", `Refusing a non-allowlisted test command: ${JSON.stringify(t)}`);
    }
  }
  return { value: parsed.data, patch: patch.data };
}

/** Validate a decision and enforce the approval gate for a given action. */
export function requireDecision(
  decisionInput: unknown,
  proposalId: string,
  action: "apply" | "rollback",
): ImprovementDecisionValue {
  const parsed = parseImprovementDecision(decisionInput);
  if (!parsed.ok || !parsed.data) {
    throw new ImprovementGateError("invalid-decision", `Invalid decision: ${parsed.errors.join("; ")}`);
  }
  const decision = parsed.data;
  if (decision.proposalId !== proposalId) {
    throw new ImprovementGateError(
      "decision-mismatch",
      `Decision proposalId '${decision.proposalId}' does not match proposal '${proposalId}'.`,
    );
  }
  if (decision.action !== action) {
    throw new ImprovementGateError(
      "wrong-action",
      `Decision action '${decision.action}' is not '${action}'.`,
    );
  }
  if (decision.approved !== true) {
    throw new ImprovementGateError("not-approved", `Proposal '${proposalId}' was not approved (approved=${decision.approved}).`);
  }
  return decision;
}

/**
 * Preflight one operation. Throws {@link ImprovementGateError} on any problem; on
 * success returns the resolved absolute + canonical paths and the after-hash. This
 * NEVER writes.
 */
function preflightOperation(op: ReplaceOperationValue, projectRoot: string, fs: ImprovementFs): PreparedOp {
  const pathError = checkPortableAllowedPath(op.path);
  if (pathError) throw new ImprovementGateError("bad-path", `Operation path rejected: ${pathError}`);

  const canonicalRoot = fs.realpath(projectRoot);
  const absPath = resolve(projectRoot, op.path);
  // Lexical containment first: a fast, symlink-independent guard.
  assertContainedPath(absPath, projectRoot, "operation path");

  const st = fs.lstat(absPath);
  if (!st.exists) throw new ImprovementGateError("missing-file", `Target file does not exist: ${op.path}`);
  if (st.isSymlink) throw new ImprovementGateError("symlink", `Target is a symlink, which is refused: ${op.path}`);
  if (!st.isFile) throw new ImprovementGateError("not-regular", `Target is not a regular file: ${op.path}`);

  // Canonical containment: resolve the real parent so a symlinked directory cannot
  // escape the root, then re-check the real file path stays inside.
  const realParent = fs.realpath(dirname(absPath));
  assertContainedPath(realParent, canonicalRoot, "canonical operation parent");
  const canonicalPath = join(realParent, op.path.split("/").pop()!);
  assertContainedPath(canonicalPath, canonicalRoot, "canonical operation path");

  const current = fs.readFileBytes(canonicalPath);
  const currentSha = sha256String(current);
  if (currentSha !== op.beforeSha256) {
    throw new ImprovementGateError(
      "stale-hash",
      `Target '${op.path}' has changed: expected beforeSha256 ${op.beforeSha256}, found ${currentSha}.`,
    );
  }
  if (current !== op.beforeText) {
    throw new ImprovementGateError("stale-bytes", `Target '${op.path}' has unexpected existing bytes; refusing to overwrite.`);
  }
  return { op, absPath, canonicalPath, afterSha256: sha256String(op.afterText) };
}

/**
 * Apply a proposal. Returns a result; throws only on a gate/preflight failure
 * (before any write) or a permission denial. A write- or test-time failure is
 * auto-rolled-back and returned as `status: "failed", rolledBack: true`.
 */
export async function applyProposal(input: ApplyProposalInput): Promise<ApplyResult> {
  const fs = input.fs ?? defaultImprovementFs;
  const now = input.now ?? new Date();
  const projectRoot = resolve(input.projectRoot ?? process.cwd());

  const { value: proposal, patch } = validateProposalArtifact(input.proposal);
  const decision = requireDecision(input.decision, proposal.id, "apply");

  // Gate 2: the code-change grant is checked BEFORE any filesystem write.
  requireGrant("code-change", input.policy, now);

  // Preflight EVERY operation before the first write.
  const prepared = patch.operations.map((op) => preflightOperation(op, projectRoot, fs));

  const stateRoot = resolve(input.stateRoot);
  const auditDir = auditDirFor(stateRoot, proposal.id);
  const backupsDir = join(auditDir, "backups");
  fs.ensureDir(backupsDir);

  // Record exact backups first so a mid-write crash is recoverable off-disk too.
  prepared.forEach((p, i) => {
    fs.writeFile(join(backupsDir, `${String(i).padStart(2, "0")}.before`), p.op.beforeText);
  });

  const operations: ApplyOperationRecord[] = prepared.map((p) => ({
    path: p.op.path,
    beforeSha256: p.op.beforeSha256,
    afterSha256: p.afterSha256,
  }));

  const restore = (upTo: number): string[] => {
    const errors: string[] = [];
    for (let i = 0; i <= upTo; i++) {
      const p = prepared[i]!;
      try {
        fs.writeFile(p.canonicalPath, p.op.beforeText);
      } catch (err) {
        errors.push(`${p.op.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return errors;
  };

  // Write every file atomically. On any failure, restore all declared files.
  try {
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i]!;
      fs.writeFile(p.canonicalPath, p.op.afterText);
    }
  } catch (err) {
    const restoreErrors = restore(prepared.length - 1);
    return failed(
      fs,
      stateRoot,
      proposal.id,
      operations,
      `write failed: ${err instanceof Error ? err.message : String(err)}`,
      [],
      restoreErrors.length === 0,
      restoreErrors,
    );
  }

  // Run every allowlisted test command through the injected runner.
  const tests: TestRunResult[] = [];
  for (const command of proposal.tests) {
    if (!isAllowedTestCommand(command)) {
      const restoreErrors = restore(prepared.length - 1);
      return failed(fs, stateRoot, proposal.id, operations, `non-allowlisted test command reached the runner: ${command}`, tests, restoreErrors.length === 0, restoreErrors);
    }
    let result: TestRunResult;
    try {
      result = await input.testRunner(command);
    } catch (err) {
      const restoreErrors = restore(prepared.length - 1);
      return failed(fs, stateRoot, proposal.id, operations, `test runner threw for ${command}: ${err instanceof Error ? err.message : String(err)}`, tests, restoreErrors.length === 0, restoreErrors);
    }
    tests.push(result);
    if (!result.ok) {
      const restoreErrors = restore(prepared.length - 1);
      return failed(fs, stateRoot, proposal.id, operations, `test failed: ${command} (${result.detail})`, tests, restoreErrors.length === 0, restoreErrors);
    }
  }

  // Success: write the integrity-stamped applied audit record.
  const base: Omit<ImprovementAuditRecord, "integrity"> = {
    format: AUDIT_FORMAT,
    kind: "apply",
    proposalId: proposal.id,
    patchSha256: sha256String(proposal.patch),
    approver: decision.approver,
    decidedAt: decision.decidedAt,
    appliedAt: now.toISOString(),
    status: "applied",
    operations,
  };
  const record: ImprovementAuditRecord = { ...base, integrity: auditIntegrityHash(base) };
  const auditPath = auditRecordPath(stateRoot, proposal.id);
  try {
    fs.writeFile(auditPath, JSON.stringify(record, null, 2) + "\n");
  } catch (err) {
    const restoreErrors = restore(prepared.length - 1);
    return failed(fs, stateRoot, proposal.id, operations, `audit write failed: ${err instanceof Error ? err.message : String(err)}`, tests, restoreErrors.length === 0, restoreErrors);
  }

  return { proposalId: proposal.id, status: "applied", rolledBack: false, operations, auditPath, tests };
}

/** Record a failure audit artifact and return a failed, rolled-back result. */
function failed(
  fs: ImprovementFs,
  stateRoot: string,
  proposalId: string,
  operations: ApplyOperationRecord[],
  failure: string,
  tests: TestRunResult[],
  rolledBack = true,
  restoreErrors: string[] = [],
): ApplyResult {
  const failPath = join(auditDirFor(stateRoot, proposalId), "failure.json");
  try {
    fs.writeFile(
      failPath,
      JSON.stringify({ format: AUDIT_FORMAT, kind: "apply", proposalId, status: "failed", rolledBack, failure, restoreErrors, operations }, null, 2) + "\n",
    );
  } catch {
    /* never let audit-write failure mask the original failure */
  }
  return {
    proposalId,
    status: "failed",
    rolledBack,
    operations,
    tests,
    failure: restoreErrors.length ? `${failure}; restore errors: ${restoreErrors.join("; ")}` : failure,
  };
}

/** Load and integrity-check a prior applied audit record. */
export function loadAppliedAudit(stateRoot: string, proposalId: string, fs: ImprovementFs = defaultImprovementFs): ImprovementAuditRecord {
  const path = auditRecordPath(stateRoot, proposalId);
  let raw: string;
  try {
    raw = fs.readFileBytes(path);
  } catch {
    throw new ImprovementGateError("no-audit", `No applied audit record for proposal '${proposalId}'.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ImprovementGateError("bad-audit", `Audit record is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const record = json as ImprovementAuditRecord;
  if (record?.format !== AUDIT_FORMAT || record?.kind !== "apply" || record?.status !== "applied") {
    throw new ImprovementGateError("bad-audit", `Audit record for '${proposalId}' is not a valid applied record.`);
  }
  const { integrity, ...rest } = record;
  if (integrity !== auditIntegrityHash(rest)) {
    throw new ImprovementGateError("tampered-audit", `Audit record for '${proposalId}' failed its integrity check (tampered).`);
  }
  return record;
}

export { PermissionDeniedError };
