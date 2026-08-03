/*
 * Pure, DOM-free snapping helpers for the timeline. The reducer stays the single source of
 * truth for edits; these helpers only decide WHERE a dragged clip or trimmed edge should land
 * before the MOVE_CLIP / TRIM_CLIP action is dispatched. Kept free of React and the timeline
 * library so it unit-tests in plain Node and typechecks under both the NodeNext (server/tests)
 * and bundler (client) TypeScript projects.
 *
 * Snap targets are timeline instants, in seconds: the origin (0), the current playhead, and the
 * start and end of every OTHER clip across all tracks. The moving clip is excluded so an edge
 * never snaps to itself. The threshold is expressed in screen pixels and converted to seconds
 * with the current zoom (pixels per second), so it stays a constant on-screen distance and
 * tightens as the user zooms in.
 */

import type { TimelineDoc } from "./types.js";

/** Default snap threshold, in screen pixels. Restrained so snapping assists without fighting. */
export const SNAP_THRESHOLD_PX = 8;

/** Match the reducer's 3-decimal rounding so snapped values compare exactly after a round trip. */
const round = (n: number): number => Math.round(n * 1000) / 1000;

export interface SnapResult {
  /** Snapped time in seconds (equal to the input when nothing was within range). */
  time: number;
  /** Whether a target was within the threshold and applied. */
  snapped: boolean;
  /** The target snapped to, or null. */
  target: number | null;
}

/** Convert a pixel threshold to a seconds tolerance for the given zoom (pixels per second). */
export function pxThresholdSeconds(pxPerSecond: number, thresholdPx: number = SNAP_THRESHOLD_PX): number {
  if (!Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return 0;
  return thresholdPx / pxPerSecond;
}

/** Snap a single time to the nearest target within the zoom-aware threshold. */
export function snapTime(time: number, targets: readonly number[], pxPerSecond: number, thresholdPx: number = SNAP_THRESHOLD_PX): SnapResult {
  const tol = pxThresholdSeconds(pxPerSecond, thresholdPx);
  let bestTarget: number | null = null;
  let bestDist = Infinity;
  for (const t of targets) {
    const d = Math.abs(t - time);
    if (d <= tol && d < bestDist) {
      bestDist = d;
      bestTarget = t;
    }
  }
  if (bestTarget === null) return { time, snapped: false, target: null };
  const snapped = round(bestTarget);
  return { time: snapped, snapped: true, target: snapped };
}

export interface CollectTargetsOptions {
  /** Clip id to exclude (the one being moved/trimmed) so it never snaps to itself. */
  excludeClipId?: string | null;
  /** Current playhead time to include as a target; omit or null to skip. */
  playhead?: number | null;
  /** Include the timeline origin (0). Default true. */
  includeOrigin?: boolean;
}

/** Gather candidate snap instants: origin, playhead, and every other clip's start and end. */
export function collectSnapTargets(doc: TimelineDoc, options: CollectTargetsOptions = {}): number[] {
  const { excludeClipId = null, playhead = null, includeOrigin = true } = options;
  const set = new Set<number>();
  if (includeOrigin) set.add(0);
  if (playhead !== null && Number.isFinite(playhead) && playhead >= 0) set.add(round(playhead));
  for (const c of doc.clips) {
    if (c.id === excludeClipId) continue;
    set.add(round(c.start));
    set.add(round(c.start + c.duration));
  }
  return [...set].sort((a, b) => a - b);
}

export interface MoveSnapResult {
  /** New clip start in seconds; duration is preserved (a move does not resize). */
  start: number;
  snapped: boolean;
  target: number | null;
  /** Which edge produced the snap. */
  edge: "start" | "end" | null;
}

/**
 * Snap a whole-clip move. Considers snapping either the start edge or the end edge to the
 * nearest target, whichever is closer, then shifts the clip so that edge lands on the target.
 * Duration is preserved.
 */
export function snapClipMove(start: number, duration: number, targets: readonly number[], pxPerSecond: number, thresholdPx: number = SNAP_THRESHOLD_PX): MoveSnapResult {
  const end = start + duration;
  const s = snapTime(start, targets, pxPerSecond, thresholdPx);
  const e = snapTime(end, targets, pxPerSecond, thresholdPx);
  const sDist = s.snapped && s.target !== null ? Math.abs(s.target - start) : Infinity;
  const eDist = e.snapped && e.target !== null ? Math.abs(e.target - end) : Infinity;
  if (!s.snapped && !e.snapped) return { start: round(start), snapped: false, target: null, edge: null };
  if (sDist <= eDist && s.target !== null) return { start: round(s.target), snapped: true, target: s.target, edge: "start" };
  const endTarget = e.target as number;
  return { start: round(endTarget - duration), snapped: true, target: endTarget, edge: "end" };
}

export interface TrimSnapResult {
  start: number;
  end: number;
  snapped: boolean;
  target: number | null;
  dir: "left" | "right";
}

/**
 * Snap a trim. Only the dragged edge moves: "left" snaps the start, "right" snaps the end. The
 * opposite edge is left untouched. Source bounds and the minimum duration are enforced later by
 * the TRIM_CLIP reducer action, so this helper is purely geometric.
 */
export function snapClipTrim(start: number, end: number, dir: "left" | "right", targets: readonly number[], pxPerSecond: number, thresholdPx: number = SNAP_THRESHOLD_PX): TrimSnapResult {
  if (dir === "left") {
    const r = snapTime(start, targets, pxPerSecond, thresholdPx);
    return { start: r.time, end: round(end), snapped: r.snapped, target: r.target, dir };
  }
  const r = snapTime(end, targets, pxPerSecond, thresholdPx);
  return { start: round(start), end: r.time, snapped: r.snapped, target: r.target, dir };
}
