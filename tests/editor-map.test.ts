import { describe, it, expect } from "vitest";
import { toEditPlan, fromEditPlan, splitCaption } from "../src/client/state/editPlanMap.js";
import { emptyDoc, makeClip, makeTrack, DEFAULT_CAPTION_STYLE } from "../src/client/state/factory.js";
import type { TimelineDoc } from "../src/client/state/types.js";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import { makeStarterPlan } from "../src/presets/starter.js";
import { getPreset } from "../src/presets/index.js";

const mediaPath = (id: string): string | null =>
  id === "m1" ? "t1/p1/media/abc.mp4" : id === "img1" ? "t1/p1/media/logo.png" : id === "aud1" ? "t1/p1/media/track.wav" : null;

function richDoc(): TimelineDoc {
  const doc = emptyDoc({ title: "Rich reel", duration: 12 });
  doc.tracks = [
    makeTrack("video", "tk-vid", "Video"),
    makeTrack("overlay", "tk-ovl", "Overlay"),
    makeTrack("caption", "tk-cap", "Captions"),
    makeTrack("audio", "tk-aud", "Audio"),
  ];
  doc.clips = [
    makeClip({ id: "c1", trackId: "tk-vid", start: 0, duration: 4, mediaId: "m1", sourceIn: 0, sourceDuration: 30 }),
    makeClip({ id: "c2", trackId: "tk-vid", start: 4, duration: 4, mediaId: "m1", sourceIn: 6, sourceDuration: 30 }),
    makeClip({ id: "ov1", trackId: "tk-ovl", start: 1, duration: 3, mediaId: "img1", transform: { x: 40, y: -20, scale: 1.4, rotation: 5, opacity: 0.8 } }),
    makeClip({ id: "cap1", trackId: "tk-cap", start: 0, duration: 3, text: "we shipped it in a weekend", captionStyle: { ...DEFAULT_CAPTION_STYLE } }),
    makeClip({ id: "au1", trackId: "tk-aud", start: 0, duration: 8, mediaId: "aud1", volume: 0.5 }),
  ];
  return doc;
}

describe("editPlan mapping: round-trip", () => {
  it("produces a plan that passes the real schema validator", () => {
    const plan = toEditPlan(richDoc(), mediaPath);
    const parsed = parseEditPlan(plan);
    expect(parsed.ok, parsed.errors.join("; ")).toBe(true);
    expect(parsed.plan!.timeline).toBeDefined();
  });

  it("reproduces the exact tracks and clips from the stored timeline", () => {
    const doc = richDoc();
    const parsed = parseEditPlan(toEditPlan(doc, mediaPath));
    expect(parsed.ok).toBe(true);
    const doc2 = fromEditPlan(parsed.plan as EditPlan);
    expect(doc2.tracks.map((t) => ({ id: t.id, kind: t.kind }))).toEqual(doc.tracks.map((t) => ({ id: t.id, kind: t.kind })));
    expect(doc2.clips.map((c) => ({ id: c.id, trackId: c.trackId, start: c.start, duration: c.duration, mediaId: c.mediaId, sourceIn: c.sourceIn, text: c.text }))).toEqual(
      doc.clips.map((c) => ({ id: c.id, trackId: c.trackId, start: c.start, duration: c.duration, mediaId: c.mediaId, sourceIn: c.sourceIn, text: c.text })),
    );
    expect(doc2.clips.find((c) => c.id === "ov1")!.transform.scale).toBe(1.4);
  });

  it("carries the trimmed source in-point into the derived scene", () => {
    const parsed = parseEditPlan(toEditPlan(richDoc(), mediaPath));
    const plan = parsed.plan as EditPlan;
    const scenes = plan.scenes.filter((s) => s.sourceClipId);
    expect(scenes.length).toBe(2);
    const second = scenes[1]!;
    expect(second.sourceIn).toBeCloseTo(6, 5); // c2 sourceIn 6 preserved in the projection
    expect(plan.sourceClips.some((sc) => sc.path === "t1/p1/media/abc.mp4")).toBe(true);
  });
});

