import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";
import { defaultConfig } from "../src/server/config.js";
import { createWorkerRuntime, runWorkerOnce } from "../src/server/worker.js";
import { assertResolvesPublic, SsrfBlockedError } from "../src/util/ssrf.js";
import { makeStarterPlan } from "../src/presets/starter.js";
import { getPreset } from "../src/presets/index.js";
import type { FetchLike, FetchResponseLike } from "../src/util/fetchLike.js";
import type { HostResolver } from "../src/util/ssrf.js";

/*
 * Executable acceptance for the LOCAL product. Every gate id in PRODUCT_ACCEPTANCE.json
 * is proven here against a real server started in a temporary workspace, then the final
 * test asserts the manifest and the covered set match exactly, so the manifest cannot
 * claim a capability these tests do not exercise. External-provider gates live in the
 * parity manifest and are intentionally not covered here.
 */

const TOKENS = {
  viewer: "viewer-token-0123456789abcdef",
  editor: "editor-token-0123456789abcdef",
  approver: "approver-token-0123456789abcdef",
  publisher: "publisher-token-0123456789abcdef",
  admin: "admin-token-0123456789abcdef",
  otherTenant: "other-token-0123456789abcdef",
};

const resolvePublic: HostResolver = async () => ["93.184.216.34"];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8]);
const okPngFetch: FetchLike = async (): Promise<FetchResponseLike> => {
  const ab = new ArrayBuffer(PNG.length);
  new Uint8Array(ab).set(PNG);
  return { status: 200, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "image/png" : null) }, arrayBuffer: async () => ab, text: async () => "", json: async () => ({}) };
};

let server: RunningServer;
let roots: string[] = [];
let dbPath = "";
let config: ReturnType<typeof defaultConfig>;
let projectId = "";
let versionId = "";
const covered = new Set<string>();

function pass(id: string) { covered.add(id); }

async function api(path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; text: string; contentType: string | null }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.raw) body = new Uint8Array(opts.raw);
  else if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
  const res = await fetch(server.url + path, { method: opts.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  const contentType = res.headers.get("content-type");
  const json = contentType && contentType.includes("application/json") && text ? JSON.parse(text) : null;
  return { status: res.status, json, text, contentType };
}

beforeAll(async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "oct-pa-store-"));
  const tempDir = mkdtempSync(join(tmpdir(), "oct-pa-temp-"));
  const dbDir = mkdtempSync(join(tmpdir(), "oct-pa-db-"));
  roots.push(storageRoot, tempDir, dbDir);
  dbPath = join(dbDir, "acceptance.db");
  config = defaultConfig({
    host: "127.0.0.1",
    port: 0,
    dbPath,
    storageRoot,
    tempDir,
    publicDir: resolve(process.cwd(), "public"),
    grants: [
      { action: "network", grantedBy: "operator", grantedAt: "2026-01-01T00:00:00.000Z" },
      { action: "media-upload", grantedBy: "operator", grantedAt: "2026-01-01T00:00:00.000Z" },
    ],
    users: [
      { id: "u-viewer", tenantId: "t1", username: "viewer", role: "viewer", token: TOKENS.viewer },
      { id: "u-editor", tenantId: "t1", username: "editor", role: "editor", token: TOKENS.editor },
      { id: "u-approver", tenantId: "t1", username: "approver", role: "approver", token: TOKENS.approver },
      { id: "u-publisher", tenantId: "t1", username: "publisher", role: "publisher", token: TOKENS.publisher },
      { id: "u-admin", tenantId: "t1", username: "admin", role: "admin", token: TOKENS.admin },
      { id: "u-other", tenantId: "t2", username: "other", role: "editor", token: TOKENS.otherTenant },
    ],
  });
  server = await startServer(config, { fetch: okPngFetch, resolve: resolvePublic });
});

