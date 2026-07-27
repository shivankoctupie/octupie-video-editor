/**
 * Caption serialization from transcript segments.
 *
 * Produces standard SubRip (.srt) and WebVTT (.vtt) text from validated segments.
 * These are exact renderings of the timed transcript, not editorial captions;
 * the one-to-three-word caption cards remain the caption grouping layer's job.
 */

import type { SegmentValue } from "./schemas.js";

/** Format seconds as HH:MM:SS + separator + milliseconds. */
export function formatTimestamp(totalSeconds: number, msSeparator: "," | "." = ","): string {
  const clamped = Math.max(0, totalSeconds);
  const ms = Math.round(clamped * 1000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${msSeparator}${pad(millis, 3)}`;
}

function usable(segments: readonly SegmentValue[]): SegmentValue[] {
  return segments.filter((s) => s.text.trim().length > 0);
}

/** Render segments as SubRip (.srt). */
export function toSrt(segments: readonly SegmentValue[]): string {
  const blocks = usable(segments).map((s, i) => {
    const from = formatTimestamp(s.startSeconds, ",");
    const to = formatTimestamp(s.endSeconds, ",");
    return `${i + 1}\n${from} --> ${to}\n${s.text.trim()}\n`;
  });
  return blocks.join("\n");
}

/** Render segments as WebVTT (.vtt). */
export function toVtt(segments: readonly SegmentValue[]): string {
  const cues = usable(segments).map((s) => {
    const from = formatTimestamp(s.startSeconds, ".");
    const to = formatTimestamp(s.endSeconds, ".");
    return `${from} --> ${to}\n${s.text.trim()}\n`;
  });
  return ["WEBVTT", "", ...cues].join("\n");
}
