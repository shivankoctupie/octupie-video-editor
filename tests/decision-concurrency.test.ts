import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";
import { defaultConfig } from "../src/server/config.js";
import { makeStarterPlan } from "../src/presets/starter.js";
import { getPreset } from "../src/presets/index.js";

/*
 * Only one review decision may win per in-review source. Because a decision appends a new
 * immutable child version and leaves the source in-review, a naive route re-check cannot
 * stop a second decision. The guard runs inside the write transaction (plus a unique
 * index), so a second decision, sequential or concurrent, is refused with a 409 and no
 * duplicate approved/rejected child version is ever created.
 */

const TOKENS = { editor: "editor-token-0123456789abcdef", approver: "approver-token-0123456789abcdef", viewer: "viewer-token-0123456789abcdef" };

let server: RunningServer;
const roots: string[] = [];

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
  const res = await fetch(server.url + path, { method: opts.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "oct-dec-store-"));
  const tempDir = mkdtempSync(join(tmpdir(), "oct-dec-temp-"));
  const publicDir = mkdtempSync(join(tmpdir(), "oct-dec-public-"));
  roots.push(storageRoot, tempDir, publicDir);
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>Octupie Video Editor</title>");
  server = await startServer(defaultConfig({
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    storageRoot,
    tempDir,
    publicDir,
    users: [
      { id: "u-editor", tenantId: "t1", username: "editor", role: "editor", token: TOKENS.editor },
      { id: "u-approver", tenantId: "t1", username: "approver", role: "approver", token: TOKENS.approver },
      { id: "u-viewer", tenantId: "t1", username: "viewer", role: "viewer", token: TOKENS.viewer },
    ],
  }));
});

afterAll(async () => {
  await server.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

async function makeInReview(): Promise<{ projectId: string; inReviewId: string }> {
  const project = await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "Decide" } });
  const projectId = project.json.project.id;
  const plan = makeStarterPlan(getPreset("neutral-founder-reel"), { title: "Decide" });
  const saved = await api(`/api/projects/${projectId}/plan`, { method: "POST", token: TOKENS.editor, body: { plan } });
  const submit = await api(`/api/projects/${projectId}/versions/${saved.json.version.id}/submit`, { method: "POST", token: TOKENS.editor });
  return { projectId, inReviewId: submit.json.version.id };
}

describe("single-winner review decisions", () => {
  it("refuses a second sequential decision on the same source with 409", async () => {
    const { projectId, inReviewId } = await makeInReview();
    const first = await api(`/api/projects/${projectId}/versions/${inReviewId}/decision`, { method: "POST", token: TOKENS.approver, body: { approved: true, notes: "ship" } });
    expect(first.status).toBe(201);
    const second = await api(`/api/projects/${projectId}/versions/${inReviewId}/decision`, { method: "POST", token: TOKENS.approver, body: { approved: false, notes: "no" } });
    expect(second.status).toBe(409);
    // Exactly one decision-result child version exists off the in-review source.
    const versions = (await api(`/api/projects/${projectId}/versions`, { token: TOKENS.viewer })).json.versions;
    const children = versions.filter((v: any) => v.parentVersionId === inReviewId);
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe("approved");
  });

  it("lets only one of two concurrent decisions win", async () => {
    const { projectId, inReviewId } = await makeInReview();
    const [a, b] = await Promise.all([
      api(`/api/projects/${projectId}/versions/${inReviewId}/decision`, { method: "POST", token: TOKENS.approver, body: { approved: true } }),
      api(`/api/projects/${projectId}/versions/${inReviewId}/decision`, { method: "POST", token: TOKENS.approver, body: { approved: false } }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const versions = (await api(`/api/projects/${projectId}/versions`, { token: TOKENS.viewer })).json.versions;
    const children = versions.filter((v: any) => v.parentVersionId === inReviewId);
    expect(children).toHaveLength(1);
  });
});
