import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPolicy } from "../src/permissions/policy.js";
import { runAgentCli } from "../src/agent/cli.js";
import { reviewPublishingProbe } from "../src/capabilities/probes.js";
import { appendVersion, listVersions } from "../src/workflow/versions.js";
import { decideReview, submitForReview } from "../src/workflow/review.js";
import { disabledPublishingAdapter, publish, receiptPath, type PublishingAdapter } from "../src/workflow/publishing.js";

const NOW = new Date("2026-07-28T12:00:00.000Z"); const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fx() { const root = mkdtempSync(join(tmpdir(), "oct-publish-")); roots.push(root); const projectRoot = join(root, "project"); const stateRoot = join(root, "state"); mkdirSync(projectRoot); writeFileSync(join(projectRoot, "plan.json"), "{}\n"); const store = { projectRoot, stateRoot, now: NOW }; const draft = appendVersion(store, { projectId: "p", creator: "e", planPath: "plan.json", status: "draft", parentVersionId: null }); const review = submitForReview(store, { role: "editor", projectId: "p", versionId: draft.id, submittedBy: "e" }); const version = decideReview(store, { role: "approver", projectId: "p", decision: { format: "octupie-workflow-review-decision/v1", versionId: review.id, approved: true, approver: "a", role: "approver", decidedAt: NOW.toISOString() } }).version; const request = { format: "octupie-workflow-publish-request/v1", versionId: version.id, projectId: "p", adapterId: "test", requestedBy: "pub", role: "publisher", rightsConfirmed: true, qaPassed: true, idempotencyKey: "once", requestedAt: NOW.toISOString(), params: { caption: "hello" } }; const policy = createPolicy([{ action: "publishing", grantedBy: "operator", grantedAt: NOW.toISOString() }]); return { root, store, version, request, policy, noPolicy: createPolicy([]) }; }
function adapter(counter: { n: number }, output: unknown = { ok: true, providerRef: "post-1", data: { url: "https://example.invalid/post" } }): PublishingAdapter { return { id: "test", enabled: true, async publish() { counter.n++; return output as never; } }; }

describe("publishing is gated and disabled by default", () => {
  it("the shipped adapter blocks without invocation or network", async () => { const f = fx(); const r = await publish({ request: { ...f.request, adapterId: "disabled" }, store: f.store, policy: f.policy, adapter: disabledPublishingAdapter, now: NOW }); expect(r).toMatchObject({ status: "blocked", gate: "adapter-disabled" }); });
  it.each([
    ["approval", (f: ReturnType<typeof fx>) => { const draft = appendVersion(f.store, { projectId: "p", creator: "e", planPath: "plan.json", status: "draft", parentVersionId: f.version.id }); return { ...f.request, versionId: draft.id }; }, (f: ReturnType<typeof fx>) => f.policy],
    ["rbac", (f: ReturnType<typeof fx>) => ({ ...f.request, role: "editor" }), (f: ReturnType<typeof fx>) => f.policy],
    ["permission", (f: ReturnType<typeof fx>) => f.request, (f: ReturnType<typeof fx>) => f.noPolicy],
    ["rights", (f: ReturnType<typeof fx>) => ({ ...f.request, rightsConfirmed: false }), (f: ReturnType<typeof fx>) => f.policy],
    ["qa", (f: ReturnType<typeof fx>) => ({ ...f.request, qaPassed: false }), (f: ReturnType<typeof fx>) => f.policy],
  ])("blocks %s before adapter invocation", async (gate, makeRequest, makePolicy) => { const f = fx(); const calls = { n: 0 }; const r = await publish({ request: makeRequest(f), store: f.store, policy: makePolicy(f), adapter: adapter(calls), now: NOW }); expect(r.gate).toBe(gate); expect(calls.n).toBe(0); });
  it("writes one immutable receipt on valid success and blocks duplicate idempotency", async () => { const f = fx(); const calls = { n: 0 }; const a = adapter(calls); const first = await publish({ request: f.request, store: f.store, policy: f.policy, adapter: a, now: NOW }); expect(first.status).toBe("published"); expect(JSON.parse(readFileSync(receiptPath(f.store.stateRoot, "p", "once"), "utf8")).providerRef).toBe("post-1"); expect(listVersions(f.store, "p")).toHaveLength(3); const second = await publish({ request: f.request, store: f.store, policy: f.policy, adapter: a, now: NOW }); expect(second.gate).toBe("idempotency"); expect(calls.n).toBe(1); });
  it("rejects malformed provider data and never executes it", async () => { const f = fx(); let executed = false; const calls = { n: 0 }; const output = { ok: true, data: { get execute() { executed = true; return "bad"; } } }; const r = await publish({ request: f.request, store: f.store, policy: f.policy, adapter: adapter(calls, output), now: NOW }); expect(r).toMatchObject({ status: "failed", gate: "adapter-output" }); expect(executed).toBe(false); expect(calls.n).toBe(1); });
});

describe("workflow CLI and capability probe", () => {
  it("requires explicit CLI publish grant before invoking publish", async () => { const f = fx(); const reqPath = join(f.root, "request.json"); writeFileSync(reqPath, JSON.stringify(f.request)); let calls = 0; const errors: string[] = []; const code = await runAgentCli(["workflow-publish", reqPath], { publishWorkflow: async () => { calls++; throw new Error("never"); }, errorLog: (s) => errors.push(s) }); expect(code).toBe(2); expect(calls).toBe(0); expect(errors.join(" ")).toContain("allow-publish"); });
  it("exposes default-deny authorization and configured but unverified probe", async () => { const logs: string[] = []; expect(await runAgentCli(["workflow-authorize", "publisher", "publish"], { log: (s) => logs.push(s) })).toBe(0); expect(await runAgentCli(["workflow-authorize", "editor", "publish"], { log: () => {} })).toBe(1); expect(await reviewPublishingProbe()()).toMatchObject({ status: "configured" }); });
});
