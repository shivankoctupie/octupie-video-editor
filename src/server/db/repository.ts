/**
 * Transactional repository over `node:sqlite`.
 *
 * This is the durable, multi-user replacement for the single-process file queue. It
 * enforces the product invariants at the data layer: tenant isolation on every read,
 * immutable versions/decisions/receipts (insert only, never update), a concurrency
 * safe FIFO job claim inside a write transaction, unique idempotency constraints for
 * jobs and receipts, and parameterized SQL everywhere so no caller string can inject.
 * Time is injected so tests are deterministic. `close()` is a clean shutdown.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { migrate } from "./migrations.js";
import {
  JOB_TYPES,
  VERSION_STATUSES,
  WORKFLOW_ROLES,
  type JobType,
  type VersionStatus,
  type WorkflowRole,
} from "../../workflow/schemas.js";

export interface RepoClock {
  now(): string;
}

const realClock: RepoClock = { now: () => new Date().toISOString() };

export class RepositoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
  }
}

export interface TenantRow {
  id: string;
  name: string;
  createdAt: string;
}
export interface UserRow {
  id: string;
  tenantId: string;
  username: string;
  role: WorkflowRole;
  createdAt: string;
}
export interface ProjectRow {
  id: string;
  tenantId: string;
  name: string;
  createdBy: string;
  createdAt: string;
}
export interface VersionRow {
  id: string;
  tenantId: string;
  projectId: string;
  version: number;
  parentVersionId: string | null;
  planPath: string;
  planSha256: string;
  masterPath: string | null;
  masterSha256: string | null;
  status: VersionStatus;
  creator: string;
  createdAt: string;
}
export interface CommentRow {
  id: string;
  tenantId: string;
  projectId: string;
  versionId: string;
  frame: number;
  timeSec: number;
  author: string;
  body: string;
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}
export interface DecisionRow {
  id: string;
  tenantId: string;
  projectId: string;
  versionId: string;
  newVersionId: string;
  approved: boolean;
  approver: string;
  role: string;
  notes: string | null;
  decidedAt: string;
}
export interface JobRow {
  id: string;
  tenantId: string;
  projectId: string | null;
  type: JobType;
  status: string;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  enqueuedBy: string;
  failureDetail: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
}
export interface AttemptRow {
  id: number;
  jobId: string;
  attempt: number;
  status: string;
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}
export interface ReceiptRow {
  id: string;
  tenantId: string;
  projectId: string;
  versionId: string;
  adapterId: string;
  idempotencyKey: string;
  providerRef: string | null;
  publishedBy: string;
  data: Record<string, unknown>;
  publishedAt: string;
}
export interface AuditRow {
  id: number;
  tenantId: string;
  actor: string;
  action: string;
  subject: string | null;
  detail: string | null;
  at: string;
}
export interface MediaRow {
  id: string;
  tenantId: string;
  projectId: string;
  storageKey: string;
  sha256: string;
  size: number;
  mime: string;
  filename: string;
  origin: string;
  uploadedBy: string;
  createdAt: string;
}
export interface QaReportRow {
  id: string;
  tenantId: string;
  projectId: string;
  versionId: string;
  pass: boolean;
  report: Record<string, unknown>;
  createdAt: string;
}
export interface AddMediaInput {
  id: string;
  tenantId: string;
  projectId: string;
  storageKey: string;
  sha256: string;
  size: number;
  mime: string;
  filename: string;
  origin?: string;
  uploadedBy: string;
}
/** Result of an atomic quota reservation: `id` is present only when granted. */
export type QuotaReservation = { ok: true; id: string; used: number } | { ok: false; used: number };

function toBool(v: unknown): boolean {
  return v === 1 || v === true || v === "1";
}

