/**
 * Worker-side render asset preparation.
 *
 * The browser editor persists each media reference (source clip, b-roll, dialogue, music,
 * SFX) as the FULL content-addressed storage key, e.g. `t1/p1/media/ab/cd/<sha>.mp4`.
 * The deterministic pipeline resolves every plan path relative to one asset root, so if the
 * worker points that root at `<root>/t1/p1/media` the key resolves to a duplicated,
 * non-existent path (`t1/p1/media/t1/p1/media/...`) and the final render never finds its
 * bytes.
 *
 * This module prepares an isolated per-version asset root the render can actually resolve:
 *  - Every plan media path is resolved ONLY against the media rows for the exact
 *    tenant+project (the caller passes `repo.listMedia(tenantId, projectId)`), so a key from
 *    another tenant/project, or one with no row, is refused. Nothing about a plan path is
 *    trusted beyond the safe-relative check the schema already applies.
 *  - The bytes are copied out of storage (via `localPath` for a local store, else `read`, so
 *    it works for any StorageAdapter) into `destRoot` under a SERVER-derived safe name (the
 *    media-relative portion of the row's own content key, `ab/cd/<sha>.ext`). The name comes
 *    from the trusted row, never from the plan, and the destination is re-checked for
 *    containment, so a plan can never write or read outside the prepared root.
 *  - A CLONE of the plan is rewritten to those safe names; the stored immutable plan is
 *    never mutated. The rewritten clone is re-validated before it is returned.
 *
 * The caller sets `OVE_ASSET_ROOT` to the returned `assetRoot`, runs `renderPlan`, and is
 * responsible for cleaning up the prepared directory once the render is done.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseEditPlan, type EditPlan } from "../schema/editPlan.js";
import { timelineMediaPaths, unresolvedTimelineMediaClipIds } from "../render/media.js";
import { assertContainedPath, assertSafeRelativePath } from "../util/paths.js";
import type { MediaRow } from "./db/repository.js";
import type { StorageAdapter } from "./storage/adapter.js";

export interface PrepareRenderAssetsInput {
  /** The validated plan to render. It is read only; a rewritten clone is returned. */
  plan: EditPlan;
  tenantId: string;
  projectId: string;
  /** Media rows for the EXACT tenant+project, i.e. `repo.listMedia(tenantId, projectId)`. */
  mediaRows: MediaRow[];
  storage: StorageAdapter;
  /** Absolute directory (under the version render dir) to copy resolved media into. */
  destRoot: string;
}

export interface PreparedRenderAssets {
  /** A rewritten clone of the plan with every media path pointing at a safe relative name. */
  plan: EditPlan;
  /** The prepared asset root; pass this as OVE_ASSET_ROOT to `renderPlan`. */
  assetRoot: string;
  /** One entry per distinct blob copied, for logging and tests. */
  copied: Array<{ storageKey: string; relName: string }>;
}

/**
 * Resolve, copy, and rewrite a plan's media into an isolated asset root. Throws on any media
 * reference that is unsafe, escapes the root, or does not resolve to a media row for this
 * exact tenant+project (fail closed: a missing or foreign asset never renders silently).
 */
