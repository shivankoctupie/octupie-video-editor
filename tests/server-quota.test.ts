import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";
import { defaultConfig, configFromEnv } from "../src/server/config.js";
import type { FetchLike, FetchResponseLike } from "../src/util/fetchLike.js";
import type { HostResolver } from "../src/util/ssrf.js";

/*
 * Per-tenant storage quota. A tenant cannot exhaust the host: uploads, imported
 * (materialized) bytes, and generated assets all count against one configurable limit,
 * enforced BEFORE the media row is registered, with any partial artifact cleaned up. The
 * limit is per tenant, so one tenant's usage never blocks another's.
 */

const TOKENS = {
  editor: "editor-token-0123456789abcdef",
  viewer: "viewer-token-0123456789abcdef",
  editor2: "editor2-token-0123456789abcdef",
};
const resolvePublic: HostResolver = async () => ["93.184.216.34"];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const okPngFetch: FetchLike = async (): Promise<FetchResponseLike> => {
  const ab = new ArrayBuffer(PNG.length);
  new Uint8Array(ab).set(PNG);
  return { status: 200, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "image/png" : null) }, arrayBuffer: async () => ab, text: async () => "", json: async () => ({}) };
};

const servers: RunningServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

async function makeServer(opts: { maxTenantBytes: number; grants?: boolean }): Promise<{ server: RunningServer; storageRoot: string; tempDir: string }> {
  const storageRoot = mkdtempSync(join(tmpdir(), "oct-quota-store-"));
  const tempDir = mkdtempSync(join(tmpdir(), "oct-quota-temp-"));
  const publicDir = mkdtempSync(join(tmpdir(), "oct-quota-public-"));
  roots.push(storageRoot, tempDir, publicDir);
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>Octupie Video Editor</title>");
  const config = defaultConfig({
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    storageRoot,
    tempDir,
    publicDir,
    maxTenantBytes: opts.maxTenantBytes,
    grants: opts.grants ? [{ action: "network", grantedBy: "op", grantedAt: "2026-01-01T00:00:00.000Z" }, { action: "media-upload", grantedBy: "op", grantedAt: "2026-01-01T00:00:00.000Z" }] : [],
    users: [
      { id: "u-editor", tenantId: "t1", username: "editor", role: "editor", token: TOKENS.editor },
      { id: "u-viewer", tenantId: "t1", username: "viewer", role: "viewer", token: TOKENS.viewer },
      { id: "u-editor2", tenantId: "t2", username: "editor2", role: "editor", token: TOKENS.editor2 },
    ],
  });
  const server = await startServer(config, { fetch: okPngFetch, resolve: resolvePublic });
  servers.push(server);
  return { server, storageRoot, tempDir };
}

function apiFor(server: RunningServer) {
  return async function api(path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined;
    if (opts.raw) body = new Uint8Array(opts.raw);
    else if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
    const res = await fetch(server.url + path, { method: opts.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

const upload = (bytes: Buffer, name: string) => ({ method: "POST", token: TOKENS.editor, headers: { "content-type": "video/mp4", "x-filename": name }, raw: bytes });

describe("config default and env", () => {
  it("has a safe, finite, positive default per-tenant quota", () => {
    const q = defaultConfig().maxTenantBytes;
    expect(Number.isFinite(q)).toBe(true);
    expect(q).toBeGreaterThan(0);
  });
  it("reads OVE_SERVER_MAX_TENANT_BYTES from the environment", () => {
    expect(configFromEnv({ OVE_SERVER_MAX_TENANT_BYTES: "12345" } as NodeJS.ProcessEnv).maxTenantBytes).toBe(12345);
  });
});

describe("upload quota enforced before durable registration, partials cleaned", () => {
  it("rejects the upload that would exceed the tenant quota and leaves no media row or temp file", async () => {
    const { server, tempDir } = await makeServer({ maxTenantBytes: 64 });
    const api = apiFor(server);
    const p = await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "Q" } });
    const pid = p.json.project.id;
    const first = await api(`/api/projects/${pid}/media`, upload(Buffer.alloc(40, 0x41), "a.mp4"));
    expect(first.status).toBe(201);
    const second = await api(`/api/projects/${pid}/media`, upload(Buffer.alloc(40, 0x43), "c.mp4"));
    expect(second.status).toBe(413);
    expect(second.json.error.code).toBe("quota-exceeded");
    // Only the first upload is registered, and no partial temp file survives the rejection.
    const media = await api(`/api/projects/${pid}/media`, { token: TOKENS.viewer });
    expect(media.json.media).toHaveLength(1);
    const leftover = existsSync(tempDir) ? readdirSync(tempDir).filter((f) => f.endsWith(".part")) : [];
    expect(leftover).toHaveLength(0);
  });
});

describe("generation counts against the quota", () => {
  it("rejects a generated asset that would exceed the quota, registering nothing", async () => {
    const { server } = await makeServer({ maxTenantBytes: 10 });
    const api = apiFor(server);
    const p = await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "Q" } });
    const pid = p.json.project.id;
    const gen = await api(`/api/projects/${pid}/generate/image`, { method: "POST", token: TOKENS.editor, body: { prompt: "Retention up 30 percent" } });
    expect(gen.status).toBe(413);
    expect(gen.json.error.code).toBe("quota-exceeded");
    const media = await api(`/api/projects/${pid}/media`, { token: TOKENS.viewer });
    expect(media.json.media).toHaveLength(0);
  });
});

