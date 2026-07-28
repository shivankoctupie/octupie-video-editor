/**
 * Immutable, file-backed version store (parity phase 8).
 *
 * A version record is immutable: once written, its file is never overwritten. The
 * project index tracks the latest version and full lineage. Creating v1 requires an
 * empty project and a null parent; creating vN requires `parentVersionId` to equal
 * the current latest version id and produces a monotonically incremented number. A
 * mismatched parent, or a stale `expectedRevision`, is an optimistic-conflict
 * rejection. Every referenced plan/master file is validated for containment and a
 * real regular non-symlink type, and hashed over its real bytes by the store (a
 * caller never supplies a hash). Record and index writes are atomic.
 */

import { join, resolve } from "node:path";
import {
  defaultWorkflowFs,
  validateReferencedFile,
  WorkflowStoreError,
  writeJsonState,
  readJsonState,
  type WorkflowFs,
} from "./store.js";
import {
  parseVersionIndex,
  parseVersionRecord,
  VERSION_INDEX_FORMAT,
  VERSION_RECORD_FORMAT,
  type VersionIndexValue,
  type VersionRecordValue,
  type VersionStatus,
  type VersionSummaryValue,
} from "./schemas.js";

import { requireAuthorized } from "./rbac.js";
import type { WorkflowRole } from "./schemas.js";

export interface VersionStoreContext {
  /** State root OUTSIDE the source tree where records and the index live. */
  stateRoot: string;
  /** The source tree every referenced plan/master file must resolve under. */
  projectRoot: string;
  fs?: WorkflowFs;
  now?: Date;
}

function projectDir(stateRoot: string, projectId: string): string {
  return resolve(stateRoot, "versions", projectId);
}

export function versionIndexPath(stateRoot: string, projectId: string): string {
  return join(projectDir(stateRoot, projectId), "index.json");
}

export function versionRecordPath(stateRoot: string, projectId: string, versionId: string): string {
  return join(projectDir(stateRoot, projectId), "records", `${versionId}.json`);
}

/** Deterministic, filename-safe version id. */
export function versionId(projectId: string, version: number): string {
  return `${projectId}.v${String(version).padStart(4, "0")}`;
}

function loadIndex(ctx: Required<Pick<VersionStoreContext, "stateRoot">> & { fs: WorkflowFs }, projectId: string): VersionIndexValue | null {
  const raw = readJsonState(versionIndexPath(ctx.stateRoot, projectId), ctx.fs);
  if (raw === null) return null;
  const parsed = parseVersionIndex(raw);
  if (!parsed.ok || !parsed.data) {
    throw new WorkflowStoreError("bad-index", `Version index for '${projectId}' is corrupt: ${parsed.errors.join("; ")}`);
  }
  return parsed.data;
}

export function loadVersion(ctx: VersionStoreContext, projectId: string, id: string): VersionRecordValue {
  const fs = ctx.fs ?? defaultWorkflowFs;
  const raw = readJsonState(versionRecordPath(ctx.stateRoot, projectId, id), fs);
  if (raw === null) throw new WorkflowStoreError("no-version", `No version record '${id}' for project '${projectId}'.`);
  const parsed = parseVersionRecord(raw);
  if (!parsed.ok || !parsed.data) {
    throw new WorkflowStoreError("bad-version", `Version record '${id}' is corrupt: ${parsed.errors.join("; ")}`);
  }
  return parsed.data;
}

export function listVersions(ctx: VersionStoreContext, projectId: string): VersionSummaryValue[] {
  const fs = ctx.fs ?? defaultWorkflowFs;
  const index = loadIndex({ stateRoot: ctx.stateRoot, fs }, projectId);
  return index ? [...index.versions] : [];
}

export interface AppendVersionInput {
  projectId: string;
  creator: string;
  planPath: string;
  masterPath?: string;
  status: VersionStatus;
  /** Null for the first version; the current latest version id for every later version. */
  parentVersionId: string | null;
  /** Optional optimistic guard: the index revision the caller believes is current. */
  expectedRevision?: number;
}

/**
 * Append a new immutable version. Validates lineage (monotonic, matching parent),
 * optimistic revision, referenced files (containment + real bytes hashing), refuses
 * to overwrite an existing record, and writes the record then the index atomically.
 */
