import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";
import { defaultConfig } from "../src/server/config.js";
import { getPreset } from "../src/presets/index.js";
import { makeStarterPlan } from "../src/presets/starter.js";
import type { FetchLike, FetchResponseLike } from "../src/util/fetchLike.js";
import type { HostResolver } from "../src/util/ssrf.js";

/*
 * Publish gate authority. The QA gate is decided ONLY by the stored QA report for the exact
 * version being published (repo.latestQaReport), never by the caller's qaPassed claim. Rights
 * confirmation stays an explicit caller gate. And the generic job queue rejects publish jobs,
 * which it cannot run, so the queue never advertises a capability that does not exist.
 */

const TOKENS = {
  editor: "editor-token-0123456789abcdef",
  approver: "approver-token-0123456789abcdef",
  publisher: "publisher-token-0123456789abcdef",
};

const resolvePublic: HostResolver = async () => ["93.184.216.34"];
const hookOk: FetchLike = async (): Promise<FetchResponseLike> => {
  const body = Buffer.from(JSON.stringify({ id: "post-1" }));
  const ab = new ArrayBuffer(body.length);
  new Uint8Array(ab).set(body);
  return { status: 200, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) }, arrayBuffer: async () => ab, text: async () => "", json: async () => ({ id: "post-1" }) };
};

const servers: RunningServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

function apiFor(server: RunningServer) {
  return async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined;
    if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
    const res = await fetch(server.url + path, { method: opts.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

async function setup(): Promise<{ server: RunningServer; api: ReturnType<typeof apiFor>; pid: string; approved: string }> {
  const storageRoot = mkdtempSync(join(tmpdir(), "oct-pub-store-"));
  const tempDir = mkdtempSync(join(tmpdir(), "oct-pub-temp-"));
  const publicDir = mkdtempSync(join(tmpdir(), "oct-pub-public-"));
  roots.push(storageRoot, tempDir, publicDir);
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>Octupie Video Editor</title>");
  const config = defaultConfig({
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    storageRoot,
    tempDir,
    publicDir,
    webhook: { endpointUrl: "https://hook.example.com/publish", allowedHosts: ["hook.example.com"] },
    grants: [{ action: "publishing", grantedBy: "op", grantedAt: "2026-01-01T00:00:00.000Z" }],
    users: [
      { id: "u-editor", tenantId: "t1", username: "editor", role: "editor", token: TOKENS.editor },
      { id: "u-approver", tenantId: "t1", username: "approver", role: "approver", token: TOKENS.approver },
      { id: "u-publisher", tenantId: "t1", username: "publisher", role: "publisher", token: TOKENS.publisher },
    ],
  });
  const server = await startServer(config, { fetch: hookOk, resolve: resolvePublic });
  servers.push(server);
  const api = apiFor(server);
  const pid = (await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "Pub" } })).json.project.id;
  const plan = makeStarterPlan(getPreset("neutral-founder-reel"), { title: "Pub" });
  const ver = (await api(`/api/projects/${pid}/plan`, { method: "POST", token: TOKENS.editor, body: { plan } })).json.version.id;
  const inrev = (await api(`/api/projects/${pid}/versions/${ver}/submit`, { method: "POST", token: TOKENS.editor })).json.version.id;
  const approved = (await api(`/api/projects/${pid}/versions/${inrev}/decision`, { method: "POST", token: TOKENS.approver, body: { approved: true } })).json.version.id;
  return { server, api, pid, approved };
}

const publish = (id: string, over: Record<string, unknown> = {}) => ({ versionId: over.versionId, adapterId: "webhook", idempotencyKey: id, rightsConfirmed: true, qaPassed: true, ...over });

describe("publish QA gate is authoritative from the stored report", () => {
  it("blocks at the qa gate when no QA report exists, even though the caller claims qaPassed:true", async () => {
    const { api, pid, approved } = await setup();
    const pub = await api(`/api/projects/${pid}/publish`, { method: "POST", token: TOKENS.publisher, body: publish("p1", { versionId: approved, qaPassed: true }) });
    expect(pub.status).toBe(409);
    expect(pub.json.status).toBe("blocked");
    expect(pub.json.gate).toBe("qa");
  });

  it("blocks at the qa gate when the stored QA report failed", async () => {
    const { server, api, pid, approved } = await setup();
    server.repo.putQaReport({ id: "qa-fail", tenantId: "t1", projectId: pid, versionId: approved, pass: false, report: { pass: false } });
    const pub = await api(`/api/projects/${pid}/publish`, { method: "POST", token: TOKENS.publisher, body: publish("p2", { versionId: approved, qaPassed: true }) });
    expect(pub.status).toBe(409);
    expect(pub.json.gate).toBe("qa");
  });

  it("publishes when a stored passing QA report exists, ignoring a caller qaPassed:false", async () => {
    const { server, api, pid, approved } = await setup();
    server.repo.putQaReport({ id: "qa-pass", tenantId: "t1", projectId: pid, versionId: approved, pass: true, report: { pass: true } });
    const pub = await api(`/api/projects/${pid}/publish`, { method: "POST", token: TOKENS.publisher, body: publish("p3", { versionId: approved, qaPassed: false }) });
    expect(pub.status).toBe(201);
    expect(pub.json.status).toBe("published");
  });

  it("still requires explicit rights confirmation from the caller", async () => {
    const { server, api, pid, approved } = await setup();
    server.repo.putQaReport({ id: "qa-pass", tenantId: "t1", projectId: pid, versionId: approved, pass: true, report: { pass: true } });
    const pub = await api(`/api/projects/${pid}/publish`, { method: "POST", token: TOKENS.publisher, body: publish("p4", { versionId: approved, rightsConfirmed: false }) });
    expect(pub.status).toBe(409);
    expect(pub.json.gate).toBe("rights");
  });
});

describe("generic job queue rejects unsupported publish jobs", () => {
  it("refuses a publish job with a validation error (publishing has its own gated flow)", async () => {
    const { api, pid } = await setup();
    const enq = await api(`/api/projects/${pid}/jobs`, { method: "POST", token: TOKENS.editor, body: { type: "publish", payload: {} } });
    expect(enq.status).toBe(400);
    expect(enq.json.error.code).toBe("unsupported-job");
  });
});
