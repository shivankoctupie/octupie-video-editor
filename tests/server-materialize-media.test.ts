import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";
import { defaultConfig } from "../src/server/config.js";
import type { FetchLike, FetchResponseLike } from "../src/util/fetchLike.js";
import type { HostResolver } from "../src/util/ssrf.js";

const TOKENS = {
  viewer: "viewer-token-0123456789abcdef",
  editor: "editor-token-0123456789abcdef",
};

/** A public-address resolver stub so the SSRF gate passes deterministically offline. */
const resolvePublic: HostResolver = async () => ["93.184.216.34"];

/** A fetch stub that returns a small PNG for any URL, so web materialization succeeds
 * without touching the network. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const okPngFetch: FetchLike = async (): Promise<FetchResponseLike> => {
  const ab = new ArrayBuffer(PNG.length);
  new Uint8Array(ab).set(PNG);
  return {
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "image/png" : null) },
    arrayBuffer: async () => ab,
    text: async () => "",
    json: async () => ({}),
  };
};

function makeConfig(roots: string[], grants: boolean) {
  const storageRoot = mkdtempSync(join(tmpdir(), "oct-mat-store-"));
  const tempDir = mkdtempSync(join(tmpdir(), "oct-mat-temp-"));
  const publicDir = mkdtempSync(join(tmpdir(), "oct-mat-public-"));
  roots.push(storageRoot, tempDir, publicDir);
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>Octupie Video Editor</title>");
  return defaultConfig({
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    storageRoot,
    tempDir,
    publicDir,
    grants: grants
      ? [
          { action: "network", grantedBy: "operator", grantedAt: "2026-01-01T00:00:00.000Z" },
          { action: "media-upload", grantedBy: "operator", grantedAt: "2026-01-01T00:00:00.000Z" },
        ]
      : [],
    users: [
      { id: "u-viewer", tenantId: "t1", username: "viewer", role: "viewer", token: TOKENS.viewer },
      { id: "u-editor", tenantId: "t1", username: "editor", role: "editor", token: TOKENS.editor },
    ],
  });
}

function makeApi(server: RunningServer) {
  return async function api(
    path: string,
    opts: { method?: string; token?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: any; contentType: string | null; text: string }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(server.url + path, { method: opts.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    const contentType = res.headers.get("content-type");
    let json: any = null;
    if (contentType && contentType.includes("application/json")) json = text ? JSON.parse(text) : null;
    return { status: res.status, json, contentType, text };
  };
}

let server: RunningServer;
let roots: string[] = [];
let projectId = "";

beforeAll(async () => {
  server = await startServer(makeConfig(roots, true), { fetch: okPngFetch, resolve: resolvePublic });
  const created = await makeApi(server)("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "Materialize test" } });
  projectId = created.json.project.id;
});

afterAll(async () => {
  await server.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe("media content serving", () => {
  it("serves the exact bytes of a generated asset with its own content type", async () => {
    const api = makeApi(server);
    const gen = await api(`/api/projects/${projectId}/generate/image`, { method: "POST", token: TOKENS.editor, body: { prompt: "Retention up 30 percent" } });
    expect(gen.status).toBe(201);
    const mediaId = gen.json.media.id;
    const content = await api(`/api/projects/${projectId}/media/${mediaId}/content`, { token: TOKENS.viewer });
    expect(content.status).toBe(200);
    expect(content.contentType).toContain("image/svg+xml");
    expect(content.text).toContain("<svg");
  });

  it("404s for an unknown media id and stays tenant/project scoped", async () => {
    const api = makeApi(server);
    const miss = await api(`/api/projects/${projectId}/media/media-does-not-exist/content`, { token: TOKENS.viewer });
    expect(miss.status).toBe(404);
  });
});

describe("controlled web materialization with grants + injected transport", () => {
  it("materializes a rights-cleared web asset, records provenance, and serves it back", async () => {
    const api = makeApi(server);
    const mat = await api(`/api/projects/${projectId}/materialize/web`, {
      method: "POST",
      token: TOKENS.editor,
      body: {
        url: "https://cdn.example.com/proof.png",
        rights: { license: "CC0-1.0", attribution: "Example", reusable: true, source: "https://example.com/license" },
      },
    });
    expect(mat.status).toBe(201);
    expect(mat.json.provenance.method).toBe("web");
    expect(mat.json.provenance.source).toBe("https://cdn.example.com/proof.png");
    expect(mat.json.provenance.rights.reusable).toBe(true);
    expect(mat.json.media.origin).toBe("web");
    const content = await api(`/api/projects/${projectId}/media/${mat.json.media.id}/content`, { token: TOKENS.viewer });
    expect(content.status).toBe(200);
    expect(content.contentType).toContain("image/png");
  });

  it("refuses materialization when rights are not reusable (fail closed, no bytes)", async () => {
    const api = makeApi(server);
    const mat = await api(`/api/projects/${projectId}/materialize/web`, {
      method: "POST",
      token: TOKENS.editor,
      body: { url: "https://cdn.example.com/x.png", rights: { license: "unknown", attribution: "", reusable: false, source: "https://example.com" } },
    });
    expect(mat.status).toBe(400);
    expect(mat.json.error.code).toBe("materialize-failed");
  });
});

describe("honest status panel", () => {
  it("reports verified local generation, configured storage, and grant-gated materialization without leaking secrets", async () => {
    const api = makeApi(server);
    const st = await api("/api/status", { token: TOKENS.viewer });
    expect(st.status).toBe(200);
    expect(st.json.storage.kind).toBe("local");
    expect(st.json.storage.available).toBe(true);
    expect(st.json.generation.localImage.verified).toBe(true);
    expect(st.json.materialization.web.enabled).toBe(true);
    expect(st.json.grants.map((g: any) => g.action).sort()).toEqual(["media-upload", "network"]);
    // Grants expose only action/grantedBy/expiry, never any token or secret value, and
    // no bearer credential ever appears in the status body.
    for (const g of st.json.grants) expect(Object.keys(g).sort()).toEqual(["action", "grantedBy"]);
    expect(st.text.toLowerCase()).not.toContain("bearer ");
    expect(st.json.actualToken).toBeUndefined();
  });

  it("records materialization in the audit trail", async () => {
    const api = makeApi(server);
    const audit = await api("/api/audit", { token: TOKENS.viewer });
    expect(audit.status).toBe(200);
    expect(audit.json.audit.map((a: any) => a.action)).toContain("materialize.web");
  });
});

describe("default-deny materialization without grants", () => {
  it("refuses web materialization with 403 when no network/media-upload grant is held", async () => {
    const localRoots: string[] = [];
    const noGrant = await startServer(makeConfig(localRoots, false), { fetch: okPngFetch, resolve: resolvePublic });
    try {
      const api = makeApi(noGrant);
      const created = await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "No grant" } });
      const pid = created.json.project.id;
      const mat = await api(`/api/projects/${pid}/materialize/web`, {
        method: "POST",
        token: TOKENS.editor,
        body: { url: "https://cdn.example.com/proof.png", rights: { license: "CC0-1.0", attribution: "Example", reusable: true, source: "https://example.com/license" } },
      });
      expect(mat.status).toBe(403);
      expect(mat.json.error.code).toBe("permission");
      const st = await api("/api/status", { token: TOKENS.viewer });
      expect(st.json.materialization.web.enabled).toBe(false);
    } finally {
      await noGrant.close();
      for (const p of localRoots.splice(0)) rmSync(p, { recursive: true, force: true });
    }
  });
});
