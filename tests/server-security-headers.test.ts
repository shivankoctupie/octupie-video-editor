import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";
import { defaultConfig } from "../src/server/config.js";

/*
 * Global HTTP hardening. The app shell and every JSON response carry a Content-Security-Policy
 * suited to the all-local React app (self, plus blob:/data: for media the app builds in the
 * browser), nosniff, a strict Referrer-Policy, and frame-ancestors/object-src/base-uri locks.
 * Media bytes keep their own locked-down attachment CSP so a fetched blob can never execute.
 */

const EDITOR = "editor-token-0123456789abcdef";
const VIEWER = "viewer-token-0123456789abcdef";

let server: RunningServer;
const roots: string[] = [];

beforeAll(async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "oct-sec-store-"));
  const tempDir = mkdtempSync(join(tmpdir(), "oct-sec-temp-"));
  const publicDir = mkdtempSync(join(tmpdir(), "oct-sec-public-"));
  roots.push(storageRoot, tempDir, publicDir);
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>Octupie Video Editor</title><div id=root>shell</div>");
  server = await startServer(
    defaultConfig({
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      storageRoot,
      tempDir,
      publicDir,
      users: [
        { id: "u-editor", tenantId: "t1", username: "editor", role: "editor", token: EDITOR },
        { id: "u-viewer", tenantId: "t1", username: "viewer", role: "viewer", token: VIEWER },
      ],
    }),
  );
});

afterAll(async () => {
  await server.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** Assertions shared by the app shell and JSON responses. */
function expectHardenedHeaders(headers: Headers): void {
  const csp = headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  // The browser app builds media object URLs (blob:) and canvas thumbnails (data:).
  expect(csp).toContain("img-src 'self' blob: data:");
  expect(csp).toContain("media-src 'self' blob:");
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("referrer-policy")).toBeTruthy();
}

describe("global HTTP hardening", () => {
  it("sends hardened headers on the app shell", async () => {
    const res = await fetch(server.url + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expectHardenedHeaders(res.headers);
    await res.text();
  });

  it("sends hardened headers on the single-page fallback for unknown routes", async () => {
    const res = await fetch(server.url + "/projects/x/edit");
    expect(res.status).toBe(200);
    expectHardenedHeaders(res.headers);
    await res.text();
  });

  it("sends hardened headers on JSON responses", async () => {
    const res = await fetch(server.url + "/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expectHardenedHeaders(res.headers);
    await res.text();
  });

  it("preserves the locked-down attachment CSP on served media bytes", async () => {
    const project = await (
      await fetch(server.url + "/api/projects", { method: "POST", headers: { authorization: `Bearer ${EDITOR}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Sec" }) })
    ).json();
    const projectId = project.project.id;
    const up = await (
      await fetch(server.url + `/api/projects/${projectId}/media`, {
        method: "POST",
        headers: { authorization: `Bearer ${EDITOR}`, "content-type": "image/png", "x-filename": "p.png" },
        body: new Uint8Array(Buffer.from("fake png bytes for the security-header test")),
      })
    ).json();
    const res = await fetch(server.url + `/api/projects/${projectId}/media/${up.media.id}/content`, { headers: { authorization: `Bearer ${VIEWER}` } });
    expect(res.status).toBe(200);
    // The media response keeps its own sandboxed CSP, never the app CSP.
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    await res.arrayBuffer();
  });
});
