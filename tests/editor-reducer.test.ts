import { describe, it, expect } from "vitest";
import { editorReducer, initialEditorState, MIN_CLIP_DURATION } from "../src/client/state/reducer.js";
import { emptyDoc, makeClip, makeTrack } from "../src/client/state/factory.js";
import type { EditorState, TimelineDoc } from "../src/client/state/types.js";

/*
 * The reducer is the single source of truth for every timeline edit. It is pure: no ids
 * are minted inside it (creating actions carry their new ids) so tests are deterministic.
 * Every user-facing edit operation gets a red-first test here.
 */

function seedDoc(): TimelineDoc {
  const doc = emptyDoc({ title: "T", duration: 12 });
  const video = makeTrack("video", "tk-vid", "Video");
  const caption = makeTrack("caption", "tk-cap", "Captions");
  doc.tracks = [video, caption];
  doc.clips = [
    makeClip({ id: "c1", trackId: "tk-vid", start: 0, duration: 4, mediaId: "m1", sourceDuration: 20 }),
    makeClip({ id: "c2", trackId: "tk-vid", start: 4, duration: 4, mediaId: "m1", sourceIn: 4, sourceDuration: 20 }),
    makeClip({ id: "cap1", trackId: "tk-cap", start: 0, duration: 2, text: "hello" }),
  ];
  return doc;
}

function seed(): EditorState {
  return { ...initialEditorState(), doc: seedDoc() };
}

const clip = (s: EditorState, id: string) => s.doc.clips.find((c) => c.id === id);
const track = (s: EditorState, id: string) => s.doc.tracks.find((t) => t.id === id);

describe("editor reducer: transport + selection (no history)", () => {
  it("sets the playhead without pushing history", () => {
    const s = editorReducer(seed(), { type: "SET_PLAYHEAD", time: 3.5 });
    expect(s.playhead).toBe(3.5);
    expect(s.past.length).toBe(0);
    expect(s.dirty).toBe(false);
  });

  it("clamps playhead to [0, duration]", () => {
    expect(editorReducer(seed(), { type: "SET_PLAYHEAD", time: -5 }).playhead).toBe(0);
    expect(editorReducer(seed(), { type: "SET_PLAYHEAD", time: 999 }).playhead).toBe(12);
  });

  it("zooms in and out within bounds without history", () => {
    const s0 = seed();
    const zin = editorReducer(s0, { type: "ZOOM_IN" });
    expect(zin.zoom).toBeGreaterThan(s0.zoom);
    expect(zin.past.length).toBe(0);
    const zout = editorReducer(s0, { type: "ZOOM_OUT" });
    expect(zout.zoom).toBeLessThan(s0.zoom);
  });

  it("selects a clip and its track", () => {
    const s = editorReducer(seed(), { type: "SELECT_CLIP", clipId: "c2" });
    expect(s.selectedClipId).toBe("c2");
  });
});

describe("editor reducer: move", () => {
  it("moves a clip's start and records history + dirty", () => {
    const s = editorReducer(seed(), { type: "MOVE_CLIP", clipId: "c1", start: 1.5 });
    expect(clip(s, "c1")!.start).toBe(1.5);
    expect(s.past.length).toBe(1);
    expect(s.dirty).toBe(true);
  });

  it("clamps a move to a non-negative start", () => {
    const s = editorReducer(seed(), { type: "MOVE_CLIP", clipId: "c1", start: -3 });
    expect(clip(s, "c1")!.start).toBe(0);
  });

  it("refuses to move a clip on a locked track", () => {
    let s = editorReducer(seed(), { type: "TOGGLE_LOCK", trackId: "tk-vid" });
    const before = clip(s, "c1")!.start;
    s = editorReducer(s, { type: "MOVE_CLIP", clipId: "c1", start: 5 });
    expect(clip(s, "c1")!.start).toBe(before);
  });
});

describe("editor reducer: trim", () => {
  it("right-trims by shortening duration", () => {
    const s = editorReducer(seed(), { type: "TRIM_CLIP", clipId: "c1", start: 0, end: 2.5 });
    expect(clip(s, "c1")!.duration).toBeCloseTo(2.5, 5);
    expect(clip(s, "c1")!.sourceIn).toBe(0);
  });

  it("left-trims by advancing start and sourceIn together", () => {
    const s = editorReducer(seed(), { type: "TRIM_CLIP", clipId: "c1", start: 1, end: 4 });
    const c = clip(s, "c1")!;
    expect(c.start).toBe(1);
    expect(c.duration).toBeCloseTo(3, 5);
    expect(c.sourceIn).toBeCloseTo(1, 5); // pulled 1s into the source
  });

  it("does not left-trim past the source in-point (sourceIn stays >= 0)", () => {
    // c1 starts at source 0; a left trim can never make sourceIn negative.
    const s = editorReducer(seed(), { type: "TRIM_CLIP", clipId: "c1", start: 0, end: 4 });
    expect(clip(s, "c1")!.sourceIn).toBe(0);
  });

  it("enforces a minimum clip duration", () => {
    const s = editorReducer(seed(), { type: "TRIM_CLIP", clipId: "c1", start: 0, end: 0.001 });
    expect(clip(s, "c1")!.duration).toBeGreaterThanOrEqual(MIN_CLIP_DURATION);
  });

  it("does not right-trim past the available source (sourceDuration bound)", () => {
    // c2 has sourceIn 4, sourceDuration 20 -> at most 16s available.
    const s = editorReducer(seed(), { type: "TRIM_CLIP", clipId: "c2", start: 4, end: 4 + 40 });
    expect(clip(s, "c2")!.duration).toBeLessThanOrEqual(16 + 1e-6);
  });
});

