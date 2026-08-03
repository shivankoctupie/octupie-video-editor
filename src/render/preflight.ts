/**
 * Media preflight. Node-only (touches the filesystem), kept out of the Remotion
 * browser bundle. It resolves every local media path a plan references under the
 * asset root and confirms each file exists, so a missing or escaping asset fails
 * before any render work begins rather than partway through the pipeline.
 */

import { resolveExistingAssetPath } from "../util/assetRoot.js";
import { unresolvedTimelineMediaClipIds } from "./media.js";
import type { EditPlan } from "../schema/editPlan.js";

export function resolvePlanMedia(plan: EditPlan): void {
  for (const clip of plan.sourceClips) {
    resolveExistingAssetPath(clip.path, `source clip '${clip.id}'`);
  }
  for (const scene of plan.scenes) {
    if (scene.broll) resolveExistingAssetPath(scene.broll, `b-roll for scene '${scene.id}'`);
  }
  if (plan.audio.dialoguePath) {
    resolveExistingAssetPath(plan.audio.dialoguePath, "dialogue track");
  }
  if (plan.audio.music) {
    resolveExistingAssetPath(plan.audio.music.path, "music track");
  }
  for (const cue of plan.audio.sfx) {
    resolveExistingAssetPath(cue.asset, `sfx asset '${cue.asset}'`);
  }

  // Timeline media: fail closed on any media-backed clip with no path, then resolve every
  // referenced file so a missing or escaping timeline asset fails before render, exactly as the
  // legacy references do.
  const unresolved = unresolvedTimelineMediaClipIds(plan);
  if (unresolved.length > 0) {
    throw new Error(`timeline clip(s) reference media with no resolved media path: ${unresolved.join(", ")}`);
  }
  for (const clip of plan.timeline?.clips ?? []) {
    if (clip.mediaPath) resolveExistingAssetPath(clip.mediaPath, `timeline clip '${clip.id}'`);
  }
}
