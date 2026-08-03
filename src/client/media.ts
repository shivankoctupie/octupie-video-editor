/*
 * Browser-side media helpers. Bytes are fetched from the server with the bearer token, then
 * held as object URLs so <video>/<img> can display them without ever exposing the token in a
 * URL. Object URLs are revoked on project switch and sign-out (see revokeAllMedia). Waveforms
 * are decoded via the Web Audio API with a bounded cache; thumbnails are captured from a
 * hidden <video>. Every heavy operation fails soft (returns null) so the editor never blocks.
 */

import { getToken } from "./api";

const urlCache = new Map<string, string>(); // mediaId -> objectURL
const bufferCache = new Map<string, ArrayBuffer>(); // mediaId -> raw bytes
const waveCache = new Map<string, number[]>(); // mediaId -> normalized peaks
const thumbCache = new Map<string, string>(); // mediaId -> data URL
const durationCache = new Map<string, number | null>();

const BUFFER_CACHE_MAX = 6;
const WAVE_CACHE_MAX = 16;
const THUMB_CACHE_MAX = 48;

function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size >= max) {
    const k = map.keys().next().value;
    if (k === undefined) break;
    map.delete(k);
  }
}

async function fetchBytes(projectId: string, mediaId: string): Promise<ArrayBuffer> {
  const cached = bufferCache.get(mediaId);
  if (cached) return cached;
  const res = await fetch(`/api/projects/${projectId}/media/${mediaId}/content`, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error(`Could not load media bytes (${res.status}).`);
  const buf = await res.arrayBuffer();
  evictOldest(bufferCache, BUFFER_CACHE_MAX);
  bufferCache.set(mediaId, buf);
  return buf;
}

/** A same-origin object URL for a media item's bytes (cached). */
export async function mediaObjectUrl(projectId: string, mediaId: string): Promise<string> {
  const hit = urlCache.get(mediaId);
  if (hit) return hit;
  const buf = await fetchBytes(projectId, mediaId);
  // Blob copies the bytes, so the underlying ArrayBuffer stays usable for decode/thumbnail.
  const url = URL.createObjectURL(new Blob([buf.slice(0)]));
  urlCache.set(mediaId, url);
  return url;
}

/** Revoke every object URL and clear the caches. Called on project switch and sign-out. */
export function revokeAllMedia(): void {
  for (const url of urlCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
  urlCache.clear();
  bufferCache.clear();
  waveCache.clear();
  thumbCache.clear();
  durationCache.clear();
}

/** Normalized (0..1) waveform peaks decoded from the audio, or null if decode is unavailable. */
export async function waveformPeaks(projectId: string, mediaId: string, buckets = 600): Promise<number[] | null> {
  const hit = waveCache.get(mediaId);
  if (hit) return hit;
  try {
    const Ctor: typeof AudioContext | undefined = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const buf = await fetchBytes(projectId, mediaId);
    const ctx = new Ctor();
    let audio: AudioBuffer;
    try {
      audio = await ctx.decodeAudioData(buf.slice(0));
    } finally {
      void ctx.close();
    }
    const ch = audio.getChannelData(0);
    const block = Math.max(1, Math.floor(ch.length / buckets));
    const peaks: number[] = [];
    for (let i = 0; i < buckets; i++) {
      let max = 0;
      const s = i * block;
      for (let j = 0; j < block && s + j < ch.length; j++) {
        const v = Math.abs(ch[s + j]!);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    const norm = Math.max(...peaks, 0.0001);
    const out = peaks.map((p) => p / norm);
    evictOldest(waveCache, WAVE_CACHE_MAX);
    waveCache.set(mediaId, out);
    return out;
  } catch {
    return null;
  }
}

/** A small JPEG poster frame captured from a video, or null if capture fails. */
export async function videoPosterThumb(projectId: string, mediaId: string): Promise<string | null> {
  const hit = thumbCache.get(mediaId);
  if (hit) return hit;
  try {
    const url = await mediaObjectUrl(projectId, mediaId);
    const dataUrl = await captureFrame(url);
    if (dataUrl) {
      evictOldest(thumbCache, THUMB_CACHE_MAX);
      thumbCache.set(mediaId, dataUrl);
    }
    return dataUrl;
  } catch {
    return null;
  }
}

function captureFrame(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    v.src = url;
    let done = false;
    const finish = (r: string | null): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    v.addEventListener("error", () => finish(null));
    v.addEventListener("loadedmetadata", () => {
      try {
        v.currentTime = Math.min(0.5, (Number.isFinite(v.duration) ? v.duration : 1) * 0.1);
      } catch {
        finish(null);
      }
    });
    v.addEventListener("seeked", () => {
      try {
        const w = 160;
        const ratio = v.videoWidth ? v.videoHeight / v.videoWidth : 9 / 16;
        const h = Math.max(1, Math.round(w * ratio));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d");
        if (!g) return finish(null);
        g.drawImage(v, 0, 0, w, h);
        finish(c.toDataURL("image/jpeg", 0.6));
      } catch {
        finish(null);
      }
    });
    setTimeout(() => finish(null), 4000);
  });
}

/** Natural media duration in seconds (video/audio), or null. Cached. */
export async function probeDuration(projectId: string, mediaId: string, kind: "video" | "audio" | "image"): Promise<number | null> {
  if (durationCache.has(mediaId)) return durationCache.get(mediaId) ?? null;
  if (kind === "image") {
    durationCache.set(mediaId, null);
    return null;
  }
  try {
    const url = await mediaObjectUrl(projectId, mediaId);
    const value = await new Promise<number | null>((resolve) => {
      const el = document.createElement(kind);
      el.preload = "metadata";
      el.muted = true;
      el.src = url;
      let done = false;
      const finish = (r: number | null): void => {
        if (done) return;
        done = true;
        resolve(r);
      };
      el.addEventListener("loadedmetadata", () => finish(Number.isFinite(el.duration) ? el.duration : null));
      el.addEventListener("error", () => finish(null));
      setTimeout(() => finish(null), 4000);
    });
    durationCache.set(mediaId, value);
    return value;
  } catch {
    durationCache.set(mediaId, null);
    return null;
  }
}

export function mediaKind(mime: string): "video" | "audio" | "image" | "other" {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  return "other";
}