export async function prepareRenderAssets(input: PrepareRenderAssetsInput): Promise<PreparedRenderAssets> {
  const { plan, tenantId, projectId, mediaRows, storage, destRoot } = input;
  const rootAbs = resolve(destRoot);
  const prefix = `${tenantId}/${projectId}/media/`;

  // Fail closed before any copy: a timeline clip that references media but resolved no path can
  // never be rendered, so refuse the whole render rather than silently drop its footage.
  const unresolved = unresolvedTimelineMediaClipIds(plan);
  if (unresolved.length > 0) {
    throw new Error(`timeline clip(s) reference media with no resolved media path: ${unresolved.join(", ")}`);
  }

  // Index this project's media by both its full storage key and its media-relative form, so a
  // plan path resolves whether the editor stored the full key or a legacy media-relative path.
  // Only this project's rows populate the index, so a cross-tenant/project key cannot match.
  const byRef = new Map<string, MediaRow>();
  for (const row of mediaRows) {
    byRef.set(row.storageKey, row);
    if (row.storageKey.startsWith(prefix)) byRef.set(row.storageKey.slice(prefix.length), row);
  }

  const refs = collectMediaRefs(plan);
  const rewrite = new Map<string, string>();
  const copied: Array<{ storageKey: string; relName: string }> = [];
  const doneKeys = new Set<string>();

  for (const ref of refs) {
    if (rewrite.has(ref)) continue;
    // Never trust a plan path: reject absolute, drive, UNC, `~`, or any parent-escape segment.
    const safe = assertSafeRelativePath(ref, "media path");
    const row = byRef.get(safe);
    if (!row) {
      throw new Error(`media not found for ${tenantId}/${projectId}: ${JSON.stringify(ref)}`);
    }
    if (!row.storageKey.startsWith(prefix)) {
      // The row must belong to this project; listMedia guarantees this, so this is defensive.
      throw new Error(`media row is not under ${prefix}: ${JSON.stringify(row.storageKey)}`);
    }
    // The safe destination name is the row's OWN content-relative key (server-derived), never
    // anything from the plan. Re-check it is a portable relative path and stays inside destRoot.
    const relName = assertSafeRelativePath(row.storageKey.slice(prefix.length), "media name");
    const dest = resolve(rootAbs, relName);
    assertContainedPath(dest, rootAbs, "prepared media path");
    rewrite.set(ref, relName);

    if (!doneKeys.has(row.storageKey)) {
      doneKeys.add(row.storageKey);
      mkdirSync(dirname(dest), { recursive: true });
      if (!existsSync(dest)) {
        const src = storage.localPath(row.storageKey);
        if (src) copyFileSync(src, dest);
        else writeFileSync(dest, await storage.read(row.storageKey));
      }
      copied.push({ storageKey: row.storageKey, relName });
    }
  }

  const rewritten = applyRewrite(plan, rewrite);
  const parsed = parseEditPlan(rewritten);
  if (!parsed.ok || !parsed.plan) {
    throw new Error(`rewritten plan failed validation: ${parsed.errors.join("; ")}`);
  }
  return { plan: parsed.plan, assetRoot: rootAbs, copied };
}

/** Every distinct local media path the render will resolve, in plan order: the legacy
 * source-clip/b-roll/audio references AND every media-backed timeline clip. */
function collectMediaRefs(plan: EditPlan): string[] {
  const refs: string[] = [];
  for (const clip of plan.sourceClips) refs.push(clip.path);
  for (const scene of plan.scenes) if (scene.broll) refs.push(scene.broll);
  if (plan.audio.dialoguePath) refs.push(plan.audio.dialoguePath);
  if (plan.audio.music) refs.push(plan.audio.music.path);
  for (const cue of plan.audio.sfx) refs.push(cue.asset);
  for (const path of timelineMediaPaths(plan)) refs.push(path);
  return refs;
}

/** Deep-clone the plan and swap every media path for its prepared safe name. The stored
 * plan object is untouched. */
function applyRewrite(plan: EditPlan, rewrite: Map<string, string>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(plan)) as EditPlan;
  const map = (p: string): string => rewrite.get(p) ?? p;
  for (const clip of clone.sourceClips) clip.path = map(clip.path);
  for (const scene of clone.scenes) if (scene.broll) scene.broll = map(scene.broll);
  if (clone.audio.dialoguePath) clone.audio.dialoguePath = map(clone.audio.dialoguePath);
  if (clone.audio.music) clone.audio.music.path = map(clone.audio.music.path);
  for (const cue of clone.audio.sfx) cue.asset = map(cue.asset);
  if (clone.timeline) for (const clip of clone.timeline.clips) if (clip.mediaPath) clip.mediaPath = map(clip.mediaPath);
  return clone as unknown as Record<string, unknown>;
}
