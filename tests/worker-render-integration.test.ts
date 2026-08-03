/*
 * End-to-end final-render wiring: server upload -> save timeline plan -> queue render ->
 * worker. The worker prepares the isolated asset root and hands the rewritten plan to an
 * INJECTED render spy (no Remotion), so we can assert the exact uploaded bytes are present
 * under OVE_ASSET_ROOT at the safe relative path the plan now carries. This is the
 * regression the duplicated-key bug broke: before the fix the render runner pointed the
 * asset root at the project media dir and passed the raw storage key, so the master render
 * never resolved its footage.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";
import { defaultConfig } from "../src/server/config.js";
import { renderRunner, runWorkerOnce, type WorkerDeps } from "../src/server/worker.js";
import type { PipelineResult } from "../src/pipeline.js";
import type { QaReport } from "../src/ffmpeg/qa.js";

const TOKENS = {
  viewer: "viewer-token-0123456789abcdef",
  editor: "editor-token-0123456789abcdef",
};

const roots: string[] = [];
function makeConfig() {
  const storageRoot = mkdtempSync(join(tmpdir(), "oct-int-store-"));
  const tempDir = mkdtempSync(join(tmpdir(), "oct-int-temp-"));
  const publicDir = mkdtempSync(join(tmpdir(), "oct-int-public-"));
  roots.push(storageRoot, tempDir, publicDir);
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>Octupie Video Editor</title>");
  return defaultConfig({
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    storageRoot,
    tempDir,
    publicDir,
    users: [
      { id: "u-viewer", tenantId: "t1", username: "viewer", role: "viewer", token: TOKENS.viewer },
      { id: "u-editor", tenantId: "t1", username: "editor", role: "editor", token: TOKENS.editor },
    ],
  });
}

function makeApi(server: RunningServer) {
  return async function api(
    path: string,
    opts: { method?: string; token?: string; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; json: any; text: string }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined;
    if (opts.raw !== undefined) {
      body = opts.raw as unknown as BodyInit;
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(server.url + path, { method: opts.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    const ct = res.headers.get("content-type");
    const json = ct && ct.includes("application/json") && text ? JSON.parse(text) : null;
    return { status: res.status, json, text };
  };
}

function planWith(storageKey: string) {
  return {
    format: "octupie-edit-plan/v1",
    title: "Integration reel",
    preset: "neutral-founder-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 6,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes: [{ id: "s1", type: "hook", start: 0, end: 6, sourceClipId: "src-1" }],
    sourceClips: [{ id: "src-1", path: storageKey }],
    output: { fileName: "output/demo.mp4" },
  };
}

let server: RunningServer;
let config: ReturnType<typeof makeConfig>;

beforeAll(async () => {
  config = makeConfig();
  server = await startServer(config);
});

afterAll(async () => {
  await server.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe("server upload -> plan -> render worker", () => {
  it("resolves the uploaded footage under the prepared asset root when the plan carries the storage key", async () => {
    const api = makeApi(server);
    const payload = Buffer.from("integration mp4 payload 0123456789 body bytes");

    // 1. Project + upload real bytes to content-addressed storage.
    const project = await api("/api/projects", { method: "POST", token: TOKENS.editor, body: { name: "Integration" } });
    const projectId = project.json.project.id as string;
    const up = await api(`/api/projects/${projectId}/media`, {
      method: "POST",
      token: TOKENS.editor,
      headers: { "content-type": "video/mp4", "x-filename": "clip.mp4" },
      raw: new Uint8Array(payload),
    });
    expect(up.status).toBe(201);
    const storageKey = up.json.media.storageKey as string;
    // The client persists the FULL content-addressed key as the clip path (the bug's trigger).
    expect(storageKey).toContain(`t1/${projectId}/media/`);

    // 2. Save the timeline plan that references that key, then queue a render.
    const saved = await api(`/api/projects/${projectId}/plan`, { method: "POST", token: TOKENS.editor, body: { plan: planWith(storageKey) } });
    expect(saved.status).toBe(201);
    const versionId = saved.json.version.id as string;
    const enq = await api(`/api/projects/${projectId}/jobs`, { method: "POST", token: TOKENS.editor, body: { type: "render", payload: { versionId } } });
    expect(enq.status).toBe(201);

    // 3. A worker (sharing the running server's repo + storage) claims the job and runs a spy
    //    renderer that inspects what the real pipeline would see: the asset root and the bytes.
    const seen: { assetRoot?: string; clipPaths: string[]; bytesMatch: boolean } = { clipPaths: [], bytesMatch: false };
    const spy = async (plan: any, opts?: { dir?: string }): Promise<PipelineResult> => {
      seen.assetRoot = process.env.OVE_ASSET_ROOT;
      seen.clipPaths = plan.sourceClips.map((c: any) => c.path);
      const root = process.env.OVE_ASSET_ROOT!;
      seen.bytesMatch = plan.sourceClips.every((c: any) => readFileSync(join(root, c.path)).equals(payload));
      const report: QaReport = { file: "x.mp4", sha256: "0".repeat(64), generatedFromHash: "0".repeat(64), pass: true, gates: [], measured: {} };
      return { finalPath: join(opts?.dir ?? ".", "x.mp4"), qaReportPath: join(opts?.dir ?? ".", "x.qa.json"), report };
    };
    const runner = renderRunner(spy);
    const deps: WorkerDeps = {
      repo: server.repo,
      storage: server.storage,
      config,
      runners: { render: runner, qa: runner },
      now: () => new Date("2026-08-03T00:00:00.000Z").toISOString(),
    };
    const ran = await runWorkerOnce(deps);
    expect(ran?.status).toBe("succeeded");

    // 4. The plan the renderer saw was rewritten off the raw key to a safe media-relative name,
    //    and the exact uploaded bytes were present under the prepared asset root.
    expect(seen.assetRoot).toContain(join(projectId, "renders", versionId, "assets"));
    expect(seen.clipPaths).toHaveLength(1);
    expect(seen.clipPaths[0]).not.toBe(storageKey);
    expect(seen.clipPaths[0]).toBe(storageKey.slice(`t1/${projectId}/media/`.length));
    expect(seen.bytesMatch).toBe(true);

    // 5. QA persisted against the version.
    const qa = await api(`/api/projects/${projectId}/versions/${versionId}/qa`, { token: TOKENS.viewer });
    expect(qa.json.qa && qa.json.qa.pass).toBe(true);
  });
});
