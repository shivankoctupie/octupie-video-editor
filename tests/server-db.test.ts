import { afterEach, describe, expect, it } from "vitest";
import { createRepository, type Repository } from "../src/server/db/index.js";

/** A fixed, monotonic clock so timestamps are deterministic and ordering is stable. */
function fixedClock(startMs = Date.parse("2026-08-01T00:00:00.000Z")) {
  let t = startMs;
  return { now: () => new Date((t += 1000)).toISOString() };
}

const repos: Repository[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});

function fx(): Repository {
  // An in-memory database is created and migrated fresh per test.
  const repo = createRepository(":memory:", fixedClock());
  repos.push(repo);
  repo.createTenant({ id: "t1", name: "Tenant One" });
  repo.createTenant({ id: "t2", name: "Tenant Two" });
  return repo;
}

describe("repository: tenants and users", () => {
  it("creates and reads a tenant, returns null for a missing one", () => {
    const r = fx();
    expect(r.getTenant("t1")?.name).toBe("Tenant One");
    expect(r.getTenant("nope")).toBeNull();
  });

  it("looks a user up by token hash within a tenant and rejects a wrong hash", () => {
    const r = fx();
    r.createUser({ id: "u1", tenantId: "t1", username: "editor", role: "editor", tokenSha256: "a".repeat(64) });
    const found = r.getUserByTokenHash("a".repeat(64));
    expect(found?.id).toBe("u1");
    expect(found?.role).toBe("editor");
    expect(r.getUserByTokenHash("b".repeat(64))).toBeNull();
  });

  it("stores values through bound parameters so quotes cannot inject SQL", () => {
    const r = fx();
    const nasty = "Robert'); DROP TABLE projects;--";
    r.createProject({ id: "p-inj", tenantId: "t1", name: nasty, createdBy: "u1" });
    expect(r.getProject("t1", "p-inj")?.name).toBe(nasty);
    // The table still exists and other rows are unaffected.
    expect(r.listProjects("t1")).toHaveLength(1);
  });
});

describe("repository: project tenant isolation", () => {
  it("scopes projects to their tenant", () => {
    const r = fx();
    r.createProject({ id: "p1", tenantId: "t1", name: "A", createdBy: "u1" });
    r.createProject({ id: "p2", tenantId: "t2", name: "B", createdBy: "u2" });
    expect(r.listProjects("t1").map((p) => p.id)).toEqual(["p1"]);
    expect(r.getProject("t2", "p1")).toBeNull();
  });
});

describe("repository: immutable monotonic versions", () => {
  it("assigns 1..N per project and never mutates an existing row", () => {
    const r = fx();
    r.createProject({ id: "p1", tenantId: "t1", name: "A", createdBy: "u1" });
    const v1 = r.appendVersion({ id: "v1", tenantId: "t1", projectId: "p1", parentVersionId: null, planPath: "plan.json", planSha256: "1".repeat(64), creator: "u1", status: "draft" });
    const v2 = r.appendVersion({ id: "v2", tenantId: "t1", projectId: "p1", parentVersionId: "v1", planPath: "plan2.json", planSha256: "2".repeat(64), creator: "u1", status: "draft" });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(r.latestVersion("t1", "p1")?.id).toBe("v2");
    // Re-using a version id is refused (immutability / uniqueness).
    expect(() => r.appendVersion({ id: "v1", tenantId: "t1", projectId: "p1", parentVersionId: null, planPath: "x.json", planSha256: "3".repeat(64), creator: "u1", status: "draft" })).toThrow();
    // There is no update path: only these two versions exist.
    expect(r.listVersions("t1", "p1")).toHaveLength(2);
  });
});

describe("repository: frame comments with resolved state", () => {
  it("stores a comment against a version with its anchor and resolves it", () => {
    const r = fx();
    r.createProject({ id: "p1", tenantId: "t1", name: "A", createdBy: "u1" });
    r.appendVersion({ id: "v1", tenantId: "t1", projectId: "p1", parentVersionId: null, planPath: "plan.json", planSha256: "1".repeat(64), creator: "u1", status: "draft" });
    const c = r.addComment({ id: "c1", tenantId: "t1", projectId: "p1", versionId: "v1", frame: 42, timeSec: 1.4, author: "u1", body: "fix the cut" });
    expect(c.resolved).toBe(false);
    const list = r.listComments("t1", "p1", "v1");
    expect(list).toHaveLength(1);
    expect(list[0]!.frame).toBe(42);
    expect(list[0]!.timeSec).toBeCloseTo(1.4);
    const resolved = r.resolveComment({ tenantId: "t1", commentId: "c1", resolvedBy: "u2" });
    expect(resolved.resolved).toBe(true);
    expect(r.listComments("t1", "p1", "v1")[0]!.resolved).toBe(true);
  });
});