describe("editPlan mapping: timeline media paths for render fidelity", () => {
  it("carries a safe render media path for every media-backed clip kind, on every track", () => {
    const parsed = parseEditPlan(toEditPlan(richDoc(), mediaPath));
    expect(parsed.ok, parsed.errors.join("; ")).toBe(true);
    const clips = parsed.plan!.timeline!.clips;
    const byId = new Map(clips.map((c) => [c.id, c]));
    // First and second video-track clips (same media), overlay image, and audio clip all carry a path.
    expect(byId.get("c1")!.mediaPath).toBe("t1/p1/media/abc.mp4");
    expect(byId.get("c2")!.mediaPath).toBe("t1/p1/media/abc.mp4");
    expect(byId.get("ov1")!.mediaPath).toBe("t1/p1/media/logo.png"); // overlay track, not first video track
    expect(byId.get("au1")!.mediaPath).toBe("t1/p1/media/track.wav"); // audio track
    // A pure-text caption clip has no media path.
    expect(byId.get("cap1")!.mediaPath).toBeUndefined();
    // Every stored path is a portable relative path (the schema's safePath).
    for (const c of clips) if (c.mediaPath !== undefined) expect(c.mediaPath.startsWith("/")).toBe(false);
  });

  it("omits the path when the media id does not resolve (fail-open at save, fail-closed at render)", () => {
    const doc = richDoc();
    doc.clips = [makeClip({ id: "v", trackId: "tk-vid", start: 0, duration: 4, mediaId: "unknown-id", sourceDuration: 30 })];
    doc.tracks = [makeTrack("video", "tk-vid", "Video")];
    const parsed = parseEditPlan(toEditPlan(doc, mediaPath));
    expect(parsed.ok, parsed.errors.join("; ")).toBe(true);
    expect(parsed.plan!.timeline!.clips[0]!.mediaPath).toBeUndefined();
    expect(parsed.plan!.timeline!.clips[0]!.mediaId).toBe("unknown-id");
  });

  it("round-trips a timeline that has no media paths (old saved timeline) without loss", () => {
    const doc = richDoc();
    const planObj = toEditPlan(doc, mediaPath) as Record<string, unknown>;
    // Simulate a plan saved before mediaPath existed: strip every clip path.
    const tl = planObj.timeline as { clips: Array<Record<string, unknown>> };
    for (const c of tl.clips) delete c.mediaPath;
    const parsed = parseEditPlan(planObj);
    expect(parsed.ok, parsed.errors.join("; ")).toBe(true);
    const doc2 = fromEditPlan(parsed.plan as EditPlan);
    expect(doc2.clips.map((c) => c.mediaId)).toEqual(doc.clips.map((c) => c.mediaId));
  });
});

describe("editPlan mapping: caption word limit", () => {
  it("splits a long caption into <=3 word cards that pass validation", () => {
    const doc = emptyDoc({ title: "Caps", duration: 6 });
    doc.tracks = [makeTrack("video", "tk-vid"), makeTrack("caption", "tk-cap")];
    doc.clips = [
      makeClip({ id: "v", trackId: "tk-vid", start: 0, duration: 6 }),
      makeClip({ id: "c", trackId: "tk-cap", start: 0, duration: 6, text: "one two three four five six seven" }),
    ];
    const parsed = parseEditPlan(toEditPlan(doc, mediaPath));
    expect(parsed.ok, parsed.errors.join("; ")).toBe(true);
    for (const card of parsed.plan!.captions.cards) {
      expect(card.text.trim().split(/\s+/).length).toBeLessThanOrEqual(3);
    }
  });

  it("splitCaption divides time evenly and keeps every word", () => {
    const cards = splitCaption("a b c d e", 0, 10, 2);
    expect(cards.length).toBe(3);
    expect(cards.map((c) => c.text)).toEqual(["a b", "c d", "e"]);
    expect(cards[0]!.start).toBe(0);
    expect(cards[cards.length - 1]!.end).toBe(10);
  });
});

describe("editPlan mapping: overlapping video clips", () => {
  it("projects overlapping clips to non-overlapping scenes that validate", () => {
    const doc = emptyDoc({ title: "Overlap", duration: 10 });
    doc.tracks = [makeTrack("video", "tk-vid")];
    doc.clips = [
      makeClip({ id: "a", trackId: "tk-vid", start: 0, duration: 6, mediaId: "m1", sourceDuration: 30 }),
      makeClip({ id: "b", trackId: "tk-vid", start: 3, duration: 6, mediaId: "m1", sourceDuration: 30 }),
    ];
    const parsed = parseEditPlan(toEditPlan(doc, mediaPath));
    expect(parsed.ok, parsed.errors.join("; ")).toBe(true);
    const scenes = parsed.plan!.scenes;
    for (let i = 1; i < scenes.length; i++) expect(scenes[i]!.start).toBeGreaterThanOrEqual(scenes[i - 1]!.end - 1e-6);
  });
});

describe("editPlan mapping: legacy plans without a timeline", () => {
  it("synthesizes an editable document and round-trips back to a valid plan", () => {
    const starter = parseEditPlan(makeStarterPlan(getPreset("neutral-founder-reel"), { title: "Legacy" }));
    expect(starter.ok).toBe(true);
    const legacyPlan = starter.plan as EditPlan;
    expect(legacyPlan.timeline).toBeUndefined();
    const doc = fromEditPlan(legacyPlan);
    expect(doc.tracks.some((t) => t.kind === "video")).toBe(true);
    expect(doc.clips.filter((c) => c.trackId === "tk-video").length).toBe(legacyPlan.scenes.length);
    expect(doc.clips.filter((c) => c.trackId === "tk-caption").length).toBe(legacyPlan.captions.cards.length);
    // And the synthesized document maps back to a schema-valid plan.
    const back = parseEditPlan(toEditPlan(doc, mediaPath));
    expect(back.ok, back.errors.join("; ")).toBe(true);
  });
});
