/**
 * File-backed job queue (parity phase 8).
 *
 * A job is DATA: a bounded type, status, attempt counter, timestamps, and an opaque
 * bounded payload the queue NEVER interprets or executes. The whole queue is one
 * atomic state file, so every transition is crash-safe. Enqueue requires the RBAC
 * action that matches the job type and is idempotent on `idempotencyKey`. Claim is
 * the only queued -> running transition and always picks the oldest queued job
 * (FIFO). complete/fail validate that a job is running; retry re-queues a failed job
 * only while attempts remain under the max. Illegal transitions are refused.
 */

import { join, resolve } from "node:path";
import { requireAuthorized } from "./rbac.js";
import {
  defaultWorkflowFs,
  readJsonState,
  WorkflowStoreError,
  writeJsonState,
  type WorkflowFs,
} from "./store.js";
import {
  JOB_FORMAT,
  MAX_ATTEMPTS,
  parseQueueState,
  QUEUE_STATE_FORMAT,
  type JobType,
  type JobValue,
  type QueueStateValue,
  type WorkflowAction,
  type WorkflowRole,
} from "./schemas.js";

/** Job type -> the RBAC action an enqueue requires. Publishing is gated harder than editing. */
const JOB_TYPE_ACTION: Readonly<Record<JobType, WorkflowAction>> = {
  analyze: "edit",
  plan: "edit",
  render: "edit",
  qa: "edit",
  publish: "publish",
};

/** Thrown for an illegal queue transition. */
export class QueueTransitionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "QueueTransitionError";
    this.code = code;
  }
}

export interface QueueContext {
  stateRoot: string;
  fs?: WorkflowFs;
  now?: Date;
}

export function queueStatePath(stateRoot: string): string {
  return join(resolve(stateRoot), "queue", "state.json");
}

function loadState(ctx: QueueContext): { state: QueueStateValue; fs: WorkflowFs } {
  const fs = ctx.fs ?? defaultWorkflowFs;
  const raw = readJsonState(queueStatePath(ctx.stateRoot), fs);
  if (raw === null) {
    return { state: { format: QUEUE_STATE_FORMAT, seq: 0, jobs: [] }, fs };
  }
  const parsed = parseQueueState(raw);
  if (!parsed.ok || !parsed.data) {
    throw new WorkflowStoreError("bad-queue", `Queue state is corrupt: ${parsed.errors.join("; ")}`);
  }
  return { state: parsed.data, fs };
}

function saveState(ctx: QueueContext, state: QueueStateValue, fs: WorkflowFs): void {
  const validated = parseQueueState(state);
  if (!validated.ok || !validated.data) {
    throw new WorkflowStoreError("bad-queue", `Refusing to write invalid queue state: ${validated.errors.join("; ")}`);
  }
  writeJsonState(queueStatePath(ctx.stateRoot), validated.data, fs);
}

export interface EnqueueInput {
  role: WorkflowRole;
  type: JobType;
  payload: Record<string, unknown>;
  enqueuedBy: string;
  idempotencyKey?: string;
}

/**
 * Enqueue a job. Requires the RBAC action matching the job type. Idempotent: if a
 * job with the same `idempotencyKey` already exists, that job is returned unchanged
 * and nothing new is written.
 */
