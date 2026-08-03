/**
 * Job worker. Rendering is CPU heavy and downloads a browser shell on first use, so it
 * never runs on the request path. The worker claims the oldest queued job in a write
 * transaction (so a job is claimed exactly once even with several workers), runs a
 * type-specific runner, then records the outcome and one attempt row. The default render
 * runner invokes the existing deterministic `renderPlan` pipeline, which renders, mixes
 * audio, muxes, and QAs the exact master. Runners are injectable so the worker lifecycle
 * is tested offline without FFmpeg.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEditPlan, type EditPlan } from "../schema/editPlan.js";
import { renderPlan, type PipelineResult } from "../pipeline.js";
import { prepareRenderAssets } from "./renderAssets.js";
import { readPlan } from "./plans.js";
import { createRepository, type RepoClock } from "./db/repository.js";
import { createLocalStorage } from "./storage/local.js";
import type { JobType } from "../workflow/schemas.js";
import type { JobRow, Repository } from "./db/repository.js";
import type { StorageAdapter } from "./storage/adapter.js";
import type { ServerConfig } from "./config.js";

export interface JobOutcome {
  ok: boolean;
  detail?: string;
  /** When a job produced a QA report, it is persisted against its version. */
  qa?: { versionId: string; pass: boolean; report: Record<string, unknown> };
}

export type JobRunner = (job: JobRow, deps: WorkerDeps) => Promise<JobOutcome>;

export interface WorkerDeps {
  repo: Repository;
  storage: StorageAdapter;
  config: ServerConfig;
  runners: Partial<Record<JobType, JobRunner>>;
  now: () => string;
  log?: (message: string) => void;
}

/** Claim and run one job. Returns the job after its post-run transition (succeeded,
 * failed, or requeued for another attempt when below the cap), or null when the queue is
 * empty. */
