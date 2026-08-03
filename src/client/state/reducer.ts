/*
 * The editor reducer: every timeline edit operation, as a pure function of (state, action).
 *
 * Purity rules that keep this testable and deterministic:
 *  - No ids are minted here. Actions that create a clip/track carry the new id.
 *  - No Date/Math.random. No DOM. No mutation of the input state.
 *  - A "mutating" action either returns a new document (which snapshots the previous doc
 *    onto the undo stack and marks the state dirty) or, when the edit is invalid or a
 *    no-op (locked track, out-of-range split), returns the state unchanged with no history
 *    entry, so undo never replays a non-edit.
 */

import type { Clip, EditorAction, EditorState, TimelineDoc, Transform } from "./types.js";
import { emptyDoc } from "./factory.js";

export const MIN_CLIP_DURATION = 0.05;
export const ZOOM_MIN = 12;
export const ZOOM_MAX = 400;
export const DEFAULT_ZOOM = 60;
const MAX_HISTORY = 100;

export function initialEditorState(): EditorState {
  return {
    doc: emptyDoc(),
    selectedClipId: null,
    selectedTrackId: null,
    playhead: 0,
    zoom: DEFAULT_ZOOM,
    past: [],
    future: [],
    dirty: false,
  };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const round = (n: number): number => Math.round(n * 1000) / 1000;

function trackOf(doc: TimelineDoc, trackId: string) {
  return doc.tracks.find((t) => t.id === trackId);
}
function clipTrackLocked(doc: TimelineDoc, clip: Clip): boolean {
  const t = trackOf(doc, clip.trackId);
  return t ? t.locked : false;
}

/** Deep clone a doc for a history snapshot / mutation base. */
function cloneDoc(doc: TimelineDoc): TimelineDoc {
  return structuredClone(doc);
}

/**
 * Apply a mutation to a cloned document. The producer returns the next doc, or null to
 * signal "no change" (no history entry, state returned as-is). On a real change we push
 * the PREVIOUS doc onto the undo stack, clear redo, and mark dirty.
 */
function mutate(state: EditorState, produce: (doc: TimelineDoc) => TimelineDoc | null): EditorState {
  const draft = cloneDoc(state.doc);
  const next = produce(draft);
  if (next === null) return state;
  const past = [...state.past, state.doc];
  if (past.length > MAX_HISTORY) past.shift();
  return { ...state, doc: next, past, future: [], dirty: true };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    // ---- transport / view / selection (never touch history) ----
    case "SET_PLAYHEAD":
      return { ...state, playhead: clamp(action.time, 0, state.doc.duration) };
    case "SET_ZOOM":
      return { ...state, zoom: clamp(action.zoom, ZOOM_MIN, ZOOM_MAX) };
    case "ZOOM_IN":
      return { ...state, zoom: clamp(round(state.zoom * 1.4), ZOOM_MIN, ZOOM_MAX) };
    case "ZOOM_OUT":
      return { ...state, zoom: clamp(round(state.zoom / 1.4), ZOOM_MIN, ZOOM_MAX) };
    case "SELECT_CLIP":
      return { ...state, selectedClipId: action.clipId, selectedTrackId: selectTrackForClip(state.doc, action.clipId) };
    case "SELECT_TRACK":
      return { ...state, selectedTrackId: action.trackId };

    case "LOAD_DOC":
      return {
        ...initialEditorState(),
        doc: action.doc,
        zoom: state.zoom,
        playhead: action.resetPlayhead === false ? clamp(state.playhead, 0, action.doc.duration) : 0,
      };

    // ---- clip edits ----
    case "ADD_CLIP":
      return mutate(state, (doc) => {
        const track = trackOf(doc, action.clip.trackId);
        if (!track || track.locked) return null;
        doc.clips.push({ ...action.clip });
        return doc;
      });

    case "MOVE_CLIP":
      return mutate(state, (doc) => {
        const c = doc.clips.find((x) => x.id === action.clipId);
        if (!c || clipTrackLocked(doc, c)) return null;
        const targetTrackId = action.trackId ?? c.trackId;
        const target = trackOf(doc, targetTrackId);
        if (!target || target.locked) return null;
        const newStart = round(Math.max(0, action.start));
        if (newStart === c.start && targetTrackId === c.trackId) return null;
        c.start = newStart;
        c.trackId = targetTrackId;
        return doc;
      });

    case "TRIM_CLIP":
      return mutate(state, (doc) => {
        const c = doc.clips.find((x) => x.id === action.clipId);
        if (!c || clipTrackLocked(doc, c)) return null;
        applyTrim(c, action.start, action.end);
        return doc;
      });

    case "SPLIT_CLIP":
      return mutate(state, (doc) => {
        const c = doc.clips.find((x) => x.id === action.clipId);
        if (!c || clipTrackLocked(doc, c)) return null;
        const end = c.start + c.duration;
        if (action.time <= c.start + 1e-6 || action.time >= end - 1e-6) return null;
        const leftDur = round(action.time - c.start);
        const rightDur = round(end - action.time);
        const right: Clip = {
          ...structuredClone(c),
          id: action.newId,
          start: round(action.time),
          duration: rightDur,
          sourceIn: round(c.sourceIn + leftDur),
        };
        c.duration = leftDur;
        const idx = doc.clips.indexOf(c);
        doc.clips.splice(idx + 1, 0, right);
        return doc;
      });

    case "DELETE_CLIP":
      return deleteClip(state, action.clipId, false);

    case "RIPPLE_DELETE_CLIP":
      return deleteClip(state, action.clipId, true);

    case "DUPLICATE_CLIP":
      return mutate(state, (doc) => {
        const c = doc.clips.find((x) => x.id === action.clipId);
        if (!c || clipTrackLocked(doc, c)) return null;
        const copy: Clip = { ...structuredClone(c), id: action.newId, start: round(c.start + c.duration), name: `${c.name} copy` };
        const idx = doc.clips.indexOf(c);
        doc.clips.splice(idx + 1, 0, copy);
        return doc;
      });

    case "SET_CLIP_TEXT":
      return updateClip(state, action.clipId, (c) => {
        c.text = action.text;
      });

    case "SET_CLIP_TRANSFORM":
      return updateClip(state, action.clipId, (c) => {
        c.transform = normalizeTransform({ ...c.transform, ...action.transform });
      });

    case "SET_CLIP_VOLUME":
      return updateClip(state, action.clipId, (c) => {
        c.volume = clamp(action.volume, 0, 1);
      });

    case "SET_CLIP_SOURCE_IN":
      return updateClip(state, action.clipId, (c) => {
        const max = c.sourceDuration !== null ? Math.max(0, c.sourceDuration - c.duration) : Number.POSITIVE_INFINITY;
        c.sourceIn = round(clamp(action.sourceIn, 0, max));
      });

    case "SET_CLIP_TIMING":
      return updateClip(state, action.clipId, (c) => {
        if (action.start !== undefined) c.start = round(Math.max(0, action.start));
        if (action.duration !== undefined) c.duration = round(Math.max(MIN_CLIP_DURATION, action.duration));
      });

    case "SET_CAPTION_STYLE":
      return updateClip(state, action.clipId, (c) => {
        const base = c.captionStyle ?? { fontSize: 54, color: "#F5F5F5", background: "#000000", align: "center", bold: true };
        c.captionStyle = { ...base, ...action.style };
      });

    // ---- track edits ----
    case "ADD_TRACK":
      return mutate(state, (doc) => {
        if (doc.tracks.some((t) => t.id === action.track.id)) return null;
        const at = action.index === undefined ? doc.tracks.length : clamp(action.index, 0, doc.tracks.length);
        doc.tracks.splice(at, 0, { ...action.track });
        return doc;
      });

    case "REMOVE_TRACK":
      return mutate(state, (doc) => {
        const t = trackOf(doc, action.trackId);
        if (!t || t.locked) return null;
        doc.tracks = doc.tracks.filter((x) => x.id !== action.trackId);
        doc.clips = doc.clips.filter((c) => c.trackId !== action.trackId);
        return doc;
      });

    case "REORDER_TRACK":
      return mutate(state, (doc) => {
        const i = doc.tracks.findIndex((t) => t.id === action.trackId);
        const j = i + action.dir;
        if (i < 0 || j < 0 || j >= doc.tracks.length) return null;
        const tmp = doc.tracks[i]!;
        doc.tracks[i] = doc.tracks[j]!;
        doc.tracks[j] = tmp;
        return doc;
      });

    case "TOGGLE_MUTE":
      return mutate(state, (doc) => {
        const t = trackOf(doc, action.trackId);
        if (!t) return null;
        t.muted = !t.muted;
        return doc;
      });

    case "TOGGLE_LOCK":
      return mutate(state, (doc) => {
        const t = trackOf(doc, action.trackId);
        if (!t) return null;
        t.locked = !t.locked;
        return doc;
      });

    case "RENAME_TRACK":
      return mutate(state, (doc) => {
        const t = trackOf(doc, action.trackId);
        if (!t) return null;
        t.name = action.name;
        return doc;
      });

    case "SET_META":
      return mutate(state, (doc) => {
        if (action.meta.title !== undefined) doc.meta.title = action.meta.title;
        if (action.meta.duration !== undefined) doc.duration = round(Math.max(MIN_CLIP_DURATION, action.meta.duration));
        if (action.meta.fps !== undefined) doc.fps = Math.max(1, Math.round(action.meta.fps));
        return doc;
      });

    // ---- history ----
    case "UNDO": {
      if (state.past.length === 0) return state;
      const past = state.past.slice();
      const prev = past.pop()!;
      return { ...state, doc: prev, past, future: [state.doc, ...state.future], dirty: true, ...clampSelection(prev, state) };
    }
    case "REDO": {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return { ...state, doc: next!, past: [...state.past, state.doc], future: rest, dirty: true, ...clampSelection(next!, state) };
    }
    case "MARK_SAVED":
      // Clear dirty only when the saved revision is still current. If an edit landed while the
      // save was in flight (doc reference changed) or a different document was loaded (project /
      // version switch), stay dirty so the newer state is saved next and nothing is lost.
      return state.doc === action.savedDoc ? { ...state, dirty: false } : state;

    default:
      return state;
  }
}

