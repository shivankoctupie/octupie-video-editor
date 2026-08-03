import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";
import { defaultConfig } from "../src/server/config.js";
import { getPreset } from "../src/presets/index.js";
import { makeStarterPlan } from "../src/presets/starter.js";

const TOKENS = {
  viewer: "viewer-token-0123456789abcdef",
  editor: "editor-token-0123456789abcdef",
  approver: "approver-token-0123456789abcdef",
  publisher: "publisher-token-0123456789abcdef",
  admin: "admin-token-0123456789abcdef",
};

let server: RunningServer;
let roots: string[] = [];

beforeAll(async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "oct-http-store-"));
  const tempDir = mkdtempSync(join(tmpdir(), "oct-http-temp-"));
  const publicDir = mkdtempSync(join(tmpdir(), "oct-http-public-"));
  roots.push(storageRoot, tempDir, publicDir);
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>Octupie Video Editor</title><div id=app>shell</div>");
  const config = defaultConfig({
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    storageRoot,
    tempDir,
    publicDir,
    users: [
      { id: "u-viewer", tenantId: "t1", username: "viewer", role: "viewer", token: TOKENS.viewer },
      { id: "u-editor", tenantId: "t1", username: "editor", role: "editor", token: TOKENS.editor },
      { id: "u-approver", tenantId: "t1", username: "approver", role: "approver", token: TOKENS.approver },
      { id: "u-publisher", tenantId: "t1", username: "publisher", role: "publisher", token: TOKENS.publisher },
      { id: "u-admin", tenantId: "t1", username: "admin", role: "admin", token: TOKENS.admin },
    ],
  });
  server = await startServer(config);
});