describe("editor reducer: split", () => {
  it("splits a clip at the playhead into two contiguous clips", () => {
    const s = editorReducer(seed(), { type: "SPLIT_CLIP", clipId: "c1", time: 1.5, newId: "c1b" });
    const left = clip(s, "c1")!;
    const right = clip(s, "c1b")!;
    expect(left.duration).toBeCloseTo(1.5, 5);
    expect(right.start).toBeCloseTo(1.5, 5);
    expect(right.duration).toBeCloseTo(2.5, 5);
    expect(right.sourceIn).toBeCloseTo(1.5, 5); // source continues where the left piece ended
    expect(right.trackId).toBe("tk-vid");
    expect(s.doc.clips.length).toBe(4);
  });

  it("is a no-op when the split time is outside the clip", () => {
    const s = editorReducer(seed(), { type: "SPLIT_CLIP", clipId: "c1", time: 9, newId: "x" });
    expect(s.doc.clips.length).toBe(3);
  });

  it("refuses to split on a locked track", () => {
    let s = editorReducer(seed(), { type: "TOGGLE_LOCK", trackId: "tk-vid" });
    s = editorReducer(s, { type: "SPLIT_CLIP", clipId: "c1", time: 1.5, newId: "c1b" });
    expect(s.doc.clips.length).toBe(3);
  });
});

describe("editor reducer: delete + ripple + duplicate", () => {
  it("deletes a clip and clears its selection", () => {
    let s = editorReducer(seed(), { type: "SELECT_CLIP", clipId: "c2" });
    s = editorReducer(s, { type: "DELETE_CLIP", clipId: "c2" });
    expect(clip(s, "c2")).toBeUndefined();
    expect(s.selectedClipId).toBeNull();
  });

  it("ripple-deletes and pulls later same-track clips left by the gap", () => {
    const s = editorReducer(seed(), { type: "RIPPLE_DELETE_CLIP", clipId: "c1" });
    expect(clip(s, "c1")).toBeUndefined();
    // c2 started at 4, c1 was 4s long -> c2 shifts to 0.
    expect(clip(s, "c2")!.start).toBeCloseTo(0, 5);
    // caption on the other track is untouched.
    expect(clip(s, "cap1")!.start).toBe(0);
  });

  it("duplicates a clip with a new id placed right after the original", () => {
    const s = editorReducer(seed(), { type: "DUPLICATE_CLIP", clipId: "c1", newId: "c1copy" });
    const copy = clip(s, "c1copy")!;
    expect(copy.mediaId).toBe("m1");
    expect(copy.start).toBeCloseTo(4, 5);
    expect(copy.trackId).toBe("tk-vid");
  });
});

describe("editor reducer: inspector edits", () => {
  it("sets caption text", () => {
    const s = editorReducer(seed(), { type: "SET_CLIP_TEXT", clipId: "cap1", text: "new words" });
    expect(clip(s, "cap1")!.text).toBe("new words");
  });

  it("merges a partial transform", () => {
    const s = editorReducer(seed(), { type: "SET_CLIP_TRANSFORM", clipId: "c1", transform: { scale: 1.5, x: 20 } });
    expect(clip(s, "c1")!.transform.scale).toBe(1.5);
    expect(clip(s, "c1")!.transform.x).toBe(20);
    expect(clip(s, "c1")!.transform.rotation).toBe(0);
  });

  it("sets and clamps the source in-point against the media length", () => {
    const ok = editorReducer(seed(), { type: "SET_CLIP_SOURCE_IN", clipId: "c1", sourceIn: 3 });
    expect(clip(ok, "c1")!.sourceIn).toBe(3);
    // c1 has duration 4 and sourceDuration 20 -> sourceIn cannot exceed 16.
    const clamped = editorReducer(seed(), { type: "SET_CLIP_SOURCE_IN", clipId: "c1", sourceIn: 99 });
    expect(clamped.doc.clips.find((c) => c.id === "c1")!.sourceIn).toBeLessThanOrEqual(16);
  });

  it("clamps volume and opacity to [0,1]", () => {
    const v = editorReducer(seed(), { type: "SET_CLIP_VOLUME", clipId: "c1", volume: 9 });
    expect(clip(v, "c1")!.volume).toBe(1);
    const o = editorReducer(seed(), { type: "SET_CLIP_TRANSFORM", clipId: "c1", transform: { opacity: -1 } });
    expect(clip(o, "c1")!.transform.opacity).toBe(0);
  });
});

