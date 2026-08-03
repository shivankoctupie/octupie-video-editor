import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";
import { defaultConfig } from "../src/server/config.js";
import { makeStarterPlan } from "../src/presets/starter.js";
import { getPreset } from "../src/presets/index.js";

/*
 * Browser smoke test. It starts the ACTUAL product server in a temporary workspace,
 * serving the real public/ browser app, and drives the exact request sequence the SPA
 * makes: sign in (token -> /api/me), create a project, save a validated plan, enqueue a
 * render off the request path, add a frame comment, submit and decide a review, and load
 * the UI shell. Then it stops the server cleanly. No headless browser is required: this
 * exercises the same HTTP surface the browser uses, plus asserts the static app serves
 * locally with no CDN, so it runs offline and deterministically in CI.
 */

const ADMIN = "admin-token-0123456789abcdef";
const EDITOR = "editor-token-0123456789abcdef";
const APPROVER = "approver-token-0123456789abcdef";

let server: RunningServer;
let workspace: string;

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
  const res = await fetch(server.url + path, { method: opts.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  const ct = res.headers.get("content-type");
  return { status: res.status, json: ct && ct.includes("application/json") && text ? JSON.parse(text) : null, text };
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "oct-smoke-"));
  server = await startServer(
    defaultConfig({
      host: "127.0.0.1",
      port: 0,
      dbPath: join(workspace, "smoke.db"),
      storageRoot: join(workspace, "storage"),
      tempDir: join(workspace, "temp"),
      publicDir: resolve(process.cwd(), "public"),
      users: [
        { id: "u-admin", tenantId: "t1", username: "admin", role: "admin", token: ADMIN },
        { id: "u-editor", tenantId: "t1", username: "editor", role: "editor", token: EDITOR },
        { id: "u-approver", tenantId: "t1", username: "approver", role: "approver", token: APPROVER },
      ],
    }),
  );
});

afterAll(async () => {
  await server.close();
  rmSync(workspace, { recursive: true, force: true });
});

describe("browser smoke: the full sign-in-to-decision flow the SPA drives", () => {
  it("runs login, project, plan, enqueue, comment, review, and UI load, then stops cleanly", async () => {
    // 1. Health is public.
    expect((await call("/api/health")).json.ok).toBe(true);

    // 2. Sign in: an unknown token is refused, a valid token resolves a principal.
    expect((await call("/api/me", { token: "nope-nope-nope-1234" })).status).toBe(401);
    const me = await call("/api/me", { token: EDITOR });
    expect(me.status).toBe(200);
    expect(me.json.user.role).toBe("editor");
    expect(me.json.actions).toContain("edit");

    // 3. Create a project.
    const created = await call("/api/projects", { method: "POST", token: EDITOR, body: { name: "Smoke reel" } });
    expect(created.status).toBe(201);
    const projectId = created.json.project.id;

    // 4. Save a validated plan as a version.
    const plan = makeStarterPlan(getPreset("neutral-founder-reel"), { title: "Smoke" });
    const saved = await call(`/api/projects/${projectId}/plan`, { method: "POST", token: EDITOR, body: { plan } });
    expect(saved.status).toBe(201);
    const versionId = saved.json.version.id;

    // 5. Enqueue a render off the request path.
    const enq = await call(`/api/projects/${projectId}/jobs`, { method: "POST", token: EDITOR, body: { type: "render", idempotencyKey: "smoke-render", payload: { versionId } } });
    expect(enq.status).toBe(201);
    expect(enq.json.job.status).toBe("queued");

    // 6. Add a frame-anchored comment.
    const comment = await call(`/api/projects/${projectId}/versions/${versionId}/comments`, { method: "POST", token: EDITOR, body: { frame: 24, timeSec: 0.8, body: "punch in a touch" } });
    expect(comment.status).toBe(201);

    // 7. Submit for review and approve it.
    const submit = await call(`/api/projects/${projectId}/versions/${versionId}/submit`, { method: "POST", token: EDITOR });
    expect(submit.status).toBe(201);
    const decide = await call(`/api/projects/${projectId}/versions/${submit.json.version.id}/decision`, { method: "POST", token: APPROVER, body: { approved: true, notes: "good" } });
    expect(decide.status).toBe(201);
    expect(decide.json.version.status).toBe("approved");

    // 8. The browser app shell loads locally with no CDN.
    const shell = await fetch(server.url + "/");
    expect(shell.status).toBe(200);
    expect((shell.headers.get("content-type") || "")).toContain("text/html");
    const html = await shell.text();
    expect(html).toContain("Octupie Video Editor");
    expect(html).toContain("app.js");
    expect(/https?:\/\/(?!localhost|127\.0\.0\.1)/.test(html)).toBe(false);
  });

  it("serves a single-page fallback for unknown client routes", async () => {
    const deep = await fetch(server.url + "/projects/anything/edit");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("Octupie Video Editor");
  });
});
