import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorize } from "../src/workflow/rbac.js";
import { appendVersion, listVersions, loadVersion, versionRecordPath } from "../src/workflow/versions.js";
import { decideReview, submitForReview } from "../src/workflow/review.js";
import { WORKFLOW_ACTIONS, WORKFLOW_ROLES } from "../src/workflow/schemas.js";

const NOW = new Date("2026-07-28T12:00:00.000Z"); const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fx() { const root = mkdtempSync(join(tmpdir(), "oct-workflow-")); roots.push(root); mkdirSync(join(root, "project")); writeFileSync(join(root, "project", "plan.json"), "{\"ok\":true}\n"); writeFileSync(join(root, "project", "master.mp4"), "fake-master-bytes"); return { root, projectRoot: join(root, "project"), stateRoot: join(root, "state"), now: NOW }; }

describe("workflow RBAC", () => {
  it("matches the complete default-deny role matrix", () => {
    const expected: Record<string, string[]> = { viewer: ["view"], editor: ["view", "edit", "submit-review"], approver: ["view", "decide-review"], publisher: ["view", "publish"], admin: [...WORKFLOW_ACTIONS] };
    for (const role of WORKFLOW_ROLES) for (const action of WORKFLOW_ACTIONS) expect(authorize(role, action), `${role}:${action}`).toBe(expected[role]!.includes(action));
    expect(authorize("owner", "publish")).toBe(false); expect(authorize("admin", "root")).toBe(false);
  });
});

describe("immutable versions and human review", () => {
  it("creates immutable monotonic versions with real hashes and rejects stale parents", () => {
    const c = fx(); const v1 = appendVersion(c, { projectId: "p", creator: "e", planPath: "plan.json", masterPath: "master.mp4", status: "draft", parentVersionId: null, expectedRevision: 0 });
    const recordBefore = readFileSync(versionRecordPath(c.stateRoot, "p", v1.id), "utf8");
    expect(v1.version).toBe(1); expect(v1.planSha256).toMatch(/^[0-9a-f]{64}$/);
    const v2 = appendVersion(c, { projectId: "p", creator: "e", planPath: "plan.json", status: "draft", parentVersionId: v1.id, expectedRevision: 1 }); expect(v2.version).toBe(2);
    expect(() => appendVersion(c, { projectId: "p", creator: "e", planPath: "plan.json", status: "draft", parentVersionId: v1.id })).toThrow(/Stale parent/);
    expect(readFileSync(versionRecordPath(c.stateRoot, "p", v1.id), "utf8")).toBe(recordBefore);
  });
  it("refuses direct approval without an authorized review transition", () => {
    const c = fx();
    expect(() => appendVersion(c, { projectId: "p", creator: "x", planPath: "plan.json", status: "approved", parentVersionId: null })).toThrow(/transition/i);
  });
  it.each(["../plan.json", "/tmp/plan.json", "C:/plan.json"])("rejects unsafe reference %s", (planPath) => { const c = fx(); expect(() => appendVersion(c, { projectId: "p", creator: "e", planPath, status: "draft", parentVersionId: null })).toThrow(); });
  it("submits and decides by appending new records, blocks wrong role and duplicate decisions", () => {
    const c = fx(); const v1 = appendVersion(c, { projectId: "p", creator: "e", planPath: "plan.json", status: "draft", parentVersionId: null });
    expect(() => submitForReview(c, { role: "viewer", projectId: "p", versionId: v1.id, submittedBy: "v" })).toThrow();
    const inReview = submitForReview(c, { role: "editor", projectId: "p", versionId: v1.id, submittedBy: "e" }); expect(inReview.status).toBe("in-review");
    const decision = { format: "octupie-workflow-review-decision/v1", versionId: inReview.id, approved: true, approver: "a", role: "approver", decidedAt: NOW.toISOString() };
    expect(() => decideReview(c, { role: "editor", projectId: "p", decision })).toThrow();
    const approved = decideReview(c, { role: "approver", projectId: "p", decision }).version; expect(approved.status).toBe("approved"); expect(loadVersion(c, "p", inReview.id).status).toBe("in-review");
    expect(() => decideReview(c, { role: "approver", projectId: "p", decision })).toThrow(); expect(listVersions(c, "p")).toHaveLength(3);
  });
});