function appendVersionRecord(ctx: VersionStoreContext, input: AppendVersionInput): VersionRecordValue {
  const fs = ctx.fs ?? defaultWorkflowFs;
  const now = ctx.now ?? new Date();
  const projectRoot = resolve(ctx.projectRoot);
  const index = loadIndex({ stateRoot: ctx.stateRoot, fs }, input.projectId);

  const currentLatestId = index?.latestVersionId ?? null;
  const currentLatest = index?.latestVersion ?? 0;
  const currentRevision = index?.revision ?? 0;

  // Optimistic conflict: the caller's view of the index is stale.
  if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
    throw new WorkflowStoreError(
      "conflict",
      `Optimistic conflict: expected index revision ${input.expectedRevision}, found ${currentRevision}.`,
    );
  }

  // Lineage: v1 needs an empty project and a null parent; vN needs the latest as parent.
  if (currentLatest === 0) {
    if (input.parentVersionId !== null) {
      throw new WorkflowStoreError("bad-parent", `First version must have a null parent, got '${input.parentVersionId}'.`);
    }
  } else {
    if (input.parentVersionId !== currentLatestId) {
      throw new WorkflowStoreError(
        "conflict",
        `Stale parent: parentVersionId '${input.parentVersionId}' is not the current latest '${currentLatestId}'.`,
      );
    }
  }
  const nextVersion = currentLatest + 1;
  const newId = versionId(input.projectId, nextVersion);

  // Immutability: never overwrite an existing record.
  if (fs.exists(versionRecordPath(ctx.stateRoot, input.projectId, newId))) {
    throw new WorkflowStoreError("exists", `Version record '${newId}' already exists and is immutable.`);
  }

  // Validate referenced files and hash real bytes.
  const plan = validateReferencedFile(input.planPath, projectRoot, fs, "plan");
  const master = input.masterPath !== undefined ? validateReferencedFile(input.masterPath, projectRoot, fs, "master") : null;

  const record: VersionRecordValue = {
    format: VERSION_RECORD_FORMAT,
    id: newId,
    projectId: input.projectId,
    version: nextVersion,
    parentVersionId: input.parentVersionId,
    planPath: plan.relPath,
    planSha256: plan.sha256,
    ...(master ? { masterPath: master.relPath, masterSha256: master.sha256 } : {}),
    creator: input.creator,
    createdAt: now.toISOString(),
    status: input.status,
  };
  const validated = parseVersionRecord(record);
  if (!validated.ok || !validated.data) {
    throw new WorkflowStoreError("bad-record", `Refusing to write an invalid version record: ${validated.errors.join("; ")}`);
  }

  // Write the immutable record first, then the index. Both atomic.
  writeJsonState(versionRecordPath(ctx.stateRoot, input.projectId, newId), validated.data, fs);

  const summary: VersionSummaryValue = {
    id: newId,
    version: nextVersion,
    parentVersionId: input.parentVersionId,
    status: input.status,
  };
  const nextIndex: VersionIndexValue = {
    format: VERSION_INDEX_FORMAT,
    projectId: input.projectId,
    latestVersion: nextVersion,
    latestVersionId: newId,
    revision: currentRevision + 1,
    versions: [...(index?.versions ?? []), summary],
    updatedAt: now.toISOString(),
  };
  writeJsonState(versionIndexPath(ctx.stateRoot, input.projectId), nextIndex, fs);

  return validated.data;
}

/** Public version creation creates drafts only. Review state cannot be forged by
 * calling the low-level version store directly. */
export function appendVersion(ctx: VersionStoreContext, input: AppendVersionInput): VersionRecordValue {
  if (input.status !== "draft") {
    throw new WorkflowStoreError("transition-required", `Status '${input.status}' requires an authorized workflow transition.`);
  }
  return appendVersionRecord(ctx, input);
}

export interface AppendTransitionInput extends Omit<AppendVersionInput, "status"> {
  role: WorkflowRole;
  status: "in-review" | "approved" | "rejected";
}

/** Append a review status only through its matching RBAC action and lineage. */
export function appendVersionTransition(ctx: VersionStoreContext, input: AppendTransitionInput): VersionRecordValue {
  requireAuthorized(input.role, input.status === "in-review" ? "submit-review" : "decide-review");
  const parent = input.parentVersionId ? loadVersion(ctx, input.projectId, input.parentVersionId) : null;
  if (input.status === "in-review" && parent?.status !== "draft") {
    throw new WorkflowStoreError("bad-transition", "An in-review version must descend from a draft.");
  }
  if ((input.status === "approved" || input.status === "rejected") && parent?.status !== "in-review") {
    throw new WorkflowStoreError("bad-transition", `A ${input.status} version must descend from an in-review version.`);
  }
  return appendVersionRecord(ctx, input);
}
