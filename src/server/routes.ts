/**
 * REST route handlers for the product server.
 *
 * Every handler is tenant-scoped through the authenticated principal, validates its
 * input, and records an audit event for state changes. Rendering never happens here:
 * a render request only enqueues a durable job for the worker to claim. Uploads stream
 * to a temp file and materialize into content-addressed storage. Publishing runs the
 * full gate flow and is disabled unless an operator has configured an adapter and a
 * publishing grant.
 */

import { requireGrant, evaluatePermission, PermissionDeniedError, type PermissionPolicy } from "../permissions/policy.js";
import { actionsForRole } from "../workflow/rbac.js";
import { JOB_TYPES, type JobType } from "../workflow/schemas.js";
import { parseEditPlan } from "../schema/editPlan.js";
import { getPreset, listPresets } from "../presets/index.js";
import { makeStarterPlan } from "../presets/starter.js";
import { parseImageRequest, parseTtsRequest, localImageProvider, localTtsProvider, writeGeneratedAsset } from "../generation/index.js";
import { materializeWebAsset, materializeDriveFile, type MaterializedAssetValue } from "../materialize/index.js";
import type { AdapterOutputValue, PublishRequestValue } from "../workflow/schemas.js";
import type { PublishingAdapter } from "../workflow/publishing.js";
import type { FetchLike } from "../util/fetchLike.js";
import type { HostResolver } from "../util/ssrf.js";
import { unlinkSync } from "node:fs";
import { HttpError, readJsonBody, sendJson, sendBytes, type Ctx, type Router } from "./http.js";
import { resolveUploadType, streamToTempFile } from "./upload.js";
import { writePlan, readPlan } from "./plans.js";
import { compareVersions } from "./compare.js";
import { RepositoryError, type MediaRow, type Repository, type VersionRow } from "./db/repository.js";
import { contentKey, type StorageAdapter } from "./storage/adapter.js";
import type { ServerConfig } from "./config.js";

export interface RouteDeps {
  repo: Repository;
  storage: StorageAdapter;
  config: ServerConfig;
  policy: PermissionPolicy;
  adapters: Map<string, PublishingAdapter>;
  /** Injected transport for materialization (defaults to the SSRF-pinning node fetch in app
   * wiring, which pins the connect to the validated public IP; tests inject an offline stub). */
  fetch: FetchLike;
  /** Injected DNS resolver for materialization SSRF checks. */
  resolve: HostResolver;
  /** Env var name holding an optional Google Drive OAuth token (read at call time only). */
  driveTokenEnv: string;
  now: () => string;
  id: () => string;
}

/** Extension for a materialized asset's mime, so the stored key carries a hint. The mime
 * itself is authoritative and recorded in the provenance sidecar. */
const MIME_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
};

function str(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number } = {}): string {
  const v = body[key];
  if (typeof v !== "string") throw new HttpError(400, "bad-field", `Field '${key}' must be a string.`);
  const t = v.trim();
  if (t.length < (opts.min ?? 1)) throw new HttpError(400, "bad-field", `Field '${key}' is too short.`);
  if (t.length > (opts.max ?? 1000)) throw new HttpError(400, "bad-field", `Field '${key}' is too long.`);
  return t;
}
function optBool(body: Record<string, unknown>, key: string): boolean {
  return body[key] === true;
}
function numField(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number; int?: boolean } = {}): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, "bad-field", `Field '${key}' must be a number.`);
  if (opts.int && !Number.isInteger(v)) throw new HttpError(400, "bad-field", `Field '${key}' must be an integer.`);
  if (opts.min !== undefined && v < opts.min) throw new HttpError(400, "bad-field", `Field '${key}' is below ${opts.min}.`);
  if (opts.max !== undefined && v > opts.max) throw new HttpError(400, "bad-field", `Field '${key}' is above ${opts.max}.`);
  return v;
}

/** Atomically reserve `addBytes` of durable storage for a tenant BEFORE a write, returning the
 * reservation id to later settle (on successful media registration) or release (on failure).
 * Throws a 413 when the tenant has no room. The check and the reservation are one transaction,
 * so concurrent requests can never both cross the quota boundary (uploads, generated assets,
 * and materialized imports all count). */
