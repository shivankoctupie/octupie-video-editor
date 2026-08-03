import { describe, it, expect } from "vitest";
import { emptyDoc, makeClip, makeTrack } from "../src/client/state/factory.js";
import { SNAP_THRESHOLD_PX, pxThresholdSeconds, snapTime, collectSnapTargets, snapClipMove, snapClipTrim } from "../src/client/state/snap.js";
import type { TimelineDoc } from "../src/client/state/types.js";

/*
 * Snapping is a pure, geometric decision made just before a MOVE_CLIP / TRIM_CLIP action is
 * dispatched: given the proposed edge time and the current clips, where should the edge land?
 * The reducer still owns bounds (source in/out, minimum duration, locked tracks), so these tests
 * only prove the WHERE. Targets are the origin, the playhead, and other clips' boundaries; the
 * moving clip is excluded so an edge never snaps to itself; the threshold is 8px converted to
 * seconds by the zoom, so it stays a constant on-screen distance.
 */

function doc(): TimelineDoc {
  const d = emptyDoc({ title: "Snap", duration: 20 });
  d.tracks = [makeTrack("video", "tk-vid"), makeTrack("caption", "tk-cap")];
  d.clips = [
    makeClip({ id: "a", trackId: "tk-vid", start: 0, duration: 4 }), // [0, 4]
    makeClip({ id: "b", trackId: "tk-vid", start: 6, duration: 3 }), // [6, 9]
    makeClip({ id: "cap", trackId: "tk-cap", start: 10, duration: 2 }), // [10, 12], another track
  ];
  return d;
}

describe("snap: pixel threshold is zoom-aware", () => {
  it("converts pixels to seconds by dividing by the zoom (px/s)", () => {
    expect(pxThresholdSeconds(60, 8)).toBeCloseTo(8 / 60, 6);
    expect(pxThresholdSeconds(120, 8)).toBeCloseTo(8 / 120, 6);
    // Higher zoom -> tighter tolerance in seconds (a fixed on-screen distance).
    expect(pxThresholdSeconds(200)).toBeLessThan(pxThresholdSeconds(50));
  });

  it("defaults to an 8px threshold and guards non-positive zoom", () => {
    expect(SNAP_THRESHOLD_PX).toBe(8);
    expect(pxThresholdSeconds(0)).toBe(0);
    expect(pxThresholdSeconds(-10)).toBe(0);
  });
});

describe("snap: snapTime picks the nearest target within range", () => {
  const targets = [0, 6, 9, 10];

  it("snaps to the nearest target inside the tolerance", () => {
    // zoom 60 -> tol 0.133s; 6.05 is within 0.133 of 6.
    const r = snapTime(6.05, targets, 60);
    expect(r.snapped).toBe(true);
    expect(r.time).toBe(6);
    expect(r.target).toBe(6);
  });

  it("does not snap when every target is outside the tolerance", () => {
    const r = snapTime(6.5, targets, 60); // 0.5 > 0.133
    expect(r.snapped).toBe(false);
    expect(r.time).toBe(6.5);
    expect(r.target).toBeNull();
  });

  it("chooses the closer of two nearby targets", () => {
    // zoom 20 -> tol 0.4s; 9.3 is between 9 and 10 but closer to 9.
    expect(snapTime(9.3, targets, 20).time).toBe(9);
  });

  it("tightens with zoom: the same gap snaps zoomed out but not zoomed in", () => {
    expect(snapTime(6.1, targets, 60).snapped).toBe(true); // tol .133 > .1
    expect(snapTime(6.1, targets, 200).snapped).toBe(false); // tol .04 < .1
  });
});

describe("snap: target collection across tracks", () => {
  it("includes origin, playhead, and every other clip's start and end", () => {
    const t = collectSnapTargets(doc(), { excludeClipId: "a", playhead: 3.5 });
    expect(t).toContain(0); // origin
    expect(t).toContain(3.5); // playhead
    expect(t).toContain(6); // b.start
    expect(t).toContain(9); // b.end
    expect(t).toContain(10); // cap.start on another track
    expect(t).toContain(12); // cap.end on another track
  });

  it("excludes the moving clip's own boundaries", () => {
    const t = collectSnapTargets(doc(), { excludeClipId: "a" });
    // 4 is a's end and belongs to no other clip -> it must be absent.
    expect(t).not.toContain(4);
  });

  it("omits the playhead when it is not provided", () => {
    expect(collectSnapTargets(doc(), { excludeClipId: "a" })).not.toContain(3.5);
  });

  it("is sorted and de-duplicated", () => {
    const t = collectSnapTargets(doc(), {});
    expect(t).toEqual([...t].sort((x, y) => x - y));
    expect(new Set(t).size).toBe(t.length);
  });
});

describe("snap: whole-clip move snaps either edge and preserves duration", () => {
  it("snaps the start edge to another clip's boundary", () => {
    const targets = collectSnapTargets(doc(), { excludeClipId: "a" });
    // Drag a to ~5.95; its start is within range of b.start (6). Duration 1 keeps the end clear.
    const r = snapClipMove(5.95, 1, targets, 60);
    expect(r.snapped).toBe(true);
    expect(r.edge).toBe("start");
    expect(r.start).toBe(6);
  });

  it("snaps the end edge by shifting the whole clip left", () => {
    const targets = collectSnapTargets(doc(), { excludeClipId: "a" });
    // Duration 4; end near b.start (6) at 5.95 -> start pulled to 2.
    const r = snapClipMove(1.95, 4, targets, 60);
    expect(r.snapped).toBe(true);
    expect(r.edge).toBe("end");
    expect(r.start).toBe(2); // 6 - 4
  });

  it("does not move when neither edge is near a target", () => {
    const targets = collectSnapTargets(doc(), { excludeClipId: "a" });
    const r = snapClipMove(3.0, 0.5, targets, 200); // edges 3.0 and 3.5 far from all targets, tight tol
    expect(r.snapped).toBe(false);
    expect(r.start).toBe(3.0);
  });
});

describe("snap: trim snaps only the dragged edge", () => {
  it("left trim snaps the start and leaves the end", () => {
    const targets = collectSnapTargets(doc(), { excludeClipId: "a" });
    const r = snapClipTrim(5.95, 9.0, "left", targets, 60);
    expect(r.start).toBe(6);
    expect(r.end).toBe(9.0);
    expect(r.snapped).toBe(true);
  });

  it("right trim snaps the end and leaves the start", () => {
    const targets = collectSnapTargets(doc(), { excludeClipId: "a" });
    const r = snapClipTrim(0.0, 6.05, "right", targets, 60);
    expect(r.start).toBe(0.0);
    expect(r.end).toBe(6);
    expect(r.snapped).toBe(true);
  });

  it("never snaps the moving clip to its own edge (exclusion honored end to end)", () => {
    const withA = collectSnapTargets(doc(), {}); // includes 4 (a's own end)
    const withoutA = collectSnapTargets(doc(), { excludeClipId: "a" });
    expect(withA).toContain(4);
    expect(withoutA).not.toContain(4);
    // A right trim of 'a' to 4.02 would snap to its own end 4 if not excluded; with exclusion it must not.
    const r = snapClipTrim(0, 4.02, "right", withoutA, 60);
    expect(r.snapped).toBe(false);
    expect(r.end).toBe(4.02);
  });
});
