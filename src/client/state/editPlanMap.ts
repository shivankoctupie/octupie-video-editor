/*
 * The bridge between the editor's timeline document and the validated EditPlan.
 *
 * Persistence is lossless: the full track/clip/transform document is written to the plan's
 * optional `timeline` field, so a reload reproduces the timeline exactly. On top of that we
 * derive a valid, renderable projection into `scenes` / `captions` / `sourceClips` so the
 * existing deterministic renderer and every schema gate keep passing. The projection is
 * best-effort for the renderer (the first video track becomes scenes; caption clips become
 * caption cards, split to the word limit; overlay and audio tracks live only in `timeline`
 * for now). None of that projection can lose editor data, because the editor always reloads
 * from `timeline` when present.
 *
 * Pure and DOM-free: unit-tested in Node against the real zod validator.
 */

import type { EditPlan } from "../../schema/editPlan.js";
import type { Clip, TimelineDoc, Track, Transform } from "./types.js";
import { DEFAULT_TRANSFORM } from "./factory.js";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Resolve an uploaded media id to a safe relative storage path (or null if unknown). */
export type MediaPathResolver = (mediaId: string) => string | null;
/** Resolve a source-clip storage path back to a media id (for loading legacy plans). */
export type MediaIdResolver = (path: string) => string | null;

/** Split a caption's text into cards of at most `maxWords`, dividing the time range evenly.
 * This keeps the full wording (no data loss) while satisfying the plan's word-per-card gate. */
export function splitCaption(text: string, start: number, end: number, maxWords: number): Array<{ text: string; start: number; end: number }> {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || end <= start) return [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(" "));
  const slice = (end - start) / chunks.length;
  return chunks.map((t, i) => ({ text: t, start: round(start + i * slice), end: round(i === chunks.length - 1 ? end : start + (i + 1) * slice) }));
}

function sanitizeTransform(t: Transform): Transform {
  return { x: t.x, y: t.y, scale: Math.max(0.01, t.scale), rotation: t.rotation, opacity: clamp01(t.opacity) };
}

/** Serialize the doc into the plan's `timeline` value (lossless, validated by the schema).
 * Every media-backed clip also gets a resolved `mediaPath` (the safe storage path) so the
 * deterministic renderer can project the whole timeline. The path is derived from `mediaId`
 * via the same resolver the source-clip projection uses; when a clip's media does not resolve
 * (e.g. it was removed) the path is simply omitted and the render fails closed on it later. */
function serializeTimeline(doc: TimelineDoc, mediaPath: MediaPathResolver): Record<string, unknown> {
  return {
    version: 1,
    width: doc.width,
    height: doc.height,
    fps: doc.fps,
    duration: round(doc.duration),
    tracks: doc.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, muted: t.muted, locked: t.locked })),
    clips: doc.clips.map((c) => {
      const path = c.mediaId ? mediaPath(c.mediaId) : null;
      return {
        id: c.id,
        trackId: c.trackId,
        start: round(Math.max(0, c.start)),
        duration: round(Math.max(0.05, c.duration)),
        mediaId: c.mediaId,
        ...(path ? { mediaPath: path } : {}),
        sourceIn: round(Math.max(0, c.sourceIn)),
        sourceDuration: c.sourceDuration === null ? null : round(c.sourceDuration),
        text: c.text,
        transform: sanitizeTransform(c.transform),
        volume: clamp01(c.volume),
        captionStyle: c.captionStyle,
        name: c.name,
      };
    }),
  };
}

/** Build the validated EditPlan object from the editor document. */
export function toEditPlan(doc: TimelineDoc, mediaPath: MediaPathResolver): Record<string, unknown> {
  const duration = round(Math.max(0.05, doc.duration));

  // Source clips: one entry per uploaded media used by a video clip that resolves to a path.
  const videoTrack = doc.tracks.find((t) => t.kind === "video") ?? null;
  const videoClips = videoTrack ? doc.clips.filter((c) => c.trackId === videoTrack.id).slice().sort((a, b) => a.start - b.start) : [];

  const sourceClips: Array<{ id: string; path: string }> = [];
  const sourceIdByMedia = new Map<string, string>();
  for (const c of videoClips) {
    if (!c.mediaId || sourceIdByMedia.has(c.mediaId)) continue;
    const path = mediaPath(c.mediaId);
    if (!path) continue;
    const id = `src-${sourceClips.length + 1}`;
    sourceIdByMedia.set(c.mediaId, id);
    sourceClips.push({ id, path });
  }

  // Scenes: the first video track, projected to a non-overlapping timeline within duration.
  const scenes: Array<Record<string, unknown>> = [];
  let cursor = 0;
  const usedIds = new Set<string>();
  for (const c of videoClips) {
    const clipEnd = c.start + c.duration;
    const sStart = Math.max(c.start, cursor);
    const sEnd = Math.min(clipEnd, duration);
    if (sEnd - sStart < 0.05) continue;
    let id = sanitizeId(c.name || c.id);
    while (usedIds.has(id)) id = `${id}-x`;
    usedIds.add(id);
    const srcId = c.mediaId ? sourceIdByMedia.get(c.mediaId) : undefined;
    const heading = (c.text || c.name || "").trim();
    scenes.push({
      id,
      type: "explanation",
      start: round(sStart),
      end: round(sEnd),
      ...(heading ? { heading } : {}),
      ...(srcId ? { sourceClipId: srcId, sourceIn: round(c.sourceIn + (sStart - c.start)), fit: "cover", mute: isMuted(doc, c) } : {}),
    });
    cursor = sEnd;
  }
  if (scenes.length === 0) {
    scenes.push({ id: "scene-1", type: "hook", start: 0, end: duration, heading: doc.meta.title || "Untitled" });
  }

  // Caption cards: from every caption track, split to the word limit and clamped to duration.
  const hardMax = doc.meta.captions.allowExtendedCards ? doc.meta.captions.maxWordsPerCard : 3;
  const captionClips = doc.clips.filter((c) => trackKind(doc, c.trackId) === "caption");
  const cards: Array<{ text: string; start: number; end: number }> = [];
  for (const c of captionClips) {
    const start = Math.max(0, c.start);
    const end = Math.min(c.start + c.duration, duration);
    for (const card of splitCaption(c.text, start, end, hardMax)) {
      if (card.end > card.start && card.end <= duration + 1e-6) cards.push({ ...card, end: Math.min(card.end, duration) });
    }
  }

  return {
    format: "octupie-edit-plan/v1",
    title: doc.meta.title || "Untitled",
    preset: doc.meta.preset,
    composition: doc.meta.composition,
    width: doc.width,
    height: doc.height,
    fps: doc.fps,
    duration,
    brand: { ...doc.meta.brand },
    scenes,
    captions: { maxWordsPerCard: doc.meta.captions.maxWordsPerCard, allowExtendedCards: doc.meta.captions.allowExtendedCards, cards },
    sourceClips,
    audio: { targetLufs: doc.meta.audio.targetLufs, truePeakDb: doc.meta.audio.truePeakDb, sfx: [] },
    output: { fileName: doc.meta.output.fileName },
    timeline: serializeTimeline(doc, mediaPath),
  };
}