function reserveTenantQuota(deps: RouteDeps, tenantId: string, addBytes: number): string {
  const res = deps.repo.reserveQuota({ id: `qr-${deps.id()}`, tenantId, bytes: addBytes, maxBytes: deps.config.maxTenantBytes });
  if (!res.ok) {
    throw new HttpError(413, "quota-exceeded", `Tenant storage quota exceeded: ${res.used + addBytes} of ${deps.config.maxTenantBytes} bytes.`);
  }
  return res.id;
}

/** Remove a just-written materialized asset and its two sidecars, used to clean up a
 * partial artifact when a quota (or other post-write) check rejects the import. */
function removeMaterialized(assetPath: string): void {
  for (const p of [assetPath, `${assetPath}.rights.json`, `${assetPath}.materialized.json`]) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone; ignore */
    }
  }
}

/** Load a project scoped to the principal's tenant, or 404. */
function requireProject(deps: RouteDeps, ctx: Ctx, projectId: string): { tenantId: string } {
  const tenantId = ctx.principal!.tenantId;
  const project = deps.repo.getProject(tenantId, projectId);
  if (!project) throw new HttpError(404, "no-project", `No project '${projectId}'.`);
  return { tenantId };
}

function requireVersion(deps: RouteDeps, tenantId: string, projectId: string, versionId: string): VersionRow {
  const v = deps.repo.getVersion(tenantId, projectId, versionId);
  if (!v) throw new HttpError(404, "no-version", `No version '${versionId}'.`);
  return v;
}