describe("repository: review decisions append a new immutable version", () => {
  it("records an approval as a new approved version and leaves the source untouched", () => {
    const r = fx();
    r.createProject({ id: "p1", tenantId: "t1", name: "A", createdBy: "u1" });
    r.appendVersion({ id: "v1", tenantId: "t1", projectId: "p1", parentVersionId: null, planPath: "plan.json", planSha256: "1".repeat(64), creator: "u1", status: "in-review" });
    const out = r.recordDecision({ id: "d1", tenantId: "t1", projectId: "p1", versionId: "v1", approved: true, approver: "boss", role: "approver", notes: "ship it" });
    expect(out.version.status).toBe("approved");
    expect(out.version.version).toBe(2);
    expect(out.decision.approved).toBe(true);
    // Source version is unchanged.
    expect(r.getVersion("t1", "p1", "v1")?.status).toBe("in-review");
  });

  it("refuses a second decision on the same in-review source (only one wins)", () => {
    const r = fx();
    r.createProject({ id: "p1", tenantId: "t1", name: "A", createdBy: "u1" });
    r.appendVersion({ id: "v1", tenantId: "t1", projectId: "p1", parentVersionId: null, planPath: "plan.json", planSha256: "1".repeat(64), creator: "u1", status: "in-review" });
    const first = r.recordDecision({ id: "d1", tenantId: "t1", projectId: "p1", versionId: "v1", approved: true, approver: "boss", role: "approver" });
    expect(first.version.status).toBe("approved");
    // A second decision on the same source is refused, so no duplicate child version appears.
    expect(() => r.recordDecision({ id: "d2", tenantId: "t1", projectId: "p1", versionId: "v1", approved: false, approver: "other", role: "approver" })).toThrow();
    const children = r.listVersions("t1", "p1").filter((v) => v.parentVersionId === "v1");
    expect(children).toHaveLength(1);
    expect(children[0]!.status).toBe("approved");
  });
});

