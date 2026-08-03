import { describe, it, expect } from "vitest";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import {
  timelineMediaPaths,
  unresolvedTimelineMediaClipIds,
  timelineRenderLayers,
  timelineAudioClips,
  clipTransformCss,
} from "../src/render/media.js";

/*
 * Pure render-plan projections of the editor timeline. These are what the Remotion timeline
 * stage and the FFmpeg audio assembly consume, so they carry the full fidelity contract:
 * visual layers in stacking order (multiple video/overlay tracks never vanish), and audio
 * clips with their placement/trim/volume and muted-track semantics. No React, no FFmpeg.
 */

type Clip = Record<string, unknown>;
type Track = Record<string, unknown>;

function baseClip(over: Clip): Clip {
  return {
    start: 0,
    duration: 2,
    mediaId: null,
    sourceIn: 0,
    sourceDuration: null,
    text: "",
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    volume: 1,
    captionStyle: null,
    name: "clip",
    ...over,
  };
}

function planWithTimeline(tracks: Track[], clips: Clip[], over: Record<string, unknown> = {}): EditPlan {
  const raw = {
    format: "octupie-edit-plan/v1",
    title: "Timeline Projection",
    preset: "neutral-founder-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 10,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes: [{ id: "s1", type: "hook", start: 0, end: 10, heading: "Hi" }],
    output: { fileName: "output/demo.mp4" },
    timeline: {
      version: 1,
      width: 1080,
      height: 1920,
      fps: 30,
      duration: 10,
      tracks,
      clips,
      ...over,
    },
  };
  const r = parseEditPlan(raw);
  if (!r.ok || !r.plan) throw new Error(r.errors.join("; "));
  return r.plan;
}

// A rich timeline: two video tracks, an overlay, a caption, and an audio track.
function richPlan(): EditPlan {
  return planWithTimeline(
    [
      { id: "tk-v1", kind: "video", name: "Video", muted: false, locked: false },
      { id: "tk-v2", kind: "video", name: "Video 2", muted: false, locked: true },
      { id: "tk-ov", kind: "overlay", name: "Overlay", muted: false, locked: false },
      { id: "tk-cap", kind: "caption", name: "Captions", muted: false, locked: false },
      { id: "tk-aud", kind: "audio", name: "Audio", muted: false, locked: false },
    ],
    [
      baseClip({ id: "v1", trackId: "tk-v1", start: 0, duration: 4, mediaId: "m1", mediaPath: "media/a.mp4", sourceIn: 1, volume: 0.8 }),
      baseClip({ id: "v2", trackId: "tk-v2", start: 4, duration: 3, mediaId: "m1", mediaPath: "media/a.mp4", sourceIn: 0, volume: 1 }),
      baseClip({ id: "ov1", trackId: "tk-ov", start: 1, duration: 3, mediaId: "img1", mediaPath: "media/logo.png" }),
      baseClip({ id: "cap1", trackId: "tk-cap", start: 0, duration: 3, text: "we shipped", captionStyle: { fontSize: 60, color: "#F5F5F5", background: "#000000", align: "center", bold: true } }),
      baseClip({ id: "au1", trackId: "tk-aud", start: 2, duration: 5, mediaId: "aud1", mediaPath: "media/track.wav", sourceIn: 0.5, volume: 0.5 }),
    ],
  );
}

describe("timelineMediaPaths", () => {
  it("returns every distinct media path across all tracks, once each, in order", () => {
    expect(timelineMediaPaths(richPlan())).toEqual(["media/a.mp4", "media/logo.png", "media/track.wav"]);
  });

  it("is empty for a plan with no timeline", () => {
    const legacy = parseEditPlan({
      format: "octupie-edit-plan/v1",
      title: "Legacy",
      preset: "neutral-founder-reel",
      composition: "FounderSocialReel",
      width: 1080,
      height: 1920,
      fps: 30,
      duration: 6,
      brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
      scenes: [{ id: "s1", type: "hook", start: 0, end: 6, heading: "Hi" }],
      output: { fileName: "output/demo.mp4" },
    });
    expect(timelineMediaPaths(legacy.plan as EditPlan)).toEqual([]);
  });
});

