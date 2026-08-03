/*
 * Constructors for editor documents, tracks, and clips with safe defaults. Kept pure and
 * DOM-free so both the client and the Node test suite build fixtures the same way.
 */

import type { Brand, CaptionStyle, Clip, CompositionId, TimelineDoc, Track, TrackKind, Transform } from "./types.js";

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontSize: 54,
  color: "#F5F5F5",
  background: "#000000",
  align: "center",
  bold: true,
};

const NEUTRAL_BRAND: Brand = {
  name: "Founder",
  font: "Geist",
  paper: "#0E0E10",
  ink: "#F5F5F5",
  accent: "#014CE3",
  paper2: "#1A1A1E",
};

let trackSeq = 0;
let clipSeq = 0;

/** A short, collision-resistant id for a new track/clip minted in the UI. Not used by the
 * reducer (which takes ids in action payloads to stay pure and deterministic). */
export function nextTrackId(): string {
  trackSeq += 1;
  return `tk-${Date.now().toString(36)}-${trackSeq.toString(36)}`;
}
export function nextClipId(): string {
  clipSeq += 1;
  return `cl-${Date.now().toString(36)}-${clipSeq.toString(36)}`;
}

export function makeTrack(kind: TrackKind, id: string, name?: string): Track {
  return { id, kind, name: name ?? defaultTrackName(kind), muted: false, locked: false };
}

export function defaultTrackName(kind: TrackKind): string {
  switch (kind) {
    case "video":
      return "Video";
    case "overlay":
      return "Overlay";
    case "caption":
      return "Captions";
    case "audio":
      return "Audio";
  }
}

export interface ClipInit {
  id: string;
  trackId: string;
  start?: number;
  duration?: number;
  mediaId?: string | null;
  sourceIn?: number;
  sourceDuration?: number | null;
  text?: string;
  transform?: Transform;
  volume?: number;
  captionStyle?: CaptionStyle | null;
  name?: string;
}

export function makeClip(init: ClipInit): Clip {
  return {
    id: init.id,
    trackId: init.trackId,
    start: init.start ?? 0,
    duration: init.duration ?? 2,
    mediaId: init.mediaId ?? null,
    sourceIn: init.sourceIn ?? 0,
    sourceDuration: init.sourceDuration ?? null,
    text: init.text ?? "",
    transform: init.transform ? { ...init.transform } : { ...DEFAULT_TRANSFORM },
    volume: init.volume ?? 1,
    captionStyle: init.captionStyle ?? null,
    name: init.name ?? init.id,
  };
}

export interface DocInit {
  title?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  preset?: string;
  composition?: CompositionId;
  brand?: Brand;
  outputFileName?: string;
}

/** A blank 9:16 document with no tracks or clips, using the neutral founder brand. */
export function emptyDoc(init: DocInit = {}): TimelineDoc {
  return {
    version: 1,
    width: init.width ?? 1080,
    height: init.height ?? 1920,
    fps: init.fps ?? 30,
    duration: init.duration ?? 12,
    tracks: [],
    clips: [],
    meta: {
      title: init.title ?? "Untitled",
      preset: init.preset ?? "neutral-founder-reel",
      composition: init.composition ?? "FounderSocialReel",
      brand: init.brand ? { ...init.brand } : { ...NEUTRAL_BRAND },
      output: { fileName: init.outputFileName ?? "output/founder-reel.mp4" },
      audio: { targetLufs: -16, truePeakDb: -1.5 },
      captions: { maxWordsPerCard: 3, allowExtendedCards: false },
    },
  };
}

/** The four standard editor tracks in stacking order (video at the bottom). */
export function defaultTracks(ids: { video: string; overlay: string; caption: string; audio: string }): Track[] {
  return [
    makeTrack("video", ids.video),
    makeTrack("overlay", ids.overlay),
    makeTrack("caption", ids.caption),
    makeTrack("audio", ids.audio),
  ];
}