describe("repository: idempotent FIFO job queue", () => {
  it("is idempotent on idempotencyKey", () => {
    const r = fx();
    const a = r.enqueueJob({ id: "j1", tenantId: "t1", type: "render", payload: { plan: "p" }, enqueuedBy: "u1", idempotencyKey: "k1" });
    const b = r.enqueueJob({ id: "j2", tenantId: "t1", type: "render", payload: { plan: "p" }, enqueuedBy: "u1", idempotencyKey: "k1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe("j1");
    expect(r.listJobs("t1")).toHaveLength(1);
  });

  it("claims oldest-first, exactly once, and drains to null", () => {
    const r = fx();
    r.enqueueJob({ id: "j1", tenantId: "t1", type: "render", payload: {}, enqueuedBy: "u1" });
    r.enqueueJob({ id: "j2", tenantId: "t1", type: "qa", payload: {}, enqueuedBy: "u1" });
    const first = r.claimNextJob({});
    const second = r.claimNextJob({});
    const third = r.claimNextJob({});
    expect(first?.id).toBe("j1");
    expect(first?.status).toBe("running");
    expect(first?.attempts).toBe(1);
    expect(second?.id).toBe("j2");
    expect(third).toBeNull();
  });

  it("completes and fails running jobs and records attempts", () => {
    const r = fx();
    r.enqueueJob({ id: "j1", tenantId: "t1", type: "render", payload: {}, enqueuedBy: "u1" });
    const claimed = r.claimNextJob({})!;
    r.recordAttempt({ jobId: claimed.id, attempt: 1, status: "running", startedAt: "2026-08-01T00:00:05.000Z" });
    const done = r.completeJob({ tenantId: "t1", jobId: claimed.id });
    expect(done.status).toBe("succeeded");
    expect(r.listAttempts("j1")).toHaveLength(1);
    // Cannot complete a job that is not running.
    expect(() => r.completeJob({ tenantId: "t1", jobId: claimed.id })).toThrow();
  });

  it("scopes jobs by tenant", () => {
    const r = fx();
    r.enqueueJob({ id: "j1", tenantId: "t1", type: "render", payload: {}, enqueuedBy: "u1" });
    r.enqueueJob({ id: "j2", tenantId: "t2", type: "render", payload: {}, enqueuedBy: "u2" });
    expect(r.listJobs("t1").map((j) => j.id)).toEqual(["j1"]);
    const claimed = r.claimNextJob({ tenantId: "t2" });
    expect(claimed?.id).toBe("j2");
  });
});

describe("repository: bounded job retries", () => {
  it("requeues a failed job below max_attempts and only fails terminally at the cap", () => {
    const r = fx();
    r.enqueueJob({ id: "j1", tenantId: "t1", type: "render", payload: {}, enqueuedBy: "u1", maxAttempts: 3 });
    let claimed = r.claimNextJob({})!;
    expect(claimed.attempts).toBe(1);
    let after = r.failJob({ tenantId: "t1", jobId: "j1", detail: "boom-1" });
    expect(after.status).toBe("queued"); // below cap -> requeued
    expect(after.attempts).toBe(1);
    expect(after.failureDetail).toBe("boom-1");

    claimed = r.claimNextJob({})!;
    expect(claimed.id).toBe("j1");
    expect(claimed.attempts).toBe(2);
    after = r.failJob({ tenantId: "t1", jobId: "j1", detail: "boom-2" });
    expect(after.status).toBe("queued");

    claimed = r.claimNextJob({})!;
    expect(claimed.attempts).toBe(3);
    after = r.failJob({ tenantId: "t1", jobId: "j1", detail: "boom-3" });
    expect(after.status).toBe("failed"); // at cap -> terminal
    expect(after.attempts).toBe(3);
    expect(after.failureDetail).toBe("boom-3");
    // A terminally failed job is not re-claimable; the queue drains.
    expect(r.claimNextJob({})).toBeNull();
  });

  it("fails terminally on the first failure when max_attempts is 1", () => {
    const r = fx();
    r.enqueueJob({ id: "j1", tenantId: "t1", type: "render", payload: {}, enqueuedBy: "u1", maxAttempts: 1 });
    const claimed = r.claimNextJob({})!;
    expect(claimed.attempts).toBe(1);
    const after = r.failJob({ tenantId: "t1", jobId: "j1", detail: "boom" });
    expect(after.status).toBe("failed");
    expect(r.claimNextJob({})).toBeNull();
  });

  it("preserves FIFO position and idempotency across a requeue", () => {
    const r = fx();
    r.enqueueJob({ id: "j1", tenantId: "t1", type: "render", payload: {}, enqueuedBy: "u1", idempotencyKey: "k1", maxAttempts: 3 });
    r.enqueueJob({ id: "j2", tenantId: "t1", type: "render", payload: {}, enqueuedBy: "u1" });
    expect(r.claimNextJob({})!.id).toBe("j1");
    r.failJob({ tenantId: "t1", jobId: "j1", detail: "x" }); // requeue
    // j1 keeps its original created_at, so it stays the oldest and is re-claimed first.
    expect(r.claimNextJob({})!.id).toBe("j1");
    // Its idempotency key survives the requeue: a duplicate enqueue still dedupes to j1.
    const dup = r.enqueueJob({ id: "j9", tenantId: "t1", type: "render", payload: {}, enqueuedBy: "u1", idempotencyKey: "k1" });
    expect(dup.created).toBe(false);
    expect(dup.job.id).toBe("j1");
  });

  it("refuses to fail a job that is not running", () => {
    const r = fx();
    r.enqueueJob({ id: "j1", tenantId: "t1", type: "render", payload: {}, enqueuedBy: "u1" });
    expect(() => r.failJob({ tenantId: "t1", jobId: "j1", detail: "x" })).toThrow();
  });
});

describe("repository: idempotent receipts and audit", () => {
  it("refuses a duplicate receipt for the same adapter and key", () => {
    const r = fx();
    const a = r.createReceipt({ id: "r1", tenantId: "t1", projectId: "p1", versionId: "v1", adapterId: "webhook", idempotencyKey: "k1", publishedBy: "u1", providerRef: "ext-1", data: { ok: true } });
    const b = r.createReceipt({ id: "r2", tenantId: "t1", projectId: "p1", versionId: "v1", adapterId: "webhook", idempotencyKey: "k1", publishedBy: "u1", data: {} });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.receipt.id).toBe("r1");
  });

  it("appends and lists audit events newest-first", () => {
    const r = fx();
    r.appendAudit({ tenantId: "t1", actor: "u1", action: "project.create", subject: "p1" });
    r.appendAudit({ tenantId: "t1", actor: "u1", action: "version.append", subject: "v1" });
    const events = r.listAudit("t1");
    expect(events).toHaveLength(2);
    expect(events[0]!.action).toBe("version.append");
  });
});