export function registerRoutes(router: Router, deps: RouteDeps): void {
  const { repo } = deps;

  // ---- health and identity ----
  router.add("GET", "/api/health", "public", (ctx) => {
    sendJson(ctx.res, 200, { ok: true, name: deps.config.name, version: deps.config.version, time: deps.now() });
  });

  router.add("GET", "/api/me", "view", (ctx) => {
    const p = ctx.principal!;
    sendJson(ctx.res, 200, { user: p, actions: actionsForRole(p.role) });
  });

  // Honest capability panel for the UI. It states exactly what is verified locally, what
  // is configured but unproven, and what is intentionally disabled. It never leaks a
  // secret: only grant action names, who granted, and expiry are surfaced.
  router.add("GET", "/api/status", "view", (ctx) => {
    const at = new Date(deps.now());
    const has = (a: "network" | "media-upload" | "publishing" | "code-change"): boolean => evaluatePermission(a, deps.policy, at).allowed;
    sendJson(ctx.res, 200, {
      name: deps.config.name,
      version: deps.config.version,
      storage: deps.storage.describe(),
      publishing: {
        adapters: [...deps.adapters.values()].map((a) => ({ id: a.id, enabled: a.enabled })),
        webhookConfigured: Boolean(deps.config.webhook),
        publishingGrant: has("publishing"),
      },
      generation: {
        localImage: { id: localImageProvider.id, verified: true, note: "deterministic offline SVG" },
        localTts: { id: localTtsProvider.id, verified: true, note: "labelled silent test WAV" },
        httpAdaptersConfigured: false,
        note: "OpenAI-compatible HTTP adapters exist but are off unless configured with an env key and a network grant; they never claim verification.",
      },
      materialization: {
        web: { enabled: has("network") && has("media-upload"), note: "needs network + media-upload grants; SSRF-guarded, rights required." },
        drive: { enabled: has("network") && has("media-upload"), tokenEnvSet: Boolean(process.env[deps.driveTokenEnv]), note: "official Drive v3 media endpoint only; token read from env at call time." },
      },
      grants: deps.policy.grants.map((g) => ({ action: g.action, grantedBy: g.grantedBy, ...(g.expiresAt ? { expiresAt: g.expiresAt } : {}), ...(g.reason ? { reason: g.reason } : {}) })),
    });
  });

  router.add("GET", "/api/audit", "view", (ctx) => {
    const limit = Math.min(Math.max(Number(ctx.query.get("limit") ?? 100) || 100, 1), 500);
    sendJson(ctx.res, 200, { audit: repo.listAudit(ctx.principal!.tenantId, limit) });
  });

  // ---- projects ----
  router.add("GET", "/api/projects", "view", (ctx) => {
    sendJson(ctx.res, 200, { projects: repo.listProjects(ctx.principal!.tenantId) });
  });

  router.add("POST", "/api/projects", "edit", async (ctx) => {
    const body = await readJsonBody(ctx.req, deps.config.maxJsonBytes);
    const name = str(body, "name", { max: 200 });
    const project = repo.createProject({ id: `proj-${deps.id()}`, tenantId: ctx.principal!.tenantId, name, createdBy: ctx.principal!.username });
    repo.appendAudit({ tenantId: project.tenantId, actor: ctx.principal!.username, action: "project.create", subject: project.id });
    sendJson(ctx.res, 201, { project });
  });

  router.add("GET", "/api/projects/:id", "view", (ctx) => {
    const { tenantId } = requireProject(deps, ctx, ctx.params.id!);
    sendJson(ctx.res, 200, { project: repo.getProject(tenantId, ctx.params.id!) });
  });

  // ---- media upload and browse ----
  router.add("POST", "/api/projects/:id/media", "edit", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const filename = (ctx.req.headers["x-filename"] as string | undefined) ?? ctx.query.get("filename") ?? undefined;
    const { mime, ext } = resolveUploadType(ctx.req.headers["content-type"], filename);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(deps.config.tempDir, { recursive: true });
    const streamed = await streamToTempFile(ctx.req, { tempDir: deps.config.tempDir, maxBytes: deps.config.maxUploadBytes });
    // Reserve the per-tenant quota atomically BEFORE durable storage. Content-addressed dedup
    // means re-storing identical bytes adds nothing, so only reserve when this content is not
    // already stored; on a quota rejection remove the partial temp file.
    const alreadyStored = await deps.storage.has(contentKey(tenantId, projectId, streamed.sha256, ext));
    let reservationId: string | undefined;
    if (!alreadyStored) {
      try {
        reservationId = reserveTenantQuota(deps, tenantId, streamed.size);
      } catch (err) {
        try {
          unlinkSync(streamed.tempPath);
        } catch {
          /* already gone; ignore */
        }
        throw err;
      }
    }
    let media: MediaRow;
    try {
      const ref = await deps.storage.materialize({ tenantId, projectId, tempPath: streamed.tempPath, sha256: streamed.sha256, mime, ext });
      // Settle exactly once: register the media row and drop the reservation in one transaction.
      media = repo.settleMedia({
        ...(reservationId ? { reservationId } : {}),
        media: {
          id: `media-${deps.id()}`,
          tenantId,
          projectId,
          storageKey: ref.key,
          sha256: ref.sha256,
          size: ref.size,
          mime,
          filename: filename ?? `upload${ext}`,
          origin: "upload",
          uploadedBy: ctx.principal!.username,
        },
      });
    } catch (err) {
      // The write or registration failed: free the reservation and any leftover temp file.
      if (reservationId) repo.releaseReservation(reservationId);
      try {
        unlinkSync(streamed.tempPath);
      } catch {
        /* already consumed or gone; ignore */
      }
      throw err;
    }
    repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: "media.upload", subject: media.id, detail: `${media.size} bytes ${mime}` });
    sendJson(ctx.res, 201, { media });
  });

  router.add("GET", "/api/projects/:id/media", "view", (ctx) => {
    const { tenantId } = requireProject(deps, ctx, ctx.params.id!);
    sendJson(ctx.res, 200, { media: repo.listMedia(tenantId, ctx.params.id!) });
  });

  // Serve the actual bytes of one media item (upload, generated, or materialized) so the
  // browser app can preview it. Tenant/project scoped; the storage adapter re-checks
  // containment on the key before any read.
  router.add("GET", "/api/projects/:id/media/:mid/content", "view", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const media = repo.getMedia(tenantId, ctx.params.mid!);
    if (!media || media.projectId !== projectId) throw new HttpError(404, "no-media", `No media '${ctx.params.mid}'.`);
    let bytes: Buffer;
    try {
      bytes = await deps.storage.read(media.storageKey);
    } catch {
      throw new HttpError(404, "no-bytes", "The stored bytes for this media are unavailable.");
    }
    sendBytes(ctx.res, 200, media.mime, bytes, media.filename);
  });

  // ---- presets and starter plans ----
  router.add("GET", "/api/presets", "view", (ctx) => {
    sendJson(ctx.res, 200, { presets: listPresets() });
  });

  // Seed a new, schema-valid draft version from a preset so the browser editor always
  // starts from a plan the server has already validated, then lets the user edit it.
  router.add("POST", "/api/projects/:id/plan/starter", "edit", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const body = await readJsonBody(ctx.req, deps.config.maxJsonBytes);
    const presetId = str(body, "preset", { max: 120 });
    let preset;
    try {
      preset = getPreset(presetId);
    } catch {
      throw new HttpError(400, "no-preset", `Unknown preset '${presetId}'.`);
    }
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : undefined;
    const duration = typeof body.duration === "number" && Number.isFinite(body.duration) ? body.duration : undefined;
    const plan = makeStarterPlan(preset, { ...(title ? { title } : {}), ...(duration ? { duration } : {}) });
    const parsed = parseEditPlan(plan);
    if (!parsed.ok) throw new HttpError(500, "bad-starter", `Starter plan failed validation: ${parsed.errors.join("; ")}`);
    const saved = writePlan(deps.config.storageRoot, tenantId, projectId, parsed.plan);
    const parent = repo.latestVersion(tenantId, projectId);
    const version = repo.appendVersion({
      id: `ver-${deps.id()}`,
      tenantId,
      projectId,
      parentVersionId: parent ? parent.id : null,
      planPath: saved.relPath,
      planSha256: saved.sha256,
      creator: ctx.principal!.username,
      status: "draft",
    });
    repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: "plan.starter", subject: version.id, detail: presetId });
    sendJson(ctx.res, 201, { version, plan: parsed.plan });
  });

  // ---- plan save / load and versions ----
  router.add("POST", "/api/projects/:id/plan", "edit", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const body = await readJsonBody(ctx.req, deps.config.maxJsonBytes);
    const parsed = parseEditPlan(body.plan);
    if (!parsed.ok) throw new HttpError(400, "invalid-plan", `Plan failed validation: ${parsed.errors.join("; ")}`);
    const saved = writePlan(deps.config.storageRoot, tenantId, projectId, parsed.plan);
    const parent = repo.latestVersion(tenantId, projectId);
    // No-op save: the plan is byte-identical to the latest version, so appending would create a
    // duplicate immutable version (autosaves would spam the history). Return the existing version
    // instead, truthfully flagged as not created.
    if (parent && parent.planSha256 === saved.sha256) {
      sendJson(ctx.res, 200, { version: parent, created: false });
      return;
    }
    const version = repo.appendVersion({
      id: `ver-${deps.id()}`,
      tenantId,
      projectId,
      parentVersionId: parent ? parent.id : null,
      planPath: saved.relPath,
      planSha256: saved.sha256,
      creator: ctx.principal!.username,
      status: "draft",
    });
    repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: "plan.save", subject: version.id });
    sendJson(ctx.res, 201, { version, created: true });
  });

  router.add("GET", "/api/projects/:id/plan", "view", (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const versionId = ctx.query.get("version");
    const version = versionId ? repo.getVersion(tenantId, projectId, versionId) : repo.latestVersion(tenantId, projectId);
    if (!version) throw new HttpError(404, "no-version", "No saved plan version.");
    sendJson(ctx.res, 200, { version, plan: readPlan(deps.config.storageRoot, version.planPath) });
  });

  router.add("GET", "/api/projects/:id/versions", "view", (ctx) => {
    const { tenantId } = requireProject(deps, ctx, ctx.params.id!);
    sendJson(ctx.res, 200, { versions: repo.listVersions(tenantId, ctx.params.id!) });
  });

  router.add("GET", "/api/projects/:id/versions/:vid", "view", (ctx) => {
    const { tenantId } = requireProject(deps, ctx, ctx.params.id!);
    const version = requireVersion(deps, tenantId, ctx.params.id!, ctx.params.vid!);
    sendJson(ctx.res, 200, { version, plan: readPlan(deps.config.storageRoot, version.planPath) });
  });

  // ---- version comparison ----
  router.add("GET", "/api/projects/:id/compare", "view", (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const aId = ctx.query.get("a");
    const bId = ctx.query.get("b");
    if (!aId || !bId) throw new HttpError(400, "bad-compare", "Both 'a' and 'b' version ids are required.");
    const a = requireVersion(deps, tenantId, projectId, aId);
    const b = requireVersion(deps, tenantId, projectId, bId);
    const planA = readPlan(deps.config.storageRoot, a.planPath);
    const planB = readPlan(deps.config.storageRoot, b.planPath);
    sendJson(ctx.res, 200, { comparison: compareVersions(a, b, planA, planB) });
  });

  // ---- jobs (render/QA off the request path) ----
  router.add("POST", "/api/projects/:id/jobs", "edit", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const body = await readJsonBody(ctx.req, deps.config.maxJsonBytes);
    const type = str(body, "type") as JobType;
    if (!(JOB_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "bad-type", `Unknown job type '${type}'.`);
    // Publishing is not runnable through the generic job queue; it has its own fully gated flow
    // (POST /api/projects/:id/publish). Reject it here so the queue never advertises a capability
    // the worker cannot run.
    if (type === "publish") {
      throw new HttpError(400, "unsupported-job", "Publish is not runnable via the generic job queue; use POST /api/projects/:id/publish.");
    }
    const payload = (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {}) as Record<string, unknown>;
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
    const { job, created } = repo.enqueueJob({
      id: `job-${deps.id()}`,
      tenantId,
      projectId,
      type,
      payload,
      enqueuedBy: ctx.principal!.username,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (created) repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: "job.enqueue", subject: job.id, detail: type });
    sendJson(ctx.res, created ? 201 : 200, { job, created });
  });

  router.add("GET", "/api/projects/:id/jobs", "view", (ctx) => {
    const { tenantId } = requireProject(deps, ctx, ctx.params.id!);
    const jobs = repo.listJobs(tenantId).filter((j) => j.projectId === ctx.params.id);
    sendJson(ctx.res, 200, { jobs });
  });

  router.add("GET", "/api/jobs/:jid", "view", (ctx) => {
    const job = repo.getJob(ctx.principal!.tenantId, ctx.params.jid!);
    if (!job) throw new HttpError(404, "no-job", `No job '${ctx.params.jid}'.`);
    sendJson(ctx.res, 200, { job, attempts: repo.listAttempts(job.id) });
  });

  // ---- frame-anchored comments ----
  router.add("POST", "/api/projects/:id/versions/:vid/comments", "view", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    requireVersion(deps, tenantId, projectId, ctx.params.vid!);
    const body = await readJsonBody(ctx.req, deps.config.maxJsonBytes);
    const comment = repo.addComment({
      id: `cmt-${deps.id()}`,
      tenantId,
      projectId,
      versionId: ctx.params.vid!,
      frame: numField(body, "frame", { min: 0, int: true }),
      timeSec: numField(body, "timeSec", { min: 0 }),
      author: ctx.principal!.username,
      body: str(body, "body", { max: 4000 }),
    });
    repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: "comment.add", subject: comment.id });
    sendJson(ctx.res, 201, { comment });
  });

  router.add("GET", "/api/projects/:id/versions/:vid/comments", "view", (ctx) => {
    const { tenantId } = requireProject(deps, ctx, ctx.params.id!);
    sendJson(ctx.res, 200, { comments: repo.listComments(tenantId, ctx.params.id!, ctx.params.vid!) });
  });

  router.add("POST", "/api/comments/:cid/resolve", "edit", (ctx) => {
    const comment = repo.resolveComment({ tenantId: ctx.principal!.tenantId, commentId: ctx.params.cid!, resolvedBy: ctx.principal!.username });
    sendJson(ctx.res, 200, { comment });
  });

  // ---- review: submit and decide ----
  router.add("POST", "/api/projects/:id/versions/:vid/submit", "submit-review", (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const source = requireVersion(deps, tenantId, projectId, ctx.params.vid!);
    const version = repo.appendVersion({
      id: `ver-${deps.id()}`,
      tenantId,
      projectId,
      parentVersionId: source.id,
      planPath: source.planPath,
      planSha256: source.planSha256,
      masterPath: source.masterPath,
      masterSha256: source.masterSha256,
      creator: ctx.principal!.username,
      status: "in-review",
    });
    repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: "review.submit", subject: version.id });
    sendJson(ctx.res, 201, { version });
  });

  router.add("POST", "/api/projects/:id/versions/:vid/decision", "decide-review", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const source = requireVersion(deps, tenantId, projectId, ctx.params.vid!);
    if (source.status !== "in-review") throw new HttpError(409, "not-in-review", `Version '${source.id}' is '${source.status}', not in-review.`);
    const body = await readJsonBody(ctx.req, deps.config.maxJsonBytes);
    const approved = optBool(body, "approved");
    const notes = typeof body.notes === "string" ? body.notes.slice(0, 4000) : undefined;
    // The authoritative single-winner guard lives inside recordDecision's transaction; a
    // lost race (or a repeat) surfaces as a clean 409, not a duplicate decision.
    let out;
    try {
      out = repo.recordDecision({
        id: `dec-${deps.id()}`,
        tenantId,
        projectId,
        versionId: source.id,
        approved,
        approver: ctx.principal!.username,
        role: ctx.principal!.role,
        ...(notes ? { notes } : {}),
      });
    } catch (err) {
      if (err instanceof RepositoryError && (err.code === "already-decided" || err.code === "not-in-review")) {
        throw new HttpError(409, err.code, err.message);
      }
      throw err;
    }
    repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: approved ? "review.approve" : "review.reject", subject: out.version.id });
    sendJson(ctx.res, 201, { decision: out.decision, version: out.version });
  });

  // ---- QA report read ----
  router.add("GET", "/api/projects/:id/versions/:vid/qa", "view", (ctx) => {
    const { tenantId } = requireProject(deps, ctx, ctx.params.id!);
    const report = repo.latestQaReport(tenantId, ctx.params.id!, ctx.params.vid!);
    sendJson(ctx.res, 200, { qa: report });
  });

  // ---- generation (local deterministic providers surfaced with provenance) ----
  router.add("POST", "/api/projects/:id/generate/image", "edit", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const body = await readJsonBody(ctx.req, deps.config.maxJsonBytes);
    const parsed = parseImageRequest({ format: "svg", width: 1080, height: 1080, ...body });
    if (!parsed.ok || !parsed.data) throw new HttpError(400, "bad-image-request", parsed.errors.join("; "));
    const output = await localImageProvider.generate(parsed.data, deps.policy);
    // Reserve before writing the asset; settle on registration, release if writing fails.
    const reservationId = reserveTenantQuota(deps, tenantId, output.bytes.byteLength);
    const relPath = `${tenantId}/${projectId}/generated/gen-${deps.id()}.svg`;
    let written: ReturnType<typeof writeGeneratedAsset>;
    let media: MediaRow;
    try {
      written = writeGeneratedAsset({
        outDir: deps.config.storageRoot,
        relPath,
        bytes: output.bytes,
        mime: output.mime,
        kind: "image",
        provider: localImageProvider.id,
        requestSummary: parsed.data.prompt.slice(0, 200),
        label: "AI-generated proof card (local deterministic SVG, not photographic or sourced media)",
        now: new Date(deps.now()),
      });
      media = repo.settleMedia({
        reservationId,
        media: {
          id: `media-${deps.id()}`,
          tenantId,
          projectId,
          storageKey: relPath,
          sha256: written.record.sha256,
          size: written.record.bytes,
          mime: output.mime,
          filename: `${written.record.sha256.slice(0, 12)}.svg`,
          origin: "generated",
          uploadedBy: ctx.principal!.username,
        },
      });
    } catch (err) {
      repo.releaseReservation(reservationId);
      throw err;
    }
    repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: "generate.image", subject: media.id });
    sendJson(ctx.res, 201, { media, provenance: written.record });
  });

  router.add("POST", "/api/projects/:id/generate/tts", "edit", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const body = await readJsonBody(ctx.req, deps.config.maxJsonBytes);
    const parsed = parseTtsRequest({ format: "wav", ...body });
    if (!parsed.ok || !parsed.data) throw new HttpError(400, "bad-tts-request", parsed.errors.join("; "));
    const output = await localTtsProvider.synthesize(parsed.data, deps.policy);
    // Reserve before writing the asset; settle on registration, release if writing fails.
    const reservationId = reserveTenantQuota(deps, tenantId, output.bytes.byteLength);
    const relPath = `${tenantId}/${projectId}/generated/gen-${deps.id()}.wav`;
    let written: ReturnType<typeof writeGeneratedAsset>;
    let media: MediaRow;
    try {
      written = writeGeneratedAsset({
        outDir: deps.config.storageRoot,
        relPath,
        bytes: output.bytes,
        mime: output.mime,
        kind: "audio",
        provider: localTtsProvider.id,
        requestSummary: parsed.data.text.slice(0, 200),
        label: "Synthetic test audio (silent WAV, not human speech or sourced audio)",
        now: new Date(deps.now()),
      });
      media = repo.settleMedia({
        reservationId,
        media: {
          id: `media-${deps.id()}`,
          tenantId,
          projectId,
          storageKey: relPath,
          sha256: written.record.sha256,
          size: written.record.bytes,
          mime: output.mime,
          filename: `${written.record.sha256.slice(0, 12)}.wav`,
          origin: "generated",
          uploadedBy: ctx.principal!.username,
        },
      });
    } catch (err) {
      repo.releaseReservation(reservationId);
      throw err;
    }
    repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: "generate.tts", subject: media.id });
    sendJson(ctx.res, 201, { media, provenance: written.record });
  });

  // ---- controlled materialization (web + official Google Drive) ----
  // Both pull real bytes and are default-denied: they require a `network` and a
  // `media-upload` grant, reusable-rights metadata, and pass SSRF/redirect/byte/type
  // caps in the materialize module. Transport and DNS are injected. Without the grants
  // the module throws PermissionDeniedError, surfaced here as a clean 403.
  router.add("POST", "/api/projects/:id/materialize/web", "edit", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const body = await readJsonBody(ctx.req, deps.config.maxJsonBytes);
    const url = str(body, "url", { max: 2048 });
    const relPath = `${tenantId}/${projectId}/materialized/mat-${deps.id()}`;
    let out;
    try {
      out = await materializeWebAsset({
        url,
        rights: body.rights,
        relPath,
        outDir: deps.config.storageRoot,
        policy: deps.policy,
        fetch: deps.fetch,
        resolve: deps.resolve,
        now: new Date(deps.now()),
      });
    } catch (err) {
      throw materializeError(err);
    }
    // Reserve the quota once the byte size is known, before durable registration; on a
    // rejection remove the just-written asset + sidecars so nothing partial is left behind.
    let reservationId: string;
    try {
      reservationId = reserveTenantQuota(deps, tenantId, out.record.bytes);
    } catch (err) {
      removeMaterialized(out.assetPath);
      throw err;
    }
    let media: MediaRow;
    try {
      media = registerMaterialized(deps, ctx, tenantId, projectId, out.record, "web", reservationId);
    } catch (err) {
      repo.releaseReservation(reservationId);
      removeMaterialized(out.assetPath);
      throw err;
    }
    repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: "materialize.web", subject: media.id, detail: url.slice(0, 200) });
    sendJson(ctx.res, 201, { media, provenance: out.record });
  });

  router.add("POST", "/api/projects/:id/materialize/drive", "edit", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const body = await readJsonBody(ctx.req, deps.config.maxJsonBytes);
    const fileId = str(body, "fileId", { max: 256 });
    const relPath = `${tenantId}/${projectId}/materialized/mat-${deps.id()}`;
    let out;
    try {
      out = await materializeDriveFile({
        fileId,
        rights: body.rights,
        relPath,
        outDir: deps.config.storageRoot,
        policy: deps.policy,
        fetch: deps.fetch,
        accessTokenEnv: deps.driveTokenEnv,
        now: new Date(deps.now()),
      });
    } catch (err) {
      throw materializeError(err);
    }
    let reservationId: string;
    try {
      reservationId = reserveTenantQuota(deps, tenantId, out.record.bytes);
    } catch (err) {
      removeMaterialized(out.assetPath);
      throw err;
    }
    let media: MediaRow;
    try {
      media = registerMaterialized(deps, ctx, tenantId, projectId, out.record, "drive", reservationId);
    } catch (err) {
      repo.releaseReservation(reservationId);
      removeMaterialized(out.assetPath);
      throw err;
    }
    repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: "materialize.drive", subject: media.id, detail: `drive:${fileId}` });
    sendJson(ctx.res, 201, { media, provenance: out.record });
  });

  // ---- publish (disabled by default; full gate flow) ----
  router.add("POST", "/api/projects/:id/publish", "publish", async (ctx) => {
    const projectId = ctx.params.id!;
    const { tenantId } = requireProject(deps, ctx, projectId);
    const body = await readJsonBody(ctx.req, deps.config.maxJsonBytes);
    const result = await runPublish(deps, ctx, tenantId, projectId, body);
    sendJson(ctx.res, result.status === "published" ? 201 : 409, result);
  });
}

