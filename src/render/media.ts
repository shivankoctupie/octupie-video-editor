/**
 * Pure media-mapping helpers shared by the Remotion components and their tests.
 *
 * This module holds no React or Remotion imports so it can be unit-tested in
 * plain Node. It turns the plan's source-clip references into the exact values
 * a component needs: the static-file relative path, the start frame inside the
 * clip, whether to mute, and how to fit the frame.
 */

import type { EditPlan, Scene, TimelineClipValue, TimelineTrackValue } from "../schema/editPlan.js";

export type Fit = "cover" | "contain";

/** Kinds that carry a visible layer in the final master, in the order they stack (video at the
 * bottom). Audio tracks are excluded here; their sound is assembled by the FFmpeg layer. */
const VISUAL_KINDS = new Set(["video", "overlay", "caption"]);
/** Kinds whose clips contribute audio to the final mix (overlay images and captions do not). */
const AUDIBLE_KINDS = new Set(["video", "audio"]);

/** One visible timeline track paired with its clips, in the order the renderer paints them. */
export interface TimelineRenderLayer {
  track: TimelineTrackValue;
  clips: TimelineClipValue[];
}

/** An audio-contributing timeline clip, resolved to the values the FFmpeg mix graph needs. */
export interface TimelineAudioClip {
  id: string;
  path: string;
  /** Timeline start, seconds. */
  start: number;
  /** Trim in-point into the source media, seconds. */
  sourceIn: number;
  /** Length on the timeline, seconds. */
  duration: number;
  /** 0..1 clip gain (the track's mute has already been applied by excluding muted tracks). */
  volume: number;
}

/** Every distinct media path a timeline references, in first-seen order. Used by the worker to
 * copy and rewrite timeline media alongside the legacy source-clip/audio references. */
export function timelineMediaPaths(plan: EditPlan): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const clip of plan.timeline?.clips ?? []) {
    if (clip.mediaPath && !seen.has(clip.mediaPath)) {
      seen.add(clip.mediaPath);
      out.push(clip.mediaPath);
    }
  }
  return out;
}

/** Ids of timeline clips that reference media (`mediaId` set) but carry no resolved `mediaPath`.
 * The renderer fails closed on these: a media-backed clip with no bytes is never rendered
 * silently. */
export function unresolvedTimelineMediaClipIds(plan: EditPlan): string[] {
  const out: string[] = [];
  for (const clip of plan.timeline?.clips ?? []) {
    if (clip.mediaId !== null && !clip.mediaPath) out.push(clip.id);
  }
  return out;
}

/** The transform a clip carries (offset in composition pixels, scale, rotation, 0..1 opacity). */
export interface ClipTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

/** Map a clip transform to the same centered translate/scale/rotate the WYSIWYG preview uses, in
 * composition space, so the final master matches the editor. x/y are pixel offsets expressed as a
 * percentage of the frame from its center; the caller positions the layer at the frame center. */
export function clipTransformCss(t: ClipTransform, compW: number, compH: number): { transform: string; opacity: number } {
  const tx = (t.x / compW) * 100;
  const ty = (t.y / compH) * 100;
  return {
    transform: `translate(-50%, -50%) translate(${tx}%, ${ty}%) scale(${t.scale}) rotate(${t.rotation}deg)`,
    opacity: t.opacity,
  };
}

/** Project the timeline into ordered visible layers (video, overlay, caption) with their clips.
 * Track order is stacking order, so later tracks paint on top. Locked tracks still render:
 * `locked` is an edit lock in the editor, not a visibility toggle, and the WYSIWYG preview shows
 * them, so the final master must match. */
export function timelineRenderLayers(plan: EditPlan): TimelineRenderLayer[] {
  const tl = plan.timeline;
  if (!tl) return [];
  const layers: TimelineRenderLayer[] = [];
  for (const track of tl.tracks) {
    if (!VISUAL_KINDS.has(track.kind)) continue;
    layers.push({ track, clips: tl.clips.filter((c) => c.trackId === track.id) });
  }
  return layers;
}

/** Project the timeline into the audio clips that reach the final mix: clips on unmuted video or
 * audio tracks, with a resolved path and non-zero volume. Overlay and caption tracks are silent. */
export function timelineAudioClips(plan: EditPlan): TimelineAudioClip[] {
  const tl = plan.timeline;
  if (!tl) return [];
  const audibleTrackIds = new Set(tl.tracks.filter((t) => AUDIBLE_KINDS.has(t.kind) && !t.muted).map((t) => t.id));
  const out: TimelineAudioClip[] = [];
  for (const clip of tl.clips) {
    if (!audibleTrackIds.has(clip.trackId)) continue;
    if (!clip.mediaPath || clip.volume <= 0) continue;
    out.push({ id: clip.id, path: clip.mediaPath, start: clip.start, sourceIn: clip.sourceIn, duration: clip.duration, volume: clip.volume });
  }
  return out;
}

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