export async function runWorkerOnce(deps: WorkerDeps): Promise<JobRow | null> {
  const job = deps.repo.claimNextJob({});
  if (!job) return null;
  const startedAt = deps.now();
  deps.log?.(`claim ${job.id} (${job.type}) attempt ${job.attempts}`);
  const runner = deps.runners[job.type];
  let outcome: JobOutcome;
  try {
    if (!runner) throw new Error(`No runner registered for job type '${job.type}'.`);
    outcome = await runner(job, deps);
  } catch (err) {
    outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  if (outcome.ok) {
    if (outcome.qa && job.projectId) {
      deps.repo.putQaReport({ id: `qa-${randomUUID()}`, tenantId: job.tenantId, projectId: job.projectId, versionId: outcome.qa.versionId, pass: outcome.qa.pass, report: outcome.qa.report });
    }
    deps.repo.completeJob({ tenantId: job.tenantId, jobId: job.id });
    deps.repo.recordAttempt({ jobId: job.id, attempt: job.attempts, status: "succeeded", startedAt, finishedAt: deps.now(), ...(outcome.detail ? { detail: outcome.detail } : {}) });
    deps.log?.(`done ${job.id}`);
  } else {
    // failJob applies bounded retries: below max_attempts the job is requeued, and only at
    // the cap is the failure terminal. The attempt row is recorded either way.
    const failed = deps.repo.failJob({ tenantId: job.tenantId, jobId: job.id, detail: outcome.detail ?? "job failed" });
    deps.repo.recordAttempt({ jobId: job.id, attempt: job.attempts, status: "failed", startedAt, finishedAt: deps.now(), detail: outcome.detail ?? "job failed" });
    const verb = failed.status === "queued" ? "requeue" : "fail";
    deps.log?.(`${verb} ${job.id} (attempt ${job.attempts}/${job.maxAttempts}): ${outcome.detail ?? ""}`);
  }
  return deps.repo.getJob(job.tenantId, job.id);
}

export interface WorkerLoopOptions {
  intervalMs?: number;
  /** Stop after this many consecutive empty polls (0 = run until shouldStop). */
  maxIdlePolls?: number;
  shouldStop?: () => boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll and drain the queue until asked to stop or the idle cap is reached. */
export async function runWorkerLoop(deps: WorkerDeps, opts: WorkerLoopOptions = {}): Promise<void> {
  const intervalMs = opts.intervalMs ?? 1000;
  let idle = 0;
  while (!(opts.shouldStop?.() ?? false)) {
    const job = await runWorkerOnce(deps);
    if (job) {
      idle = 0;
      continue;
    }
    idle += 1;
    if (opts.maxIdlePolls && idle >= opts.maxIdlePolls) return;
    await sleep(intervalMs);
  }
}

/** The signature of the deterministic render pipeline. Injectable so the worker's asset
 * preparation and job lifecycle can be tested without executing a full Remotion render. */
export type PlanRenderer = (plan: EditPlan, opts?: { dir?: string; onStep?: (msg: string) => void }) => Promise<PipelineResult>;

/**
 * The default render runner: load the version's plan, prepare an isolated per-version asset
 * root that resolves the plan's media out of storage, then run the real deterministic
 * pipeline (render, audio, mux, QA) against that root. The QA report is returned for
 * persistence. Other job types have no default runner and fail with a clear message until one
 * is registered.
 */
export function renderRunner(render: PlanRenderer = renderPlan): JobRunner {
  return async (job, deps) => {
    if (!job.projectId) return { ok: false, detail: "render job has no project" };
    const versionId = typeof job.payload.versionId === "string" ? job.payload.versionId : undefined;
    const version = versionId
      ? deps.repo.getVersion(job.tenantId, job.projectId, versionId)
      : deps.repo.latestVersion(job.tenantId, job.projectId);
    if (!version) return { ok: false, detail: "no version to render" };
    const parsed = parseEditPlan(readPlan(deps.config.storageRoot, version.planPath));
    if (!parsed.ok || !parsed.plan) return { ok: false, detail: `invalid plan: ${parsed.errors.join("; ")}` };

    // Prepare an isolated asset root under this immutable version's render dir: resolve every
    // media reference ONLY against this project's media rows, copy the real bytes in under safe
    // server-derived names, and rewrite a clone of the plan to match. The stored plan is never
    // mutated, and no plan path can reach outside the prepared root or into another tenant.
    const dir = join(deps.config.storageRoot, job.tenantId, job.projectId, "renders", version.id);
    const assetsDir = join(dir, "assets");
    const mediaRows = deps.repo.listMedia(job.tenantId, job.projectId);
    const prepared = await prepareRenderAssets({
      plan: parsed.plan,
      tenantId: job.tenantId,
      projectId: job.projectId,
      mediaRows,
      storage: deps.storage,
      destRoot: assetsDir,
    });

    // The pipeline resolves plan paths under OVE_ASSET_ROOT. The worker loop claims and runs one
    // job at a time per process, so this global is set and restored around a single render with
    // no overlap; separate worker processes each own their own environment.
    const prev = process.env.OVE_ASSET_ROOT;
    process.env.OVE_ASSET_ROOT = prepared.assetRoot;
    try {
      const result = await render(prepared.plan, { dir, onStep: (m) => deps.log?.(m) });
      return {
        ok: result.report.pass,
        detail: `render+qa ${result.report.pass ? "PASS" : "FAIL"}`,
        qa: { versionId: version.id, pass: result.report.pass, report: result.report as unknown as Record<string, unknown> },
      };
    } finally {
      if (prev === undefined) delete process.env.OVE_ASSET_ROOT;
      else process.env.OVE_ASSET_ROOT = prev;
      // The prepared inputs are transient; the render outputs live in `dir` and are kept.
      try {
        rmSync(assetsDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup; never mask a render error */
      }
    }
  };
}

export function defaultRunners(render: PlanRenderer = renderPlan): Partial<Record<JobType, JobRunner>> {
  const runner = renderRunner(render);
  // QA in this pipeline is produced as part of a render, so a qa job re-runs the same
  // deterministic render+QA path against the version's plan.
  return { render: runner, qa: runner };
}

export interface WorkerRuntimeOptions {
  clock?: RepoClock;
  storage?: StorageAdapter;
  runners?: Partial<Record<JobType, JobRunner>>;
  log?: (message: string) => void;
}

/**
 * Assemble a self-contained worker from a server config: its own repository handle over
 * the same SQLite database the server writes to, local content-addressed storage, and
 * the default render/QA runners. `close()` is a clean shutdown of the repository handle.
 * Server and worker run as separate processes over a shared on-disk database; an
 * in-memory database cannot be shared, so the worker command needs a file `dbPath`.
 */
export function createWorkerRuntime(config: ServerConfig, opts: WorkerRuntimeOptions = {}): { deps: WorkerDeps; close: () => void } {
  const clock: RepoClock = opts.clock ?? { now: () => new Date().toISOString() };
  const repo = createRepository(config.dbPath, clock);
  const storage = opts.storage ?? createLocalStorage(config.storageRoot);
  const deps: WorkerDeps = {
    repo,
    storage,
    config,
    runners: opts.runners ?? defaultRunners(),
    now: () => clock.now(),
    ...(opts.log ? { log: opts.log } : {}),
  };
  return { deps, close: () => repo.close() };
}