afterAll(async () => {
  await server.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

async function api(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string>; raw?: Buffer } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.raw) {
    // A Node Buffer is a Uint8Array, but the DOM BodyInit type does not accept Buffer
    // directly; wrap it in a plain Uint8Array view so it is a valid request body.
    body = new Uint8Array(opts.raw);
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(server.url + path, { method: opts.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let projectId = "";
let versionId = "";
let inReviewId = "";
let approvedId = "";

describe("product server REST API", () => {
  it("serves an unauthenticated health check", async () => {
    const r = await api("/api/health");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.name).toBe("octupie-video-editor");
  });

  it("rejects an unauthenticated API call and accepts a valid token", async () => {
    expect((await api("/api/me")).status).toBe(401);
    expect((await api("/api/me", { token: "wrong-token-wrong-token-xx" })).status).toBe(401);
    const me = await api("/api/me", { token: TOKENS.editor });
    expect(me.status).toBe(200);
    expect(me.json.user.role).toBe("editor");
    expect(me.json.actions).toContain("edit");
  });

  it("enforces RBAC on project creation", async () => {
    expect((await api("/api/projects", { method: "POST", token: TOKENS.viewer, body: { name: "Nope" } })).status).toBe(403);
    const created = await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "Launch Reel" } });
    expect(created.status).toBe(201);
    projectId = created.json.project.id;
    const list = await api("/api/projects", { token: TOKENS.viewer });
    expect(list.json.projects.map((p: any) => p.id)).toContain(projectId);
  });

  it("saves a validated plan as a version and loads it back", async () => {
    const plan = makeStarterPlan(getPreset("neutral-founder-reel"), { title: "Hello" });
    const saved = await api(`/api/projects/${projectId}/plan`, { method: "POST", token: TOKENS.editor, body: { plan } });
    expect(saved.status).toBe(201);
    versionId = saved.json.version.id;
    expect(saved.json.version.version).toBe(1);
    expect(saved.json.version.planSha256).toMatch(/^[0-9a-f]{64}$/);
    const loaded = await api(`/api/projects/${projectId}/plan`, { token: TOKENS.viewer });
    expect(loaded.status).toBe(200);
    expect(loaded.json.plan.format).toBeDefined();
  });

  it("rejects an invalid plan", async () => {
    const bad = await api(`/api/projects/${projectId}/plan`, { method: "POST", token: TOKENS.editor, body: { plan: { not: "a plan" } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalid-plan");
  });

  it("does not append a duplicate version when the plan is unchanged (no-op save)", async () => {
    const before = (await api(`/api/projects/${projectId}/versions`, { token: TOKENS.viewer })).json.versions;
    // Byte-identical to the version saved above; makeStarterPlan is deterministic per args.
    const plan = makeStarterPlan(getPreset("neutral-founder-reel"), { title: "Hello" });
    const again = await api(`/api/projects/${projectId}/plan`, { method: "POST", token: TOKENS.editor, body: { plan } });
    expect(again.status).toBe(200);
    expect(again.json.created).toBe(false);
    expect(again.json.version.id).toBe(versionId); // the existing version, not a new one
    const after = (await api(`/api/projects/${projectId}/versions`, { token: TOKENS.viewer })).json.versions;
    expect(after.length).toBe(before.length); // no new version row
  });

  it("appends a new version when the plan actually changed", async () => {
    const before = (await api(`/api/projects/${projectId}/versions`, { token: TOKENS.viewer })).json.versions;
    const plan = makeStarterPlan(getPreset("neutral-founder-reel"), { title: "Hello, changed" });
    const changed = await api(`/api/projects/${projectId}/plan`, { method: "POST", token: TOKENS.editor, body: { plan } });
    expect(changed.status).toBe(201);
    expect(changed.json.created).toBe(true);
    const after = (await api(`/api/projects/${projectId}/versions`, { token: TOKENS.viewer })).json.versions;
    expect(after.length).toBe(before.length + 1);
    versionId = changed.json.version.id; // keep the latest for downstream review-flow tests
  });

  it("streams a media upload into content-addressed storage and lists it", async () => {
    const bytes = Buffer.from("fake mp4 bytes for the upload test");
    const up = await api(`/api/projects/${projectId}/media`, {
      method: "POST",
      token: TOKENS.editor,
      headers: { "content-type": "video/mp4", "x-filename": "clip.mp4" },
      raw: bytes,
    });
    expect(up.status).toBe(201);
    expect(up.json.media.mime).toBe("video/mp4");
    expect(up.json.media.storageKey).toContain(`t1/${projectId}/media/`);
    const media = await api(`/api/projects/${projectId}/media`, { token: TOKENS.viewer });
    expect(media.json.media).toHaveLength(1);
  });

  it("rejects a disallowed upload type", async () => {
    const up = await api(`/api/projects/${projectId}/media`, {
      method: "POST",
      token: TOKENS.editor,
      headers: { "content-type": "application/x-msdownload", "x-filename": "evil.exe" },
      raw: Buffer.from("MZ"),
    });
    expect(up.status).toBe(400);
  });

  it("enqueues a render job off the request path and reports its status", async () => {
    const enq = await api(`/api/projects/${projectId}/jobs`, { method: "POST", token: TOKENS.editor, body: { type: "render", idempotencyKey: "render-1", payload: { versionId } } });
    expect(enq.status).toBe(201);
    expect(enq.json.job.status).toBe("queued");
    // Idempotent: same key returns the same job, not a new one.
    const again = await api(`/api/projects/${projectId}/jobs`, { method: "POST", token: TOKENS.editor, body: { type: "render", idempotencyKey: "render-1" } });
    expect(again.json.created).toBe(false);
    const jobs = await api(`/api/projects/${projectId}/jobs`, { token: TOKENS.viewer });
    expect(jobs.json.jobs).toHaveLength(1);
  });

  it("stores a frame-anchored comment and resolves it", async () => {
    const add = await api(`/api/projects/${projectId}/versions/${versionId}/comments`, { method: "POST", token: TOKENS.viewer, body: { frame: 30, timeSec: 1.0, body: "tighten this cut" } });
    expect(add.status).toBe(201);
    const cid = add.json.comment.id;
    expect(add.json.comment.resolved).toBe(false);
    const resolved = await api(`/api/comments/${cid}/resolve`, { method: "POST", token: TOKENS.editor });
    expect(resolved.json.comment.resolved).toBe(true);
  });

  it("runs the review flow and compares versions truthfully", async () => {
    const submit = await api(`/api/projects/${projectId}/versions/${versionId}/submit`, { method: "POST", token: TOKENS.editor });
    expect(submit.status).toBe(201);
    inReviewId = submit.json.version.id;
    expect(submit.json.version.status).toBe("in-review");
    // A viewer cannot decide.
    expect((await api(`/api/projects/${projectId}/versions/${inReviewId}/decision`, { method: "POST", token: TOKENS.viewer, body: { approved: true } })).status).toBe(403);
    const decide = await api(`/api/projects/${projectId}/versions/${inReviewId}/decision`, { method: "POST", token: TOKENS.approver, body: { approved: true, notes: "ship" } });
    expect(decide.status).toBe(201);
    approvedId = decide.json.version.id;
    expect(decide.json.version.status).toBe("approved");
    const cmp = await api(`/api/projects/${projectId}/compare?a=${versionId}&b=${approvedId}`, { token: TOKENS.viewer });
    expect(cmp.status).toBe(200);
    expect(cmp.json.comparison.planIdentical).toBe(true);
    expect(typeof cmp.json.comparison.summary).toBe("string");
  });

  it("blocks publishing by default (no publishing grant)", async () => {
    const pub = await api(`/api/projects/${projectId}/publish`, {
      method: "POST",
      token: TOKENS.publisher,
      body: { versionId: approvedId, adapterId: "webhook", idempotencyKey: "pub-1", rightsConfirmed: true, qaPassed: true },
    });
    expect(pub.status).toBe(409);
    expect(pub.json.status).toBe("blocked");
    // With no publishing grant the permission gate stops it before any adapter.
    expect(pub.json.gate).toBe("permission");
  });

  it("generates a labelled synthetic image with provenance", async () => {
    const gen = await api(`/api/projects/${projectId}/generate/image`, { method: "POST", token: TOKENS.editor, body: { prompt: "Retention up 30 percent" } });
    expect(gen.status).toBe(201);
    expect(gen.json.provenance.synthetic).toBe(true);
    expect(gen.json.media.origin).toBe("generated");
    expect(gen.json.provenance.label.toLowerCase()).toContain("generated");
  });

  it("serves the static browser shell with no CDN", async () => {
    const res = await fetch(server.url + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Octupie Video Editor");
  });
});