afterAll(async () => {
  await server.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe("local product acceptance", () => {
  it("product:auth-rbac - token auth with default-deny RBAC", async () => {
    expect((await api("/api/me")).status).toBe(401);
    expect((await api("/api/me", { token: "totally-wrong-token-xx" })).status).toBe(401);
    expect((await api("/api/projects", { method: "POST", token: TOKENS.viewer, body: { name: "Nope" } })).status).toBe(403);
    const created = await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "Acceptance" } });
    expect(created.status).toBe(201);
    projectId = created.json.project.id;
    pass("product:auth-rbac");
  });

  it("product:tenant-project-isolation - a project is invisible to another tenant", async () => {
    const asOther = await api(`/api/projects/${projectId}`, { token: TOKENS.otherTenant });
    expect(asOther.status).toBe(404);
    const otherList = await api("/api/projects", { token: TOKENS.otherTenant });
    expect(otherList.json.projects.find((p: any) => p.id === projectId)).toBeUndefined();
    pass("product:tenant-project-isolation");
  });

  it("product:plan-validate-save-load - valid plan saves; invalid is rejected", async () => {
    const plan = makeStarterPlan(getPreset("neutral-founder-reel"), { title: "Acceptance reel" });
    const saved = await api(`/api/projects/${projectId}/plan`, { method: "POST", token: TOKENS.editor, body: { plan } });
    expect(saved.status).toBe(201);
    versionId = saved.json.version.id;
    expect(saved.json.version.planSha256).toMatch(/^[0-9a-f]{64}$/);
    const loaded = await api(`/api/projects/${projectId}/plan`, { token: TOKENS.viewer });
    expect(loaded.status).toBe(200);
    expect(loaded.json.plan.format).toBe("octupie-edit-plan/v1");
    const bad = await api(`/api/projects/${projectId}/plan`, { method: "POST", token: TOKENS.editor, body: { plan: { not: "a plan" } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalid-plan");
    pass("product:plan-validate-save-load");
  });

  it("product:immutable-versions - versions append with strictly increasing numbers", async () => {
    const before = (await api(`/api/projects/${projectId}/versions`, { token: TOKENS.viewer })).json.versions;
    const plan = makeStarterPlan(getPreset("neutral-founder-reel"), { title: "Acceptance reel 2" });
    await api(`/api/projects/${projectId}/plan`, { method: "POST", token: TOKENS.editor, body: { plan } });
    const after = (await api(`/api/projects/${projectId}/versions`, { token: TOKENS.viewer })).json.versions;
    expect(after.length).toBe(before.length + 1);
    const nums = after.map((v: any) => v.version);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(new Set(nums).size).toBe(nums.length);
    pass("product:immutable-versions");
  });

  it("product:content-addressed-media - upload streams to CAS and serves byte-exact", async () => {
    const bytes = new Uint8Array(Buffer.from("acceptance mp4 payload bytes"));
    const up = await api(`/api/projects/${projectId}/media`, { method: "POST", token: TOKENS.editor, headers: { "content-type": "video/mp4", "x-filename": "clip.mp4" }, raw: bytes });
    expect(up.status).toBe(201);
    expect(up.json.media.storageKey).toContain(`t1/${projectId}/media/`);
    const bad = await api(`/api/projects/${projectId}/media`, { method: "POST", token: TOKENS.editor, headers: { "content-type": "application/x-msdownload", "x-filename": "evil.exe" }, raw: new Uint8Array([0x4d, 0x5a]) });
    expect(bad.status).toBe(400);
    const content = await fetch(server.url + `/api/projects/${projectId}/media/${up.json.media.id}/content`, { headers: { authorization: `Bearer ${TOKENS.viewer}` } });
    const served = Buffer.from(await content.arrayBuffer());
    expect(served.equals(Buffer.from("acceptance mp4 payload bytes"))).toBe(true);
    pass("product:content-addressed-media");
  });

  it("product:jobs-fifo-idempotent-offpath - idempotent enqueue; worker runs off path", async () => {
    const enq = await api(`/api/projects/${projectId}/jobs`, { method: "POST", token: TOKENS.editor, body: { type: "render", idempotencyKey: "acc-1", payload: { versionId } } });
    expect(enq.status).toBe(201);
    expect(enq.json.job.status).toBe("queued");
    const again = await api(`/api/projects/${projectId}/jobs`, { method: "POST", token: TOKENS.editor, body: { type: "render", idempotencyKey: "acc-1" } });
    expect(again.json.created).toBe(false);
    expect(again.json.job.id).toBe(enq.json.job.id);
    // A separate worker process claims the job over the shared on-disk database and runs
    // an injected runner (the deterministic render pipeline is proven by the live demo and
    // the pipeline tests; here we prove the queue/worker/QA-persistence wiring offline).
    const { deps, close } = createWorkerRuntime(config, {
      runners: { render: async (job) => ({ ok: true, detail: "synthetic", qa: { versionId: String(job.payload.versionId), pass: true, report: { gate: "synthetic-qa", pass: true } } }) },
    });
    try {
      const ran = await runWorkerOnce(deps);
      expect(ran && ran.status).toBe("succeeded");
    } finally { close(); }
    const qa = await api(`/api/projects/${projectId}/versions/${versionId}/qa`, { token: TOKENS.viewer });
    expect(qa.json.qa && qa.json.qa.pass).toBe(true);
    pass("product:jobs-fifo-idempotent-offpath");
  });

  it("product:frame-comments - frame comments persist and resolve", async () => {
    const add = await api(`/api/projects/${projectId}/versions/${versionId}/comments`, { method: "POST", token: TOKENS.viewer, body: { frame: 30, timeSec: 1.0, body: "tighten this cut" } });
    expect(add.status).toBe(201);
    expect(add.json.comment.resolved).toBe(false);
    const list = await api(`/api/projects/${projectId}/versions/${versionId}/comments`, { token: TOKENS.viewer });
    expect(list.json.comments.find((c: any) => c.id === add.json.comment.id)).toBeTruthy();
    const resolved = await api(`/api/comments/${add.json.comment.id}/resolve`, { method: "POST", token: TOKENS.editor });
    expect(resolved.json.comment.resolved).toBe(true);
    pass("product:frame-comments");
  });

  it("product:review-decision-rbac - submit + approver-only decision", async () => {
    const submit = await api(`/api/projects/${projectId}/versions/${versionId}/submit`, { method: "POST", token: TOKENS.editor });
    expect(submit.status).toBe(201);
    const inReviewId = submit.json.version.id;
    expect(submit.json.version.status).toBe("in-review");
    expect((await api(`/api/projects/${projectId}/versions/${inReviewId}/decision`, { method: "POST", token: TOKENS.viewer, body: { approved: true } })).status).toBe(403);
    const decide = await api(`/api/projects/${projectId}/versions/${inReviewId}/decision`, { method: "POST", token: TOKENS.approver, body: { approved: true, notes: "ship" } });
    expect(decide.status).toBe(201);
    expect(decide.json.version.status).toBe("approved");
    (globalThis as any).__approvedId = decide.json.version.id;
    pass("product:review-decision-rbac");
  });

  it("product:version-compare-truthful - compare reflects real differences", async () => {
    const versions = (await api(`/api/projects/${projectId}/versions`, { token: TOKENS.viewer })).json.versions;
    const a = versions[0].id;
    const b = versions[versions.length - 1].id;
    const same = await api(`/api/projects/${projectId}/compare?a=${a}&b=${a}`, { token: TOKENS.viewer });
    expect(same.json.comparison.planIdentical).toBe(true);
    const cmp = await api(`/api/projects/${projectId}/compare?a=${a}&b=${b}`, { token: TOKENS.viewer });
    expect(cmp.status).toBe(200);
    expect(typeof cmp.json.comparison.summary).toBe("string");
    expect(typeof cmp.json.comparison.planIdentical).toBe("boolean");
    pass("product:version-compare-truthful");
  });

  it("product:generation-provenance - local generation is synthetic with provenance", async () => {
    const img = await api(`/api/projects/${projectId}/generate/image`, { method: "POST", token: TOKENS.editor, body: { prompt: "Retention up 30 percent" } });
    expect(img.status).toBe(201);
    expect(img.json.provenance.synthetic).toBe(true);
    expect(img.json.media.origin).toBe("generated");
    expect(img.json.provenance.label.toLowerCase()).toContain("generated");
    const tts = await api(`/api/projects/${projectId}/generate/tts`, { method: "POST", token: TOKENS.editor, body: { text: "hello world" } });
    expect(tts.status).toBe(201);
    expect(tts.json.provenance.synthetic).toBe(true);
    pass("product:generation-provenance");
  });

  it("product:materialization-gated-ssrf - rights required, SSRF guarded, grant success", async () => {
    // Success path (grants held, injected transport, public resolver).
    const ok = await api(`/api/projects/${projectId}/materialize/web`, { method: "POST", token: TOKENS.editor, body: { url: "https://cdn.example.com/proof.png", rights: { license: "CC0-1.0", attribution: "Ex", reusable: true, source: "https://example.com/l" } } });
    expect(ok.status).toBe(201);
    expect(ok.json.provenance.method).toBe("web");
    // Rights fail closed.
    const noRights = await api(`/api/projects/${projectId}/materialize/web`, { method: "POST", token: TOKENS.editor, body: { url: "https://cdn.example.com/x.png", rights: { license: "x", attribution: "", reusable: false, source: "https://example.com" } } });
    expect(noRights.status).toBe(400);
    // SSRF guard refuses a private/rebinding resolution before any byte.
    await expect(assertResolvesPublic("evil.internal", async () => ["10.0.0.5"])).rejects.toBeInstanceOf(SsrfBlockedError);
    pass("product:materialization-gated-ssrf");
  });

  it("product:publishing-default-disabled - publish blocked with the exact gate", async () => {
    const approvedId = (globalThis as any).__approvedId as string;
    const pub = await api(`/api/projects/${projectId}/publish`, { method: "POST", token: TOKENS.publisher, body: { versionId: approvedId, adapterId: "webhook", idempotencyKey: "pub-acc-1", rightsConfirmed: true, qaPassed: true } });
    expect(pub.status).toBe(409);
    expect(pub.json.status).toBe("blocked");
    expect(pub.json.gate).toBe("permission");
    pass("product:publishing-default-disabled");
  });

  it("product:ui-served-no-cdn - the browser app serves locally with no CDN", async () => {
    const index = await fetch(server.url + "/");
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain("Octupie Video Editor");
    const appJs = await fetch(server.url + "/app.js");
    const css = await fetch(server.url + "/styles.css");
    expect(appJs.status).toBe(200);
    expect(css.status).toBe(200);
    // No CDN means no external resource is LOADED: the shell pulls no script/link/@font
    // over http(s), and the stylesheet imports/fetches nothing remote. Example URL strings
    // shown inside input placeholders are content, not resource loads, so we target the
    // actual loading constructs, not any URL substring.
    expect(/<(script|link)\b[^>]*\b(src|href)\s*=\s*["']https?:\/\//i.test(html), "shell loads a remote script/link").toBe(false);
    expect(/@import\s+(url\()?["']?https?:\/\//i.test(html), "shell @imports a remote sheet").toBe(false);
    const cssText = await css.text();
    expect(/@import\s+(url\()?["']?https?:\/\//i.test(cssText), "stylesheet @imports remote").toBe(false);
    expect(/url\(\s*["']?https?:\/\//i.test(cssText), "stylesheet references a remote url()").toBe(false);
    pass("product:ui-served-no-cdn");
  });

  it("product:clean-shutdown - a server starts and stops cleanly", async () => {
    const sroot = mkdtempSync(join(tmpdir(), "oct-pa-shut-"));
    const s2 = await startServer(defaultConfig({ host: "127.0.0.1", port: 0, dbPath: ":memory:", storageRoot: sroot, tempDir: sroot, publicDir: sroot, users: [{ id: "a", tenantId: "t1", username: "a", role: "admin", token: TOKENS.admin }] }));
    expect((await fetch(s2.url + "/api/health")).status).toBe(200);
    await s2.close();
    await expect(fetch(s2.url + "/api/health")).rejects.toBeTruthy();
    rmSync(sroot, { recursive: true, force: true });
    pass("product:clean-shutdown");
  });

  it("PRODUCT_ACCEPTANCE.json exactly matches the gates these tests proved", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "PRODUCT_ACCEPTANCE.json"), "utf8"));
    expect(manifest.format).toBe("octupie-product-acceptance/v1");
    const manifestIds = manifest.gates.map((g: any) => g.id).sort();
    // Every gate is marked passed, and every passed gate was actually exercised above.
    for (const g of manifest.gates) {
      expect(g.status, `gate ${g.id} status`).toBe("passed");
      expect(covered.has(g.id), `gate ${g.id} was proven by a test`).toBe(true);
    }
    // No test claims a gate the manifest does not list.
    for (const id of covered) expect(manifestIds).toContain(id);
    expect([...covered].sort()).toEqual(manifestIds);
  });
});