/** Register a freshly materialized asset as project media, carrying its provenance, settling
 * the quota reservation and the media insert in one transaction (exactly once). */
function registerMaterialized(
  deps: RouteDeps,
  ctx: Ctx,
  tenantId: string,
  projectId: string,
  record: MaterializedAssetValue,
  origin: "web" | "drive",
  reservationId: string,
): MediaRow {
  const ext = MIME_EXT[record.mime] ?? "";
  return deps.repo.settleMedia({
    reservationId,
    media: {
      id: `media-${deps.id()}`,
      tenantId,
      projectId,
      storageKey: record.relPath,
      sha256: record.sha256,
      size: record.bytes,
      mime: record.mime,
      filename: `${record.sha256.slice(0, 12)}${ext}`,
      origin,
      uploadedBy: ctx.principal!.username,
    },
  });
}

/** Map a materialization failure to a safe HTTP error. A missing grant is a clean 403;
 * a rights/SSRF/cap failure is a 400 with the module's own message (which never carries
 * a secret or a token). */
function materializeError(err: unknown): HttpError {
  if (err instanceof PermissionDeniedError) return new HttpError(403, "permission", err.message);
  return new HttpError(400, "materialize-failed", err instanceof Error ? err.message : String(err));
}

interface PublishResult {
  status: "published" | "blocked" | "failed";
  gate?: string;
  reason: string;
  receiptId?: string;
  providerRef?: string;
}

