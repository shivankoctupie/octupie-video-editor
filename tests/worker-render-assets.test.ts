/*
 * Worker media preparation regression.
 *
 * The browser editor persists each source clip's path as the full content-addressed
 * storage key (t1/p1/media/ab/cd/<sha>.mp4). The worker used to point OVE_ASSET_ROOT at
 * <root>/t1/p1/media and hand the plan straight to the renderer, so the key resolved to a
 * duplicated, non-existent path (t1/p1/media/t1/p1/media/...) and the final render never
 * found its bytes. `prepareRenderAssets` closes that gap: it resolves every plan media
 * path ONLY against the media rows for the exact tenant+project, copies the real bytes out
 * of storage into an isolated per-version asset root under server-derived safe names, and
 * rewrites a clone of the plan to those names. It must reject cross-tenant keys and any
 * unsafe/traversal path, and it must never mutate the stored immutable plan.
 *
 * These run against REAL content-addressed LocalStorage (no mocks), and prove the renderer
 * preflight (`resolvePlanMedia`, the exact check `renderPlan` runs first) finds the bytes
 * under the prepared root, without executing a full Remotion render.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import { createLocalStorage, type LocalStorage } from "../src/server/storage/local.js";
import type { MediaRow } from "../src/server/db/repository.js";
import { prepareRenderAssets } from "../src/server/renderAssets.js";
import { resolvePlanMedia } from "../src/render/preflight.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Store real bytes in content-addressed LocalStorage and return the media row a server
 * upload would have registered for them. */