export function enqueue(ctx: QueueContext, input: EnqueueInput): { job: JobValue; created: boolean } {
  requireAuthorized(input.role, JOB_TYPE_ACTION[input.type]);
  const now = ctx.now ?? new Date();
  const { state, fs } = loadState(ctx);

  if (input.idempotencyKey !== undefined) {
    const existing = state.jobs.find((j) => j.idempotencyKey === input.idempotencyKey);
    if (existing) return { job: existing, created: false };
  }

  const seq = state.seq + 1;
  const job: JobValue = {
    format: JOB_FORMAT,
    id: `job-${String(seq).padStart(6, "0")}`,
    type: input.type,
    status: "queued",
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    payload: input.payload,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    enqueuedBy: input.enqueuedBy,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const next: QueueStateValue = { ...state, seq, jobs: [...state.jobs, job] };
  saveState(ctx, next, fs);
  return { job, created: true };
}

/** List jobs, optionally filtered by status. Read-only. */
export function listJobs(ctx: QueueContext, opts: { status?: JobValue["status"] } = {}): JobValue[] {
  const { state } = loadState(ctx);
  return opts.status ? state.jobs.filter((j) => j.status === opts.status) : [...state.jobs];
}

function mutate(ctx: QueueContext, id: string, fn: (job: JobValue, now: Date) => JobValue): JobValue {
  const now = ctx.now ?? new Date();
  const { state, fs } = loadState(ctx);
  const idx = state.jobs.findIndex((j) => j.id === id);
  if (idx < 0) throw new QueueTransitionError("no-job", `No job '${id}'.`);
  const updated = fn(state.jobs[idx]!, now);
  const jobs = state.jobs.slice();
  jobs[idx] = updated;
  saveState(ctx, { ...state, jobs }, fs);
  return updated;
}

/**
 * Claim the next job: the OLDEST queued job (FIFO), atomically transitioned to
 * running with its attempt counter incremented. Returns null when nothing is
 * queued. This is the only queued -> running transition.
 */
export function claimNext(ctx: QueueContext): JobValue | null {
  const now = ctx.now ?? new Date();
  const { state, fs } = loadState(ctx);
  const idx = state.jobs.findIndex((j) => j.status === "queued");
  if (idx < 0) return null;
  const job = state.jobs[idx]!;
  const running: JobValue = { ...job, status: "running", attempts: job.attempts + 1, updatedAt: now.toISOString() };
  const jobs = state.jobs.slice();
  jobs[idx] = running;
  saveState(ctx, { ...state, jobs }, fs);
  return running;
}

/** Complete a running job. Refuses any non-running source state. */
export function completeJob(ctx: QueueContext, id: string): JobValue {
  return mutate(ctx, id, (job, now) => {
    if (job.status !== "running") {
      throw new QueueTransitionError("illegal", `Cannot complete job '${id}' from status '${job.status}'.`);
    }
    return { ...job, status: "succeeded", updatedAt: now.toISOString() };
  });
}

/** Fail a running job. Refuses any non-running source state. */
export function failJob(ctx: QueueContext, id: string, detail: string): JobValue {
  return mutate(ctx, id, (job, now) => {
    if (job.status !== "running") {
      throw new QueueTransitionError("illegal", `Cannot fail job '${id}' from status '${job.status}'.`);
    }
    return { ...job, status: "failed", failureDetail: detail.slice(0, 4000), updatedAt: now.toISOString() };
  });
}

/** Cancel a queued or running job. Terminal states cannot be cancelled. */
export function cancelJob(ctx: QueueContext, id: string): JobValue {
  return mutate(ctx, id, (job, now) => {
    if (job.status !== "queued" && job.status !== "running") {
      throw new QueueTransitionError("illegal", `Cannot cancel job '${id}' from status '${job.status}'.`);
    }
    return { ...job, status: "cancelled", updatedAt: now.toISOString() };
  });
}

/** Retry a failed job by re-queuing it, only while attempts remain under the max. */
export function retryJob(ctx: QueueContext, id: string): JobValue {
  return mutate(ctx, id, (job, now) => {
    if (job.status !== "failed") {
      throw new QueueTransitionError("illegal", `Cannot retry job '${id}' from status '${job.status}'.`);
    }
    if (job.attempts >= job.maxAttempts) {
      throw new QueueTransitionError("max-attempts", `Job '${id}' has exhausted its ${job.maxAttempts} attempts.`);
    }
    return { ...job, status: "queued", updatedAt: now.toISOString() };
  });
}