describe("unresolvedTimelineMediaClipIds", () => {
  it("flags clips that reference media but carry no resolved path (fail closed)", () => {
    const plan = planWithTimeline(
      [{ id: "tk-v1", kind: "video", name: "Video", muted: false, locked: false }],
      [
        baseClip({ id: "ok", trackId: "tk-v1", start: 0, duration: 3, mediaId: "m1", mediaPath: "media/a.mp4" }),
        baseClip({ id: "bad", trackId: "tk-v1", start: 3, duration: 3, mediaId: "m2" }), // mediaId set, no path
      ],
    );
    expect(unresolvedTimelineMediaClipIds(plan)).toEqual(["bad"]);
  });

  it("does not flag pure-text clips (no media reference)", () => {
    const plan = planWithTimeline(
      [{ id: "tk-cap", kind: "caption", name: "Captions", muted: false, locked: false }],
      [baseClip({ id: "cap", trackId: "tk-cap", start: 0, duration: 3, text: "hello" })],
    );
    expect(unresolvedTimelineMediaClipIds(plan)).toEqual([]);
  });
});

describe("timelineRenderLayers", () => {
  it("projects visual tracks in stacking order and never drops a second video or overlay track", () => {
    const layers = timelineRenderLayers(richPlan());
    // Audio track excluded; video/overlay/caption kept in doc order (index 0 at the bottom).
    expect(layers.map((l) => l.track.id)).toEqual(["tk-v1", "tk-v2", "tk-ov", "tk-cap"]);
    expect(layers.map((l) => l.track.kind)).toEqual(["video", "video", "overlay", "caption"]);
    // A locked track still renders (locked is an edit lock, not a visibility toggle).
    expect(layers.find((l) => l.track.id === "tk-v2")!.track.locked).toBe(true);
    // Each track carries its own clips.
    expect(layers.find((l) => l.track.id === "tk-v1")!.clips.map((c) => c.id)).toEqual(["v1"]);
    expect(layers.find((l) => l.track.id === "tk-v2")!.clips.map((c) => c.id)).toEqual(["v2"]);
    expect(layers.find((l) => l.track.id === "tk-cap")!.clips[0]!.captionStyle!.fontSize).toBe(60);
  });
});

describe("clipTransformCss", () => {
  it("maps a clip transform to a centered translate/scale/rotate with opacity, in composition space", () => {
    const css = clipTransformCss({ x: 108, y: -192, scale: 1.5, rotation: 10, opacity: 0.5 }, 1080, 1920);
    // x/y are offsets in composition pixels expressed as a percentage of the frame, from center.
    expect(css.transform).toBe("translate(-50%, -50%) translate(10%, -10%) scale(1.5) rotate(10deg)");
    expect(css.opacity).toBe(0.5);
  });

  it("is identity-centered for a default transform", () => {
    const css = clipTransformCss({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, 1080, 1920);
    expect(css.transform).toBe("translate(-50%, -50%) translate(0%, 0%) scale(1) rotate(0deg)");
    expect(css.opacity).toBe(1);
  });
});

describe("timelineAudioClips", () => {
  it("includes video and audio clips with their placement, trim, and volume", () => {
    const clips = timelineAudioClips(richPlan());
    const byId = new Map(clips.map((c) => [c.id, c]));
    expect(byId.get("v1")).toMatchObject({ path: "media/a.mp4", start: 0, sourceIn: 1, duration: 4, volume: 0.8 });
    expect(byId.get("au1")).toMatchObject({ path: "media/track.wav", start: 2, sourceIn: 0.5, duration: 5, volume: 0.5 });
  });

  it("excludes overlay and caption clips (they carry no audio)", () => {
    const ids = timelineAudioClips(richPlan()).map((c) => c.id);
    expect(ids).not.toContain("ov1");
    expect(ids).not.toContain("cap1");
  });

  it("drops clips on a muted track and clips at zero volume", () => {
    const plan = planWithTimeline(
      [
        { id: "tk-v", kind: "video", name: "Video", muted: true, locked: false },
        { id: "tk-a", kind: "audio", name: "Audio", muted: false, locked: false },
      ],
      [
        baseClip({ id: "muted", trackId: "tk-v", start: 0, duration: 3, mediaId: "m1", mediaPath: "media/a.mp4", volume: 1 }),
        baseClip({ id: "silent", trackId: "tk-a", start: 0, duration: 3, mediaId: "a1", mediaPath: "media/b.wav", volume: 0 }),
        baseClip({ id: "audible", trackId: "tk-a", start: 1, duration: 2, mediaId: "a2", mediaPath: "media/c.wav", volume: 1 }),
      ],
    );
    expect(timelineAudioClips(plan).map((c) => c.id)).toEqual(["audible"]);
  });

  it("drops a media clip that has no resolved path", () => {
    const plan = planWithTimeline(
      [{ id: "tk-a", kind: "audio", name: "Audio", muted: false, locked: false }],
      [baseClip({ id: "nopath", trackId: "tk-a", start: 0, duration: 3, mediaId: "a1", volume: 1 })],
    );
    expect(timelineAudioClips(plan)).toEqual([]);
  });
});
