/**
 * Media preflight. Node-only (touches the filesystem), kept out of the Remotion
 * browser bundle. It resolves every local media path a plan references under the
 * asset root and confirms each file exists, so a missing or escaping asset fails
 * before any render work begins rather than partway through the pipeline.
 */

import { resolveExistingAssetPath } from "../util/assetRoot.js";
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
}