async function storeBlob(
  storage: LocalStorage,
  storageRoot: string,
  tenantId: string,
  projectId: string,
  bytes: Buffer,
  ext = ".mp4",
  mime = "video/mp4",
): Promise<MediaRow> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const tempPath = join(storageRoot, `tmp-${sha256}${ext}.part`);
  writeFileSync(tempPath, bytes);
  const ref = await storage.materialize({ tenantId, projectId, tempPath, sha256, mime, ext });
  return {
    id: `media-${sha256.slice(0, 8)}`,
    tenantId,
    projectId,
    storageKey: ref.key,
    sha256: ref.sha256,
    size: ref.size,
    mime,
    filename: `clip${ext}`,
    origin: "upload",
    uploadedBy: "editor",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

/** A minimal valid plan whose single source clip carries `path`. */
function planWithClip(path: string): EditPlan {
  const raw = {
    format: "octupie-edit-plan/v1",
    title: "Render Assets",
    preset: "neutral-founder-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 6,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes: [{ id: "s1", type: "hook", start: 0, end: 6, sourceClipId: "src-1" }],
    sourceClips: [{ id: "src-1", path }],
    output: { fileName: "output/demo.mp4" },
  };
  const r = parseEditPlan(raw);
  if (!r.ok || !r.plan) throw new Error(r.errors.join("; "));
  return r.plan;
}

const mediaRel = (storageKey: string, tenantId = "t1", projectId = "p1"): string =>
  storageKey.slice(`${tenantId}/${projectId}/media/`.length);

/** A minimal valid plan whose media lives ONLY in the timeline (a video-track clip carrying
 * `mediaPath`), with no legacy source-clip/audio references. Proves the preparer copies and
 * rewrites timeline media, not just the legacy projection. `mediaId` may be omitted to exercise
 * the fail-closed gate. */
function planWithTimelineClip(mediaPath: string | undefined, mediaId: string | null = "m1"): EditPlan {
  const clip: Record<string, unknown> = {
    id: "tc1",
    trackId: "tk-v",
    start: 0,
    duration: 6,
    mediaId,
    sourceIn: 0,
    sourceDuration: null,
    text: "",
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    volume: 1,
    captionStyle: null,
    name: "clip",
    ...(mediaPath !== undefined ? { mediaPath } : {}),
  };
  const raw = {
    format: "octupie-edit-plan/v1",
    title: "Timeline Assets",
    preset: "neutral-founder-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 6,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes: [{ id: "s1", type: "hook", start: 0, end: 6, heading: "Hi" }],
    output: { fileName: "output/demo.mp4" },
    timeline: {
      version: 1,
      width: 1080,
      height: 1920,
      fps: 30,
      duration: 6,
      tracks: [{ id: "tk-v", kind: "video", name: "Video", muted: false, locked: false }],
      clips: [clip],
    },
  };
  const r = parseEditPlan(raw);
  if (!r.ok || !r.plan) throw new Error(r.errors.join("; "));
  return r.plan;
}

describe("prepareRenderAssets", () => {
  it("rewrites an uploaded-media storage key to a safe name and copies the exact bytes", async () => {
    const storageRoot = tmp("oct-ra-store-");
    const destRoot = tmp("oct-ra-dest-");
    const storage = createLocalStorage(storageRoot);
    const bytes = Buffer.from("real mp4 payload \x00\x01\x02 body", "binary");
    const row = await storeBlob(storage, storageRoot, "t1", "p1", bytes);
    // The buggy client form: the full content-addressed key as the clip path.
    const plan = planWithClip(row.storageKey);

    const prepared = await prepareRenderAssets({
      plan,
      tenantId: "t1",
      projectId: "p1",
      mediaRows: [row],
      storage,
      destRoot,
    });

    const expectedRel = mediaRel(row.storageKey);
    expect(prepared.plan.sourceClips[0]!.path).toBe(expectedRel);
    expect(prepared.assetRoot).toBe(destRoot);

    // The exact bytes are present under the prepared root.
    const copied = join(destRoot, expectedRel);
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied).equals(bytes)).toBe(true);

    // The stored immutable plan is never mutated.
    expect(plan.sourceClips[0]!.path).toBe(row.storageKey);

    // The exact preflight `renderPlan` runs first resolves under the prepared root.
    const prev = process.env.OVE_ASSET_ROOT;
    process.env.OVE_ASSET_ROOT = destRoot;
    try {
      expect(() => resolvePlanMedia(prepared.plan)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.OVE_ASSET_ROOT;
      else process.env.OVE_ASSET_ROOT = prev;
    }
  });

  it("resolves a legacy media-relative path against the project media rows", async () => {
    const storageRoot = tmp("oct-ra-store-");
    const destRoot = tmp("oct-ra-dest-");
    const storage = createLocalStorage(storageRoot);
    const bytes = Buffer.from("legacy relative payload");
    const row = await storeBlob(storage, storageRoot, "t1", "p1", bytes);
    // A legacy plan that stored the path relative to the project media root (no prefix).
    const rel = mediaRel(row.storageKey);
    const plan = planWithClip(rel);

    const prepared = await prepareRenderAssets({ plan, tenantId: "t1", projectId: "p1", mediaRows: [row], storage, destRoot });

    expect(prepared.plan.sourceClips[0]!.path).toBe(rel);
    expect(existsSync(join(destRoot, rel))).toBe(true);
    expect(readFileSync(join(destRoot, rel)).equals(bytes)).toBe(true);
  });

  it("rejects a media key that belongs to another tenant/project even with identical bytes", async () => {
    const storageRoot = tmp("oct-ra-store-");
    const destRoot = tmp("oct-ra-dest-");
    const storage = createLocalStorage(storageRoot);
    const bytes = Buffer.from("shared payload bytes");
    // Same content stored in BOTH projects, but the plan references the foreign key.
    const mine = await storeBlob(storage, storageRoot, "t1", "p1", bytes);
    const foreign = await storeBlob(storage, storageRoot, "t2", "p2", bytes);
    const plan = planWithClip(foreign.storageKey);

    await expect(
      prepareRenderAssets({ plan, tenantId: "t1", projectId: "p1", mediaRows: [mine], storage, destRoot }),
    ).rejects.toThrow();
    // Nothing was copied out for the foreign key.
    expect(existsSync(join(destRoot, mediaRel(foreign.storageKey, "t2", "p2")))).toBe(false);
  });

  it("rejects a project with no matching media row (missing media, fail closed)", async () => {
    const storageRoot = tmp("oct-ra-store-");
    const destRoot = tmp("oct-ra-dest-");
    const storage = createLocalStorage(storageRoot);
    const row = await storeBlob(storage, storageRoot, "t1", "p1", Buffer.from("bytes"));
    const plan = planWithClip(row.storageKey);
    // The plan references a real key, but listMedia returned nothing for this project.
    await expect(
      prepareRenderAssets({ plan, tenantId: "t1", projectId: "p1", mediaRows: [], storage, destRoot }),
    ).rejects.toThrow();
  });

  it("rejects an unsafe traversal media path", async () => {
    const storageRoot = tmp("oct-ra-store-");
    const destRoot = tmp("oct-ra-dest-");
    const storage = createLocalStorage(storageRoot);
    const row = await storeBlob(storage, storageRoot, "t1", "p1", Buffer.from("bytes"));
    const plan = planWithClip(row.storageKey);
    // Bypass the schema gate to prove the preparer independently refuses traversal.
    (plan.sourceClips[0] as { path: string }).path = "../../etc/passwd";
    await expect(
      prepareRenderAssets({ plan, tenantId: "t1", projectId: "p1", mediaRows: [row], storage, destRoot }),
    ).rejects.toThrow();
  });

  it("rejects an absolute media path", async () => {
    const storageRoot = tmp("oct-ra-store-");
    const destRoot = tmp("oct-ra-dest-");
    const storage = createLocalStorage(storageRoot);
    const row = await storeBlob(storage, storageRoot, "t1", "p1", Buffer.from("bytes"));
    const plan = planWithClip(row.storageKey);
    (plan.sourceClips[0] as { path: string }).path = "/etc/passwd";
    await expect(
      prepareRenderAssets({ plan, tenantId: "t1", projectId: "p1", mediaRows: [row], storage, destRoot }),
    ).rejects.toThrow();
  });

  it("copies and rewrites a timeline clip's media path (not only legacy source clips)", async () => {
    const storageRoot = tmp("oct-ra-store-");
    const destRoot = tmp("oct-ra-dest-");
    const storage = createLocalStorage(storageRoot);
    const bytes = Buffer.from("timeline overlay payload \x00\x01 body", "binary");
    const row = await storeBlob(storage, storageRoot, "t1", "p1", bytes, ".png", "image/png");
    const plan = planWithTimelineClip(row.storageKey);

    const prepared = await prepareRenderAssets({ plan, tenantId: "t1", projectId: "p1", mediaRows: [row], storage, destRoot });

    const expectedRel = mediaRel(row.storageKey);
    // The timeline clip now points at the safe server-derived name, and the bytes are present.
    expect(prepared.plan.timeline!.clips[0]!.mediaPath).toBe(expectedRel);
    expect(readFileSync(join(destRoot, expectedRel)).equals(bytes)).toBe(true);
    // The stored immutable plan's timeline is never mutated.
    expect(plan.timeline!.clips[0]!.mediaPath).toBe(row.storageKey);
    // The preflight the pipeline runs first resolves the timeline media under the prepared root.
    const prev = process.env.OVE_ASSET_ROOT;
    process.env.OVE_ASSET_ROOT = destRoot;
    try {
      expect(() => resolvePlanMedia(prepared.plan)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.OVE_ASSET_ROOT;
      else process.env.OVE_ASSET_ROOT = prev;
    }
  });

  it("rejects a cross-tenant timeline media key", async () => {
    const storageRoot = tmp("oct-ra-store-");
    const destRoot = tmp("oct-ra-dest-");
    const storage = createLocalStorage(storageRoot);
    const bytes = Buffer.from("shared timeline bytes");
    const mine = await storeBlob(storage, storageRoot, "t1", "p1", bytes);
    const foreign = await storeBlob(storage, storageRoot, "t2", "p2", bytes);
    const plan = planWithTimelineClip(foreign.storageKey);
    await expect(
      prepareRenderAssets({ plan, tenantId: "t1", projectId: "p1", mediaRows: [mine], storage, destRoot }),
    ).rejects.toThrow();
  });

  it("rejects a traversal timeline media path", async () => {
    const storageRoot = tmp("oct-ra-store-");
    const destRoot = tmp("oct-ra-dest-");
    const storage = createLocalStorage(storageRoot);
    const row = await storeBlob(storage, storageRoot, "t1", "p1", Buffer.from("bytes"));
    const plan = planWithTimelineClip(row.storageKey);
    (plan.timeline!.clips[0] as { mediaPath: string }).mediaPath = "../../etc/passwd";
    await expect(
      prepareRenderAssets({ plan, tenantId: "t1", projectId: "p1", mediaRows: [row], storage, destRoot }),
    ).rejects.toThrow();
  });

  it("fails closed on a media-backed timeline clip that carries no resolved path", async () => {
    const storageRoot = tmp("oct-ra-store-");
    const destRoot = tmp("oct-ra-dest-");
    const storage = createLocalStorage(storageRoot);
    const row = await storeBlob(storage, storageRoot, "t1", "p1", Buffer.from("bytes"));
    // The clip references media (mediaId set) but has no mediaPath: it can never render.
    const plan = planWithTimelineClip(undefined, "m-unresolved");
    await expect(
      prepareRenderAssets({ plan, tenantId: "t1", projectId: "p1", mediaRows: [row], storage, destRoot }),
    ).rejects.toThrow(/tc1|resolved media path|no media/i);
  });
});
