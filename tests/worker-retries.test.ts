import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepository, type Repository } from "../src/server/db/index.js";
import { createLocalStorage } from "../src/server/storage/local.js";
import { defaultConfig } from "../src/server/config.js";
import { runWorkerOnce, type WorkerDeps } from "../src/server/worker.js";

/*
 * Bounded retries at the worker level. A runner that always fails must requeue the job
 * until it reaches max_attempts, then fail terminally, recording one attempt row per try.
 * This proves the worker + repository together implement real bounded retries.
 */

let t = Date.parse("2026-08-01T00:00:00.000Z");
const clock = { now: () => new Date((t += 1000)).toISOString() };

const cleanup: Array<() => void> = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

function deps(runnerOk: boolean): { deps: WorkerDeps; repo: Repository } {
  const storeRoot = mkdtempSync(join(tmpdir(), "oct-worker-retry-"));
  const repo = createRepository(":memory:", clock);
  cleanup.push(() => { repo.close(); rmSync(storeRoot, { recursive: true, force: true }); });
  const config = defaultConfig({ storageRoot: storeRoot, tempDir: storeRoot, publicDir: storeRoot });
  const workerDeps: WorkerDeps = {
    repo,
    storage: createLocalStorage(storeRoot),
    config,
    runners: { render: async () => ({ ok: runnerOk, detail: runnerOk ? "ok" : "always fails" }) },
    now: () => clock.now(),
  };
  return { deps: workerDeps, repo };
}

describe("worker bounded retries", () => {
  it("requeues a failing job until the cap, then fails terminally, one attempt row per try", async () => {
    const { deps: d, repo } = deps(false);
    repo.enqueueJob({ id: "jr", tenantId: "t1", projectId: "p1", type: "render", payload: {}, enqueuedBy: "u1", maxAttempts: 3 });

    const a = await runWorkerOnce(d);
    expect(a?.status).toBe("queued");
    expect(a?.attempts).toBe(1);
    expect(repo.listAttempts("jr")).toHaveLength(1);

    const b = await runWorkerOnce(d);
    expect(b?.status).toBe("queued");
    expect(b?.attempts).toBe(2);
    expect(repo.listAttempts("jr")).toHaveLength(2);

    const c = await runWorkerOnce(d);
    expect(c?.status).toBe("failed");
    expect(c?.attempts).toBe(3);
    const attempts = repo.listAttempts("jr");
    expect(attempts).toHaveLength(3);
    expect(attempts.every((x) => x.status === "failed")).toBe(true);

    // Nothing left to claim: the terminally failed job does not loop forever.
    expect(await runWorkerOnce(d)).toBeNull();
  });
});