function selectTrackForClip(doc: TimelineDoc, clipId: string | null): string | null {
  if (!clipId) return null;
  const c = doc.clips.find((x) => x.id === clipId);
  return c ? c.trackId : null;
}

function clampSelection(doc: TimelineDoc, state: EditorState): Partial<EditorState> {
  const stillThere = state.selectedClipId && doc.clips.some((c) => c.id === state.selectedClipId);
  return stillThere ? {} : { selectedClipId: null };
}

function deleteClip(state: EditorState, clipId: string, ripple: boolean): EditorState {
  const next = mutate(state, (doc) => {
    const c = doc.clips.find((x) => x.id === clipId);
    if (!c || clipTrackLocked(doc, c)) return null;
    const { trackId, start, duration } = c;
    doc.clips = doc.clips.filter((x) => x.id !== clipId);
    if (ripple) {
      for (const other of doc.clips) {
        if (other.trackId === trackId && other.start >= start) {
          other.start = round(Math.max(0, other.start - duration));
        }
      }
    }
    return doc;
  });
  if (next === state) return state;
  return next.selectedClipId === clipId ? { ...next, selectedClipId: null } : next;
}

function updateClip(state: EditorState, clipId: string, fn: (c: Clip) => void): EditorState {
  return mutate(state, (doc) => {
    const c = doc.clips.find((x) => x.id === clipId);
    if (!c) return null;
    fn(c);
    return doc;
  });
}

/** Apply a (newStart, newEnd) resize contract, keeping sourceIn and the source bound sane. */
function applyTrim(c: Clip, start: number, end: number): void {
  const oldStart = c.start;
  let newStart = Math.max(0, start);
  let sourceIn = c.sourceIn + (newStart - oldStart);
  if (sourceIn < 0) {
    // Cannot pull the left edge earlier than the start of the source material.
    newStart = Math.max(0, oldStart - c.sourceIn);
    sourceIn = 0;
  }
  let duration = end - newStart;
  if (duration < MIN_CLIP_DURATION) duration = MIN_CLIP_DURATION;
  if (c.sourceDuration !== null) {
    const available = Math.max(MIN_CLIP_DURATION, c.sourceDuration - sourceIn);
    if (duration > available) duration = available;
  }
  c.start = round(newStart);
  c.duration = round(duration);
  c.sourceIn = round(sourceIn);
}

function normalizeTransform(t: Transform): Transform {
  return {
    x: t.x,
    y: t.y,
    scale: Math.max(0.01, t.scale),
    rotation: t.rotation,
    opacity: clamp(t.opacity, 0, 1),
  };
}