describe("editor reducer: tracks", () => {
  it("adds a track", () => {
    const s = editorReducer(seed(), { type: "ADD_TRACK", track: makeTrack("audio", "tk-aud", "Audio") });
    expect(s.doc.tracks.some((t) => t.id === "tk-aud")).toBe(true);
  });

  it("removes a track and its clips when unlocked", () => {
    const s = editorReducer(seed(), { type: "REMOVE_TRACK", trackId: "tk-cap" });
    expect(track(s, "tk-cap")).toBeUndefined();
    expect(clip(s, "cap1")).toBeUndefined();
  });

  it("refuses to remove a locked track", () => {
    let s = editorReducer(seed(), { type: "TOGGLE_LOCK", trackId: "tk-cap" });
    s = editorReducer(s, { type: "REMOVE_TRACK", trackId: "tk-cap" });
    expect(track(s, "tk-cap")).toBeDefined();
  });

  it("reorders tracks and toggles mute/lock", () => {
    let s = editorReducer(seed(), { type: "REORDER_TRACK", trackId: "tk-cap", dir: -1 });
    expect(s.doc.tracks[0]!.id).toBe("tk-cap");
    s = editorReducer(s, { type: "TOGGLE_MUTE", trackId: "tk-vid" });
    expect(track(s, "tk-vid")!.muted).toBe(true);
  });
});

describe("editor reducer: undo/redo", () => {
  it("undoes and redoes a mutating edit", () => {
    let s = editorReducer(seed(), { type: "MOVE_CLIP", clipId: "c1", start: 2 });
    expect(clip(s, "c1")!.start).toBe(2);
    s = editorReducer(s, { type: "UNDO" });
    expect(clip(s, "c1")!.start).toBe(0);
    s = editorReducer(s, { type: "REDO" });
    expect(clip(s, "c1")!.start).toBe(2);
  });

  it("no-ops undo with empty history", () => {
    const s0 = seed();
    const s = editorReducer(s0, { type: "UNDO" });
    expect(s.doc).toEqual(s0.doc);
  });

  it("clears redo after a fresh edit", () => {
    let s = editorReducer(seed(), { type: "MOVE_CLIP", clipId: "c1", start: 2 });
    s = editorReducer(s, { type: "UNDO" });
    expect(s.future.length).toBe(1);
    s = editorReducer(s, { type: "MOVE_CLIP", clipId: "c2", start: 6 });
    expect(s.future.length).toBe(0);
  });

  it("MARK_SAVED clears dirty when the saved revision is still current", () => {
    let s = editorReducer(seed(), { type: "MOVE_CLIP", clipId: "c1", start: 2 });
    expect(s.dirty).toBe(true);
    s = editorReducer(s, { type: "MARK_SAVED", savedDoc: s.doc });
    expect(s.dirty).toBe(false);
  });

  it("MARK_SAVED leaves dirty set when an edit landed during the save (no lost state)", () => {
    // The save captured this exact revision, then a further edit arrives before the response.
    let s = editorReducer(seed(), { type: "MOVE_CLIP", clipId: "c1", start: 2 });
    const savedDoc = s.doc; // the revision the in-flight save is persisting
    s = editorReducer(s, { type: "MOVE_CLIP", clipId: "c2", start: 6 }); // mid-flight edit -> new doc ref
    expect(s.dirty).toBe(true);
    s = editorReducer(s, { type: "MARK_SAVED", savedDoc }); // stale completion for the older revision
    expect(s.dirty).toBe(true); // still dirty so the newer edit is saved next
  });

  it("MARK_SAVED for a stale revision never clears a freshly loaded document's dirty flag", () => {
    // A save response arriving after a project/version switch must not touch the new doc.
    let s = editorReducer(seed(), { type: "MOVE_CLIP", clipId: "c1", start: 2 });
    const staleDoc = s.doc;
    s = editorReducer(s, { type: "LOAD_DOC", doc: seedDoc() }); // switch to another document
    s = editorReducer(s, { type: "MOVE_CLIP", clipId: "c1", start: 3 }); // dirty the new doc
    expect(s.dirty).toBe(true);
    s = editorReducer(s, { type: "MARK_SAVED", savedDoc: staleDoc });
    expect(s.dirty).toBe(true);
  });
});