async function runPublish(deps: RouteDeps, ctx: Ctx, tenantId: string, projectId: string, body: Record<string, unknown>): Promise<PublishResult> {
  const versionId = str(body, "versionId");
  const adapterId = str(body, "adapterId");
  const idempotencyKey = str(body, "idempotencyKey");
  const rightsConfirmed = optBool(body, "rightsConfirmed");

  const version = deps.repo.getVersion(tenantId, projectId, versionId);
  if (!version) return { status: "blocked", gate: "version", reason: `No version '${versionId}'.` };
  if (version.status !== "approved") return { status: "blocked", gate: "approval", reason: `Version is '${version.status}', not approved.` };

  try {
    requireGrant("publishing", deps.policy, new Date(deps.now()));
  } catch (err) {
    if (err instanceof PermissionDeniedError) return { status: "blocked", gate: "permission", reason: err.message };
    throw err;
  }
  // Rights confirmation stays an explicit caller gate.
  if (!rightsConfirmed) return { status: "blocked", gate: "rights", reason: "rightsConfirmed must be true." };
  // QA is authoritative from the STORED report for this exact approved version, never the
  // caller's qaPassed claim: a passing QA report must exist before the version may publish.
  const qa = deps.repo.latestQaReport(tenantId, projectId, versionId);
  if (!qa) return { status: "blocked", gate: "qa", reason: "No QA report exists for this version; a passing QA report is required to publish." };
  if (qa.pass !== true) return { status: "blocked", gate: "qa", reason: "The stored QA report for this version did not pass; publishing is refused." };

  const adapter = deps.adapters.get(adapterId);
  if (!adapter) return { status: "blocked", gate: "adapter", reason: `No adapter '${adapterId}'.` };
  if (!adapter.enabled || adapter.id === "disabled") return { status: "blocked", gate: "adapter-disabled", reason: `Adapter '${adapterId}' is disabled.` };

  if (deps.repo.getReceipt(tenantId, adapterId, idempotencyKey)) {
    return { status: "blocked", gate: "idempotency", reason: `A receipt for key '${idempotencyKey}' already exists.` };
  }

  const request: PublishRequestValue = {
    format: "octupie-workflow-publish-request/v1",
    versionId,
    projectId,
    adapterId,
    requestedBy: ctx.principal!.username,
    role: ctx.principal!.role,
    rightsConfirmed,
    // Authoritative: a passing stored QA report was confirmed above, not the caller's claim.
    qaPassed: true,
    idempotencyKey,
    requestedAt: deps.now(),
  };
  let output: AdapterOutputValue;
  try {
    output = await adapter.publish(request);
  } catch (err) {
    return { status: "failed", gate: "adapter", reason: `Adapter threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (output.ok !== true) return { status: "blocked", gate: "adapter-blocked", reason: output.blockedReason ?? "Adapter blocked the publish." };

  const receiptId = `rcpt-${deps.id()}`;
  deps.repo.createReceipt({
    id: receiptId,
    tenantId,
    projectId,
    versionId,
    adapterId,
    idempotencyKey,
    ...(output.providerRef ? { providerRef: output.providerRef } : {}),
    publishedBy: ctx.principal!.username,
    data: output.data,
  });
  deps.repo.appendAudit({ tenantId, actor: ctx.principal!.username, action: "publish", subject: versionId, detail: adapterId });
  return { status: "published", reason: `Published '${versionId}' via '${adapterId}'.`, receiptId, ...(output.providerRef ? { providerRef: output.providerRef } : {}) };
}