/** Rebuild the editor document from a plan. When the plan carries a `timeline` (any plan the
 * editor saved) it is reproduced exactly; otherwise a document is synthesized from the
 * scene/caption/source-clip projection so legacy plans are still fully editable. */
export function fromEditPlan(plan: EditPlan, resolveMediaId?: MediaIdResolver): TimelineDoc {
  const metaBase = planMeta(plan);
  if (plan.timeline) {
    const tl = plan.timeline;
    return {
      version: 1,
      width: tl.width,
      height: tl.height,
      fps: tl.fps,
      duration: tl.duration,
      tracks: tl.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, muted: t.muted, locked: t.locked })),
      clips: tl.clips.map((c) => ({
        id: c.id,
        trackId: c.trackId,
        start: c.start,
        duration: c.duration,
        mediaId: c.mediaId,
        sourceIn: c.sourceIn,
        sourceDuration: c.sourceDuration,
        text: c.text,
        transform: { ...c.transform },
        volume: c.volume,
        captionStyle: c.captionStyle ? { ...c.captionStyle } : null,
        name: c.name,
      })),
      meta: metaBase,
    };
  }

  // Legacy synthesis: scenes -> video clips, caption cards -> caption clips.
  const tracks: Track[] = [
    { id: "tk-video", kind: "video", name: "Video", muted: false, locked: false },
    { id: "tk-overlay", kind: "overlay", name: "Overlay", muted: false, locked: false },
    { id: "tk-caption", kind: "caption", name: "Captions", muted: false, locked: false },
    { id: "tk-audio", kind: "audio", name: "Audio", muted: false, locked: false },
  ];
  const clips: Clip[] = [];
  const clipById = new Map(plan.sourceClips.map((sc) => [sc.id, sc]));
  plan.scenes.forEach((sc, i) => {
    const src = sc.sourceClipId ? clipById.get(sc.sourceClipId) : undefined;
    const mediaId = src && resolveMediaId ? resolveMediaId(src.path) : null;
    clips.push({
      id: `clip-${i + 1}`,
      trackId: "tk-video",
      start: sc.start,
      duration: round(sc.end - sc.start),
      mediaId,
      sourceIn: sc.sourceIn ?? src?.in ?? 0,
      sourceDuration: null,
      text: sc.heading ?? "",
      transform: { ...DEFAULT_TRANSFORM },
      volume: sc.mute ? 0 : 1,
      captionStyle: null,
      name: sc.id,
    });
  });
  plan.captions.cards.forEach((card, i) => {
    clips.push({
      id: `cap-${i + 1}`,
      trackId: "tk-caption",
      start: card.start,
      duration: round(card.end - card.start),
      mediaId: null,
      sourceIn: 0,
      sourceDuration: null,
      text: card.text,
      transform: { ...DEFAULT_TRANSFORM },
      volume: 1,
      captionStyle: { fontSize: 54, color: plan.brand.ink, background: "", align: "center", bold: true },
      name: `caption ${i + 1}`,
    });
  });
  return { version: 1, width: plan.width, height: plan.height, fps: plan.fps, duration: plan.duration, tracks, clips, meta: metaBase };
}

function planMeta(plan: EditPlan): TimelineDoc["meta"] {
  return {
    title: plan.title,
    preset: plan.preset,
    composition: plan.composition,
    brand: { ...plan.brand },
    output: { fileName: plan.output.fileName },
    audio: { targetLufs: plan.audio.targetLufs, truePeakDb: plan.audio.truePeakDb },
    captions: { maxWordsPerCard: plan.captions.maxWordsPerCard, allowExtendedCards: plan.captions.allowExtendedCards },
  };
}

function trackKind(doc: TimelineDoc, trackId: string): string | null {
  return doc.tracks.find((t) => t.id === trackId)?.kind ?? null;
}
function isMuted(doc: TimelineDoc, clip: Clip): boolean {
  const t = doc.tracks.find((x) => x.id === clip.trackId);
  return (t ? t.muted : false) || clip.volume === 0;
}
function sanitizeId(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length ? s.slice(0, 40) : "scene";
}
