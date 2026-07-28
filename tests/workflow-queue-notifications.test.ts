import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cancelJob, claimNext, completeJob, enqueue, failJob, retryJob } from "../src/workflow/queue.js";
import { createFileNotificationAdapter, defaultOutboxPath } from "../src/workflow/notifications.js";

const NOW = new Date("2026-07-28T12:00:00.000Z"); const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function ctx() { const stateRoot = mkdtempSync(join(tmpdir(), "oct-queue-")); roots.push(stateRoot); return { stateRoot, now: NOW }; }

describe("data-only workflow queue", () => {
  it("is FIFO and idempotent and never interprets payload", () => { const c = ctx(); let executed = false; const payload = { command: "rm -rf .", nested: { execute: "never" } }; const a = enqueue(c, { role: "editor", type: "plan", payload, enqueuedBy: "e", idempotencyKey: "same" }); const dup = enqueue(c, { role: "editor", type: "plan", payload: {}, enqueuedBy: "e", idempotencyKey: "same" }); const b = (() => { expect(() => enqueue(c, { role: "editor", type: "qa", payload: { get run() { executed = true; return true; } }, enqueuedBy: "e" })).toThrow(); return enqueue(c, { role: "editor", type: "qa", payload: { safe: true }, enqueuedBy: "e" }); })(); expect(dup.created).toBe(false); expect(dup.job.id).toBe(a.job.id); expect(b.job.id).not.toBe(a.job.id); expect(claimNext(c)!.id).toBe(a.job.id); expect(executed).toBe(false); });
  it("enforces legal transitions and three attempts", () => { const c = ctx(); const j = enqueue(c, { role: "editor", type: "render", payload: {}, enqueuedBy: "e" }).job; expect(() => completeJob(c, j.id)).toThrow(); for (let i = 0; i < 3; i++) { const running = claimNext(c)!; expect(running.attempts).toBe(i + 1); failJob(c, j.id, "x"); if (i < 2) retryJob(c, j.id); } expect(() => retryJob(c, j.id)).toThrow(/exhausted/); expect(() => cancelJob(c, j.id)).toThrow(); });
  it("requires publish RBAC to enqueue publishing", () => { const c = ctx(); expect(() => enqueue(c, { role: "editor", type: "publish", payload: {}, enqueuedBy: "e" })).toThrow(); expect(enqueue(c, { role: "publisher", type: "publish", payload: {}, enqueuedBy: "p" }).created).toBe(true); });
});

describe("local notifications", () => {
  it("writes a bounded local outbox with no network surface", async () => { const c = ctx(); const outbox = defaultOutboxPath(c.stateRoot); const adapter = createFileNotificationAdapter({ outboxPath: outbox, now: NOW }); const record = await adapter.deliver({ format: "octupie-workflow-notification/v1", id: "n1", kind: "review", subject: "Ready", body: "Please review", createdAt: NOW.toISOString(), data: { version: 2 } }); expect(record.channel).toBe("file"); expect(readFileSync(outbox, "utf8")).toContain("Please review"); await expect(adapter.deliver({ format: "octupie-workflow-notification/v1", id: "n2", kind: "x", subject: "x", body: "x".repeat(9000), createdAt: NOW.toISOString() })).rejects.toThrow(); });
});