describe("materialized imports count against the quota and clean partial artifacts", () => {
  it("rejects an import over quota, registers no media, and removes the written asset + sidecars", async () => {
    const { server, storageRoot } = await makeServer({ maxTenantBytes: 5, grants: true });
    const api = apiFor(server);
    const p = await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "Q" } });
    const pid = p.json.project.id;
    const mat = await api(`/api/projects/${pid}/materialize/web`, { method: "POST", token: TOKENS.editor, body: { url: "https://cdn.example.com/proof.png", rights: { license: "CC0-1.0", attribution: "Ex", reusable: true, source: "https://example.com/l" } } });
    expect(mat.status).toBe(413);
    expect(mat.json.error.code).toBe("quota-exceeded");
    const media = await api(`/api/projects/${pid}/media`, { token: TOKENS.viewer });
    expect(media.json.media).toHaveLength(0);
    // No orphan asset or sidecar bytes were left on disk after the rejection.
    const matDir = join(storageRoot, "t1", pid, "materialized");
    const files = existsSync(matDir) ? readdirSync(matDir) : [];
    expect(files).toHaveLength(0);
  });
});

describe("quota is a hard concurrent boundary (transactional reservation)", () => {
  it("two concurrent uploads that together exceed the quota register at most the quota", async () => {
    const { server } = await makeServer({ maxTenantBytes: 64 });
    const api = apiFor(server);
    const pid = (await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "C" } })).json.project.id;
    // Fire two distinct 40-byte uploads at once. 40 + 40 = 80 > 64, so the atomic reservation
    // must let exactly one land: a check-then-write with an await between would let both pass.
    const [a, b] = await Promise.all([
      api(`/api/projects/${pid}/media`, upload(Buffer.alloc(40, 0x41), "a.mp4")),
      api(`/api/projects/${pid}/media`, upload(Buffer.alloc(40, 0x42), "b.mp4")),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 413]);
    // Registered bytes never exceed the quota, and only one row exists.
    const media = (await api(`/api/projects/${pid}/media`, { token: TOKENS.viewer })).json.media;
    expect(media).toHaveLength(1);
    expect(media.reduce((s: number, m: any) => s + m.size, 0)).toBeLessThanOrEqual(64);
  });
});

describe("quota is per tenant (isolation)", () => {
  it("one tenant's usage does not consume another tenant's quota", async () => {
    const { server } = await makeServer({ maxTenantBytes: 64 });
    const api = apiFor(server);
    const p1 = (await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "T1" } })).json.project.id;
    const p2 = (await api("/api/projects", { method: "POST", token: TOKENS.editor2, body: { name: "T2" } })).json.project.id;
    // t1 uses 40 of its 64 bytes.
    expect((await api(`/api/projects/${p1}/media`, upload(Buffer.alloc(40, 0x41), "a.mp4"))).status).toBe(201);
    // t2 uploads 40 of ITS own 64 bytes; if the quota were global this would be 80 > 64.
    const t2up = await fetch(server.url + `/api/projects/${p2}/media`, { method: "POST", headers: { authorization: `Bearer ${TOKENS.editor2}`, "content-type": "video/mp4", "x-filename": "b.mp4" }, body: new Uint8Array(Buffer.alloc(40, 0x42)) });
    expect(t2up.status).toBe(201);
    // t1's own second upload still exceeds t1's quota.
    expect((await api(`/api/projects/${p1}/media`, upload(Buffer.alloc(40, 0x43), "c.mp4"))).status).toBe(413);
  });
});
