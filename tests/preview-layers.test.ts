import { describe, expect, it } from "vitest";
import { emptyDoc, makeClip, makeTrack } from "../src/client/state/factory.js";
import { previewLayerSpecs } from "../src/client/components/Preview.js";

describe("preview layer projection", () => {
  it("preserves exact track stacking order and treats video media on an overlay track as video", () => {
    const doc = emptyDoc({ duration: 4 });
    doc.tracks = [makeTrack("video", "v"), makeTrack("caption", "c"), makeTrack("overlay", "o")];
    doc.clips = [
      makeClip({ id: "video", trackId: "v", start: 0, duration: 4, mediaId: "mv" }),
      makeClip({ id: "caption", trackId: "c", start: 0, duration: 4, text: "Behind overlay" }),
      makeClip({ id: "overlay-video", trackId: "o", start: 0, duration: 4, mediaId: "mo" }),
    ];

    const specs = previewLayerSpecs(doc, 1, new Map([["mv", "video"], ["mo", "video"]]));
    expect(specs.map((s) => [s.clip.id, s.renderAs])).toEqual([
      ["video", "video"],
      ["caption", "caption"],
      ["overlay-video", "video"],
    ]);
  });

  it("excludes inactive visual clips but retains audio elements for synchronization", () => {
    const doc = emptyDoc({ duration: 5 });
    doc.tracks = [makeTrack("overlay", "o"), makeTrack("audio", "a")];
    doc.clips = [
      makeClip({ id: "late-image", trackId: "o", start: 3, duration: 1, mediaId: "mi" }),
      makeClip({ id: "audio", trackId: "a", start: 0, duration: 5, mediaId: "ma" }),
    ];

    const specs = previewLayerSpecs(doc, 1, new Map([["mi", "image"], ["ma", "audio"]]));
    expect(specs.map((s) => [s.clip.id, s.renderAs])).toEqual([["audio", "audio"]]);
  });
});