function parseJson(text: unknown): Record<string, unknown> {
  if (typeof text !== "string") return {};
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class Repository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: RepoClock = realClock,
  ) {}

  close(): void {
    this.db.close();
  }

  // ---- tenants ----------------------------------------------------------
  createTenant(input: { id: string; name: string }): TenantRow {
    const at = this.clock.now();
    this.db.prepare("INSERT INTO tenants(id, name, created_at) VALUES(?, ?, ?)").run(input.id, input.name, at);
    return { id: input.id, name: input.name, createdAt: at };
  }
  getTenant(id: string): TenantRow | null {
    const r = this.db.prepare("SELECT id, name, created_at FROM tenants WHERE id = ?").get(id) as
      | { id: string; name: string; created_at: string }
      | undefined;
    return r ? { id: r.id, name: r.name, createdAt: r.created_at } : null;
  }

  // ---- users ------------------------------------------------------------
  createUser(input: { id: string; tenantId: string; username: string; role: WorkflowRole; tokenSha256: string }): UserRow {
    if (!(WORKFLOW_ROLES as readonly string[]).includes(input.role)) {
      throw new RepositoryError("bad-role", `Unknown role '${input.role}'.`);
    }
    const at = this.clock.now();
    this.db
      .prepare("INSERT INTO users(id, tenant_id, username, role, token_sha256, created_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(input.id, input.tenantId, input.username, input.role, input.tokenSha256, at);
    return { id: input.id, tenantId: input.tenantId, username: input.username, role: input.role, createdAt: at };
  }
  /** Look a user up by the SHA-256 of their bearer token. The token itself is never stored. */
  getUserByTokenHash(tokenSha256: string): UserRow | null {
    const r = this.db
      .prepare("SELECT id, tenant_id, username, role, created_at FROM users WHERE token_sha256 = ?")
      .get(tokenSha256) as { id: string; tenant_id: string; username: string; role: WorkflowRole; created_at: string } | undefined;
    return r ? { id: r.id, tenantId: r.tenant_id, username: r.username, role: r.role, createdAt: r.created_at } : null;
  }
  listUsers(tenantId: string): UserRow[] {
    const rows = this.db
      .prepare("SELECT id, tenant_id, username, role, created_at FROM users WHERE tenant_id = ? ORDER BY username")
      .all(tenantId) as Array<{ id: string; tenant_id: string; username: string; role: WorkflowRole; created_at: string }>;
    return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, username: r.username, role: r.role, createdAt: r.created_at }));
  }

  // ---- projects ---------------------------------------------------------
  createProject(input: { id: string; tenantId: string; name: string; createdBy: string }): ProjectRow {
    const at = this.clock.now();
    this.db
      .prepare("INSERT INTO projects(id, tenant_id, name, created_by, created_at) VALUES(?, ?, ?, ?, ?)")
      .run(input.id, input.tenantId, input.name, input.createdBy, at);
    return { id: input.id, tenantId: input.tenantId, name: input.name, createdBy: input.createdBy, createdAt: at };
  }
  getProject(tenantId: string, id: string): ProjectRow | null {
    const r = this.db
      .prepare("SELECT id, tenant_id, name, created_by, created_at FROM projects WHERE tenant_id = ? AND id = ?")
      .get(tenantId, id) as { id: string; tenant_id: string; name: string; created_by: string; created_at: string } | undefined;
    return r ? { id: r.id, tenantId: r.tenant_id, name: r.name, createdBy: r.created_by, createdAt: r.created_at } : null;
  }
  listProjects(tenantId: string): ProjectRow[] {
    const rows = this.db
      .prepare("SELECT id, tenant_id, name, created_by, created_at FROM projects WHERE tenant_id = ? ORDER BY created_at, id")
      .all(tenantId) as Array<{ id: string; tenant_id: string; name: string; created_by: string; created_at: string }>;
    return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, name: r.name, createdBy: r.created_by, createdAt: r.created_at }));
  }

  // ---- versions (immutable, monotonic per project) ----------------------
  appendVersion(input: {
    id: string;
    tenantId: string;
    projectId: string;
    parentVersionId: string | null;
    planPath: string;
    planSha256: string;
    masterPath?: string | null;
    masterSha256?: string | null;
    creator: string;
    status: VersionStatus;
  }): VersionRow {
    if (!(VERSION_STATUSES as readonly string[]).includes(input.status)) {
      throw new RepositoryError("bad-status", `Unknown version status '${input.status}'.`);
    }
    const at = this.clock.now();
    const max = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS m FROM versions WHERE tenant_id = ? AND project_id = ?")
      .get(input.tenantId, input.projectId) as { m: number };
    const version = Number(max.m) + 1;
    this.db
      .prepare(
        "INSERT INTO versions(id, tenant_id, project_id, version, parent_version_id, plan_path, plan_sha256, master_path, master_sha256, status, creator, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        input.tenantId,
        input.projectId,
        version,
        input.parentVersionId ?? null,
        input.planPath,
        input.planSha256,
        input.masterPath ?? null,
        input.masterSha256 ?? null,
        input.status,
        input.creator,
        at,
      );
    return this.getVersion(input.tenantId, input.projectId, input.id)!;
  }
  getVersion(tenantId: string, projectId: string, versionId: string): VersionRow | null {
    const r = this.db
      .prepare("SELECT * FROM versions WHERE tenant_id = ? AND project_id = ? AND id = ?")
      .get(tenantId, projectId, versionId) as Record<string, unknown> | undefined;
    return r ? this.mapVersion(r) : null;
  }
  listVersions(tenantId: string, projectId: string): VersionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM versions WHERE tenant_id = ? AND project_id = ? ORDER BY version")
      .all(tenantId, projectId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapVersion(r));
  }
  latestVersion(tenantId: string, projectId: string): VersionRow | null {
    const r = this.db
      .prepare("SELECT * FROM versions WHERE tenant_id = ? AND project_id = ? ORDER BY version DESC LIMIT 1")
      .get(tenantId, projectId) as Record<string, unknown> | undefined;
    return r ? this.mapVersion(r) : null;
  }
  private mapVersion(r: Record<string, unknown>): VersionRow {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      projectId: r.project_id as string,
      version: Number(r.version),
      parentVersionId: (r.parent_version_id as string | null) ?? null,
      planPath: r.plan_path as string,
      planSha256: r.plan_sha256 as string,
      masterPath: (r.master_path as string | null) ?? null,
      masterSha256: (r.master_sha256 as string | null) ?? null,
      status: r.status as VersionStatus,
      creator: r.creator as string,
      createdAt: r.created_at as string,
    };
  }

  // ---- comments ---------------------------------------------------------
  addComment(input: {
    id: string;
    tenantId: string;
    projectId: string;
    versionId: string;
    frame: number;
    timeSec: number;
    author: string;
    body: string;
  }): CommentRow {
    const at = this.clock.now();
    this.db
      .prepare(
        "INSERT INTO comments(id, tenant_id, project_id, version_id, frame, time_sec, author, body, resolved, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
      )
      .run(input.id, input.tenantId, input.projectId, input.versionId, Math.trunc(input.frame), input.timeSec, input.author, input.body, at);
    return this.getComment(input.tenantId, input.id)!;
  }
  getComment(tenantId: string, id: string): CommentRow | null {
    const r = this.db.prepare("SELECT * FROM comments WHERE tenant_id = ? AND id = ?").get(tenantId, id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapComment(r) : null;
  }
  listComments(tenantId: string, projectId: string, versionId: string): CommentRow[] {
    const rows = this.db
      .prepare("SELECT * FROM comments WHERE tenant_id = ? AND project_id = ? AND version_id = ? ORDER BY time_sec, created_at")
      .all(tenantId, projectId, versionId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapComment(r));
  }
  resolveComment(input: { tenantId: string; commentId: string; resolvedBy: string }): CommentRow {
    const existing = this.getComment(input.tenantId, input.commentId);
    if (!existing) throw new RepositoryError("no-comment", `No comment '${input.commentId}'.`);
    const at = this.clock.now();
    this.db
      .prepare("UPDATE comments SET resolved = 1, resolved_by = ?, resolved_at = ? WHERE tenant_id = ? AND id = ?")
      .run(input.resolvedBy, at, input.tenantId, input.commentId);
    return this.getComment(input.tenantId, input.commentId)!;
  }
  private mapComment(r: Record<string, unknown>): CommentRow {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      projectId: r.project_id as string,
      versionId: r.version_id as string,
      frame: Number(r.frame),
      timeSec: Number(r.time_sec),
      author: r.author as string,
      body: r.body as string,
      resolved: toBool(r.resolved),
      resolvedBy: (r.resolved_by as string | null) ?? null,
      resolvedAt: (r.resolved_at as string | null) ?? null,
      createdAt: r.created_at as string,
    };
  }

  // ---- review decisions (append a new immutable version) ----------------
  recordDecision(input: {
    id: string;
    tenantId: string;
    projectId: string;
    versionId: string;
    approved: boolean;
    approver: string;
    role: string;
    notes?: string;
  }): { decision: DecisionRow; version: VersionRow } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Re-read and guard the transition INSIDE the write transaction: the source must
      // still be in-review and must not already carry a decision. Because a decision leaves
      // the source in-review (versions are immutable), the "already decided" check is what
      // actually stops a duplicate, and running it under BEGIN IMMEDIATE means two racing
      // decisions serialize so only the first commits; the unique index is the backstop.
      const source = this.getVersion(input.tenantId, input.projectId, input.versionId);
      if (!source) throw new RepositoryError("no-version", `No version '${input.versionId}'.`);
      if (source.status !== "in-review") {
        throw new RepositoryError("not-in-review", `Version '${input.versionId}' is '${source.status}', not in-review.`);
      }
      const decided = this.db
        .prepare("SELECT id FROM decisions WHERE tenant_id = ? AND project_id = ? AND version_id = ?")
        .get(input.tenantId, input.projectId, input.versionId) as { id: string } | undefined;
      if (decided) {
        throw new RepositoryError("already-decided", `Version '${input.versionId}' already has a decision.`);
      }
      const at = this.clock.now();
      const max = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) AS m FROM versions WHERE tenant_id = ? AND project_id = ?")
        .get(input.tenantId, input.projectId) as { m: number };
      const version = Number(max.m) + 1;
      const newVersionId = `${input.versionId}-r${version}`;
      const status: VersionStatus = input.approved ? "approved" : "rejected";
      this.db
        .prepare(
          "INSERT INTO versions(id, tenant_id, project_id, version, parent_version_id, plan_path, plan_sha256, master_path, master_sha256, status, creator, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          newVersionId,
          input.tenantId,
          input.projectId,
          version,
          input.versionId,
          source.planPath,
          source.planSha256,
          source.masterPath ?? null,
          source.masterSha256 ?? null,
          status,
          input.approver,
          at,
        );
      this.db
        .prepare(
          "INSERT INTO decisions(id, tenant_id, project_id, version_id, new_version_id, approved, approver, role, notes, decided_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(input.id, input.tenantId, input.projectId, input.versionId, newVersionId, input.approved ? 1 : 0, input.approver, input.role, input.notes ?? null, at);
      this.db.exec("COMMIT");
      return {
        decision: {
          id: input.id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          versionId: input.versionId,
          newVersionId,
          approved: input.approved,
          approver: input.approver,
          role: input.role,
          notes: input.notes ?? null,
          decidedAt: at,
        },
        version: this.getVersion(input.tenantId, input.projectId, newVersionId)!,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- jobs -------------------------------------------------------------
  enqueueJob(input: {
    id: string;
    tenantId: string;
    projectId?: string | null;
    type: JobType;
    payload: Record<string, unknown>;
    enqueuedBy: string;
    idempotencyKey?: string;
    maxAttempts?: number;
  }): { job: JobRow; created: boolean } {
    if (!(JOB_TYPES as readonly string[]).includes(input.type)) {
      throw new RepositoryError("bad-type", `Unknown job type '${input.type}'.`);
    }
    if (input.idempotencyKey) {
      const existing = this.findJobByIdem(input.tenantId, input.idempotencyKey);
      if (existing) return { job: existing, created: false };
    }
    const at = this.clock.now();
    try {
      this.db
        .prepare(
          "INSERT INTO jobs(id, tenant_id, project_id, type, status, attempts, max_attempts, payload, idempotency_key, enqueued_by, created_at, updated_at) VALUES(?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.id,
          input.tenantId,
          input.projectId ?? null,
          input.type,
          Math.min(Math.max(input.maxAttempts ?? 3, 1), 3),
          JSON.stringify(input.payload ?? {}),
          input.idempotencyKey ?? null,
          input.enqueuedBy,
          at,
          at,
        );
    } catch (err) {
      if (input.idempotencyKey) {
        const existing = this.findJobByIdem(input.tenantId, input.idempotencyKey);
        if (existing) return { job: existing, created: false };
      }
      throw err;
    }
    return { job: this.getJobRow(input.id)!, created: true };
  }
  private findJobByIdem(tenantId: string, key: string): JobRow | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE tenant_id = ? AND idempotency_key = ?").get(tenantId, key) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapJob(r) : null;
  }
  private getJobRow(id: string): JobRow | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.mapJob(r) : null;
  }
  getJob(tenantId: string, jobId: string): JobRow | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE tenant_id = ? AND id = ?").get(tenantId, jobId) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapJob(r) : null;
  }
  listJobs(tenantId: string, opts: { status?: string } = {}): JobRow[] {
    const rows = (
      opts.status
        ? this.db.prepare("SELECT * FROM jobs WHERE tenant_id = ? AND status = ? ORDER BY created_at, rowid").all(tenantId, opts.status)
        : this.db.prepare("SELECT * FROM jobs WHERE tenant_id = ? ORDER BY created_at, rowid").all(tenantId)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapJob(r));
  }

  /**
   * Claim the oldest queued job and move it to running inside a write transaction.
   * The `AND status='queued'` guard on the UPDATE means a lost race changes zero rows
   * and retries, so a job is never claimed twice even under concurrency.
   */
  claimNextJob(opts: { tenantId?: string } = {}): JobRow | null {
    for (let tries = 0; tries < 8; tries++) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const row = (
          opts.tenantId
            ? this.db
                .prepare("SELECT id FROM jobs WHERE status = 'queued' AND tenant_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1")
                .get(opts.tenantId)
            : this.db.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1").get()
        ) as { id: string } | undefined;
        if (!row) {
          this.db.exec("COMMIT");
          return null;
        }
        const at = this.clock.now();
        const res = this.db
          .prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
          .run(at, at, row.id);
        if (Number(res.changes) === 0) {
          this.db.exec("COMMIT");
          continue;
        }
        this.db.exec("COMMIT");
        return this.getJobRow(row.id);
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
    return null;
  }
  completeJob(input: { tenantId: string; jobId: string }): JobRow {
    return this.transition(input.tenantId, input.jobId, "running", "succeeded", null);
  }
  /**
   * Record a failed attempt with bounded retries. Below `max_attempts` the running job is
   * requeued (its `created_at` and idempotency key are untouched, so it keeps its FIFO
   * position); only once `attempts` has reached the cap is the failure terminal. The whole
   * decision runs inside a write transaction with a `status = 'running'` guard, so a lost
   * race changes zero rows rather than double-transitioning a job. The per-attempt history
   * lives in `job_attempts`; this only moves the job row's state.
   */
  failJob(input: { tenantId: string; jobId: string; detail: string }): JobRow {
    const detail = input.detail.slice(0, 4000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.getJob(input.tenantId, input.jobId);
      if (!job) throw new RepositoryError("no-job", `No job '${input.jobId}'.`);
      if (job.status !== "running") {
        throw new RepositoryError("illegal-transition", `Cannot fail job '${input.jobId}' from '${job.status}'.`);
      }
      const terminal = job.attempts >= job.maxAttempts;
      const next = terminal ? "failed" : "queued";
      const at = this.clock.now();
      this.db
        .prepare("UPDATE jobs SET status = ?, failure_detail = ?, claimed_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'running'")
        .run(next, detail, at, input.tenantId, input.jobId);
      this.db.exec("COMMIT");
      return this.getJob(input.tenantId, input.jobId)!;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  private transition(tenantId: string, jobId: string, from: string, to: string, detail: string | null): JobRow {
    const job = this.getJob(tenantId, jobId);
    if (!job) throw new RepositoryError("no-job", `No job '${jobId}'.`);
    if (job.status !== from) {
      throw new RepositoryError("illegal-transition", `Cannot move job '${jobId}' from '${job.status}' to '${to}'.`);
    }
    const at = this.clock.now();
    this.db
      .prepare("UPDATE jobs SET status = ?, failure_detail = COALESCE(?, failure_detail), updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(to, detail, at, tenantId, jobId);
    return this.getJob(tenantId, jobId)!;
  }
  recordAttempt(input: { jobId: string; attempt: number; status: string; detail?: string; startedAt: string; finishedAt?: string }): void {
    this.db
      .prepare("INSERT INTO job_attempts(job_id, attempt, status, detail, started_at, finished_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(input.jobId, Math.trunc(input.attempt), input.status, input.detail ?? null, input.startedAt, input.finishedAt ?? null);
  }
  listAttempts(jobId: string): AttemptRow[] {
    const rows = this.db.prepare("SELECT * FROM job_attempts WHERE job_id = ? ORDER BY id").all(jobId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      jobId: r.job_id as string,
      attempt: Number(r.attempt),
      status: r.status as string,
      detail: (r.detail as string | null) ?? null,
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string | null) ?? null,
    }));
  }
  private mapJob(r: Record<string, unknown>): JobRow {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      projectId: (r.project_id as string | null) ?? null,
      type: r.type as JobType,
      status: r.status as string,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      payload: parseJson(r.payload),
      idempotencyKey: (r.idempotency_key as string | null) ?? null,
      enqueuedBy: r.enqueued_by as string,
      failureDetail: (r.failure_detail as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      claimedAt: (r.claimed_at as string | null) ?? null,
    };
  }

  // ---- receipts (immutable, idempotent) ---------------------------------
  createReceipt(input: {
    id: string;
    tenantId: string;
    projectId: string;
    versionId: string;
    adapterId: string;
    idempotencyKey: string;
    providerRef?: string;
    publishedBy: string;
    data: Record<string, unknown>;
  }): { receipt: ReceiptRow; created: boolean } {
    const existing = this.getReceipt(input.tenantId, input.adapterId, input.idempotencyKey);
    if (existing) return { receipt: existing, created: false };
    const at = this.clock.now();
    try {
      this.db
        .prepare(
          "INSERT INTO receipts(id, tenant_id, project_id, version_id, adapter_id, idempotency_key, provider_ref, published_by, data, published_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(input.id, input.tenantId, input.projectId, input.versionId, input.adapterId, input.idempotencyKey, input.providerRef ?? null, input.publishedBy, JSON.stringify(input.data ?? {}), at);
    } catch (err) {
      const dup = this.getReceipt(input.tenantId, input.adapterId, input.idempotencyKey);
      if (dup) return { receipt: dup, created: false };
      throw err;
    }
    return { receipt: this.getReceiptById(input.id)!, created: true };
  }
  getReceipt(tenantId: string, adapterId: string, idempotencyKey: string): ReceiptRow | null {
    const r = this.db
      .prepare("SELECT * FROM receipts WHERE tenant_id = ? AND adapter_id = ? AND idempotency_key = ?")
      .get(tenantId, adapterId, idempotencyKey) as Record<string, unknown> | undefined;
    return r ? this.mapReceipt(r) : null;
  }
  private getReceiptById(id: string): ReceiptRow | null {
    const r = this.db.prepare("SELECT * FROM receipts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.mapReceipt(r) : null;
  }
  private mapReceipt(r: Record<string, unknown>): ReceiptRow {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      projectId: r.project_id as string,
      versionId: r.version_id as string,
      adapterId: r.adapter_id as string,
      idempotencyKey: r.idempotency_key as string,
      providerRef: (r.provider_ref as string | null) ?? null,
      publishedBy: r.published_by as string,
      data: parseJson(r.data),
      publishedAt: r.published_at as string,
    };
  }

  // ---- audit ------------------------------------------------------------
  appendAudit(input: { tenantId: string; actor: string; action: string; subject?: string; detail?: string }): void {
    this.db
      .prepare("INSERT INTO audit(tenant_id, actor, action, subject, detail, at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(input.tenantId, input.actor, input.action, input.subject ?? null, input.detail ?? null, this.clock.now());
  }
  listAudit(tenantId: string, limit = 200): AuditRow[] {
    const rows = this.db
      .prepare("SELECT * FROM audit WHERE tenant_id = ? ORDER BY id DESC LIMIT ?")
      .all(tenantId, Math.min(Math.max(limit, 1), 1000)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      tenantId: r.tenant_id as string,
      actor: r.actor as string,
      action: r.action as string,
      subject: (r.subject as string | null) ?? null,
      detail: (r.detail as string | null) ?? null,
      at: r.at as string,
    }));
  }

  // ---- media ------------------------------------------------------------
  addMedia(input: AddMediaInput): MediaRow {
    const at = this.clock.now();
    const origin = input.origin ?? "upload";
    // Content-addressed: the same key in a project is idempotent, not an error.
    const existing = this.getMediaByKey(input.tenantId, input.projectId, input.storageKey);
    if (existing) return existing;
    this.db
      .prepare(
        "INSERT INTO media(id, tenant_id, project_id, storage_key, sha256, size, mime, filename, origin, uploaded_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(input.id, input.tenantId, input.projectId, input.storageKey, input.sha256, Math.trunc(input.size), input.mime, input.filename, origin, input.uploadedBy, at);
    return this.getMedia(input.tenantId, input.id)!;
  }
  getMedia(tenantId: string, id: string): MediaRow | null {
    const r = this.db.prepare("SELECT * FROM media WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
    return r ? this.mapMedia(r) : null;
  }
  private getMediaByKey(tenantId: string, projectId: string, key: string): MediaRow | null {
    const r = this.db
      .prepare("SELECT * FROM media WHERE tenant_id = ? AND project_id = ? AND storage_key = ?")
      .get(tenantId, projectId, key) as Record<string, unknown> | undefined;
    return r ? this.mapMedia(r) : null;
  }
  /** Total durable bytes registered for a tenant across all its projects (uploads,
   * generated assets, and materialized imports). Used to enforce the per-tenant quota. */
  tenantStorageBytes(tenantId: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM media WHERE tenant_id = ?").get(tenantId) as { total: number };
    return Number(r.total);
  }
  /** Outstanding reserved bytes for a tenant: reservations taken but not yet settled or
   * released. Counted alongside registered media so an in-flight write reserves its space. */
  private reservedBytes(tenantId: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM quota_reservations WHERE tenant_id = ?").get(tenantId) as { total: number };
    return Number(r.total);
  }
  /**
   * Atomically reserve `bytes` of durable storage for a tenant against `maxBytes`. The usage
   * read (registered media + outstanding reservations) and the reservation insert run inside
   * ONE `BEGIN IMMEDIATE` transaction, so two concurrent callers can never both cross the
   * boundary: the second sees the first's reservation and is refused. Returns the reservation
   * id when granted; the caller MUST later settle it (see {@link settleMedia}) or release it
   * (see {@link releaseReservation}). A file-backed database serializes this across processes.
   */
  reserveQuota(input: { id: string; tenantId: string; bytes: number; maxBytes: number }): QuotaReservation {
    const bytes = Math.max(0, Math.trunc(input.bytes));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.tenantStorageBytes(input.tenantId) + this.reservedBytes(input.tenantId);
      if (used + bytes > input.maxBytes) {
        this.db.exec("ROLLBACK");
        return { ok: false, used };
      }
      this.db
        .prepare("INSERT INTO quota_reservations(id, tenant_id, bytes, created_at) VALUES(?, ?, ?, ?)")
        .run(input.id, input.tenantId, bytes, this.clock.now());
      this.db.exec("COMMIT");
      return { ok: true, id: input.id, used };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  /** Release a reservation without settling it, used when the write or registration failed.
   * Idempotent: releasing an unknown or already-settled reservation is a no-op. */
  releaseReservation(id: string): void {
    this.db.prepare("DELETE FROM quota_reservations WHERE id = ?").run(id);
  }
  /**
   * Settle a reservation by registering its media row and deleting the reservation in a single
   * transaction, so reserved bytes convert to durable bytes EXACTLY ONCE. Media registration is
   * idempotent on (tenant, project, storage_key): re-settling deduplicated content simply
   * releases the reservation with the already-counted row. Omit `reservationId` to register
   * media without touching reservations (used when content was already stored, nothing reserved).
   */
  settleMedia(input: { reservationId?: string; media: AddMediaInput }): MediaRow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.addMedia(input.media);
      if (input.reservationId) {
        this.db.prepare("DELETE FROM quota_reservations WHERE id = ?").run(input.reservationId);
      }
      this.db.exec("COMMIT");
      return row;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  listMedia(tenantId: string, projectId: string): MediaRow[] {
    const rows = this.db
      .prepare("SELECT * FROM media WHERE tenant_id = ? AND project_id = ? ORDER BY created_at, id")
      .all(tenantId, projectId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapMedia(r));
  }
  private mapMedia(r: Record<string, unknown>): MediaRow {
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      projectId: r.project_id as string,
      storageKey: r.storage_key as string,
      sha256: r.sha256 as string,
      size: Number(r.size),
      mime: r.mime as string,
      filename: r.filename as string,
      origin: r.origin as string,
      uploadedBy: r.uploaded_by as string,
      createdAt: r.created_at as string,
    };
  }

  // ---- QA reports -------------------------------------------------------
  putQaReport(input: { id: string; tenantId: string; projectId: string; versionId: string; pass: boolean; report: Record<string, unknown> }): QaReportRow {
    const at = this.clock.now();
    this.db
      .prepare("INSERT INTO qa_reports(id, tenant_id, project_id, version_id, pass, report, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.tenantId, input.projectId, input.versionId, input.pass ? 1 : 0, JSON.stringify(input.report ?? {}), at);
    return { id: input.id, tenantId: input.tenantId, projectId: input.projectId, versionId: input.versionId, pass: input.pass, report: input.report ?? {}, createdAt: at };
  }
  latestQaReport(tenantId: string, projectId: string, versionId: string): QaReportRow | null {
    const r = this.db
      .prepare("SELECT * FROM qa_reports WHERE tenant_id = ? AND project_id = ? AND version_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(tenantId, projectId, versionId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      projectId: r.project_id as string,
      versionId: r.version_id as string,
      pass: toBool(r.pass),
      report: parseJson(r.report),
      createdAt: r.created_at as string,
    };
  }
}

/** Open (or create) the database at `path`, apply migrations, and return a Repository.
 * A file-backed database has its parent directory created first so a fresh workspace
 * (e.g. the server and worker sharing an on-disk db) opens cleanly instead of failing
 * with an opaque "unable to open database file". */
export function createRepository(path: string, clock: RepoClock = realClock): Repository {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return new Repository(db, clock);
}
