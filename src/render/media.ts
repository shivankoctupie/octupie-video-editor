/**
 * Pure media-mapping helpers shared by the Remotion components and their tests.
 *
 * This module holds no React or Remotion imports so it can be unit-tested in
 * plain Node. It turns the plan's source-clip references into the exact values
 * a component needs: the static-file relative path, the start frame inside the
 * clip, whether to mute, and how to fit the frame.
 */

import type { EditPlan, Scene } from "../schema/editPlan.js";

export type Fit = "cover" | "contain";

export interface SceneMedia {
  /** Relative path passed to Remotion's staticFile (resolved under the public asset root). */
  path: string;
  /** First frame of the clip to show, derived from the scene or clip in-point. */
  startFromFrames: number;
  mute: boolean;
  fit: Fit;
}

export function clipById(plan: EditPlan, id: string): EditPlan["sourceClips"][number] | undefined {
  return plan.sourceClips.find((c) => c.id === id);
}

/**
 * Resolve the real source footage a scene should play, or null when the scene
 * uses procedural content. The schema guarantees a referenced clip exists; the
 * null guard keeps this safe if called on an unvalidated plan.
 */
export function sceneMedia(plan: EditPlan, scene: Scene): SceneMedia | null {
  if (!scene.sourceClipId) {
    return scene.broll
      ? { path: scene.broll, startFromFrames: 0, mute: true, fit: scene.fit ?? "cover" }
      : null;
  }
  const clip = clipById(plan, scene.sourceClipId);
  if (!clip) return null;
  const inPoint = scene.sourceIn ?? clip.in ?? 0;
  return {
    path: clip.path,
    startFromFrames: Math.round(inPoint * plan.fps),
    mute: scene.mute ?? false,
    fit: scene.fit ?? "cover",
  };
}
