/*
 * Editor domain model. This is the single source of truth the whole client renders from
 * and the reducer mutates. It is intentionally free of any DOM, React, or browser API so
 * it can be unit-tested in plain Node and typechecked by both the server (NodeNext) and
 * client (bundler) TypeScript projects.
 */

export type TrackKind = "video" | "overlay" | "caption" | "audio";

export interface Transform {
  /** Offset from the composition centre, in composition pixels. */
  x: number;
  y: number;
  /** 1 = 100%. */
  scale: number;
  /** Degrees. */
  rotation: number;
  /** 0..1. */
  opacity: number;
}

export interface CaptionStyle {
  fontSize: number;
  color: string;
  /** "" means no background plate. */
  background: string;
  align: "left" | "center" | "right";
  bold: boolean;
}

export interface Clip {
  id: string;
  trackId: string;
  /** Timeline position, seconds. */
  start: number;
  /** Length on the timeline, seconds (> 0). */
  duration: number;
  /** Uploaded media reference (video / image overlay / audio); null for pure text. */
  mediaId: string | null;
  /** Trim in-point into the source media, seconds (>= 0). */
  sourceIn: number;
  /** Natural media duration if known, seconds; null when unknown. */
  sourceDuration: number | null;
  /** Caption / overlay text. */
  text: string;
  transform: Transform;
  /** 0..1, for audio and video clips. */
  volume: number;
  /** Caption styling; null for non-caption clips. */
  captionStyle: CaptionStyle | null;
  name: string;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
}

export interface Brand {
  name: string;
  font: string;
  paper: string;
  ink: string;
  accent: string;
  paper2?: string;
}

export type CompositionId = "PremiumProductFilm" | "FounderSocialReel";

export interface DocMeta {
  title: string;
  preset: string;
  composition: CompositionId;
  brand: Brand;
  output: { fileName: string };
  audio: { targetLufs: number; truePeakDb: number };
  captions: { maxWordsPerCard: number; allowExtendedCards: boolean };
}

export interface TimelineDoc {
  version: 1;
  width: number;
  height: number;
  fps: number;
  /** Total composition length, seconds. */
  duration: number;
  /** Order is stacking order: index 0 renders at the bottom. */
  tracks: Track[];
  clips: Clip[];
  meta: DocMeta;
}

export interface EditorState {
  doc: TimelineDoc;
  selectedClipId: string | null;
  selectedTrackId: string | null;
  /** Current time, seconds. */
  playhead: number;
  /** Timeline horizontal zoom, pixels per second. */
  zoom: number;
  past: TimelineDoc[];
  future: TimelineDoc[];
  dirty: boolean;
}

export type EditorAction =
  | { type: "LOAD_DOC"; doc: TimelineDoc; resetPlayhead?: boolean }
  | { type: "SET_PLAYHEAD"; time: number }
  | { type: "SET_ZOOM"; zoom: number }
  | { type: "ZOOM_IN" }
  | { type: "ZOOM_OUT" }
  | { type: "SELECT_CLIP"; clipId: string | null }
  | { type: "SELECT_TRACK"; trackId: string | null }
  | { type: "ADD_CLIP"; clip: Clip }
  | { type: "MOVE_CLIP"; clipId: string; start: number; trackId?: string }
  | { type: "TRIM_CLIP"; clipId: string; start: number; end: number }
  | { type: "SPLIT_CLIP"; clipId: string; time: number; newId: string }
  | { type: "DELETE_CLIP"; clipId: string }
  | { type: "RIPPLE_DELETE_CLIP"; clipId: string }
  | { type: "DUPLICATE_CLIP"; clipId: string; newId: string }
  | { type: "SET_CLIP_TEXT"; clipId: string; text: string }
  | { type: "SET_CLIP_TRANSFORM"; clipId: string; transform: Partial<Transform> }
  | { type: "SET_CLIP_VOLUME"; clipId: string; volume: number }
  | { type: "SET_CLIP_SOURCE_IN"; clipId: string; sourceIn: number }
  | { type: "SET_CLIP_TIMING"; clipId: string; start?: number; duration?: number }
  | { type: "SET_CAPTION_STYLE"; clipId: string; style: Partial<CaptionStyle> }
  | { type: "ADD_TRACK"; track: Track; index?: number }
  | { type: "REMOVE_TRACK"; trackId: string }
  | { type: "REORDER_TRACK"; trackId: string; dir: -1 | 1 }
  | { type: "TOGGLE_MUTE"; trackId: string }
  | { type: "TOGGLE_LOCK"; trackId: string }
  | { type: "RENAME_TRACK"; trackId: string; name: string }
  | { type: "SET_META"; meta: Partial<Pick<TimelineDoc, "duration" | "fps"> & { title: string }> }
  | { type: "UNDO" }
  | { type: "REDO" }
  /** Clear dirty ONLY if `savedDoc` is still the current doc (the exact revision that was
   * persisted). A mid-flight edit or a document switch changes the doc reference, so a stale
   * save completion never clears dirty and nothing is lost. */
  | { type: "MARK_SAVED"; savedDoc: TimelineDoc };
