/**
 * Textual, FFprobe-derived asset manifest.
 *
 * The planner is given a text description of the available footage, never the
 * media bytes. This module builds that description from a brief's source clips,
 * using an injected prober so the process boundary (FFprobe) can be mocked in
 * tests and skipped in offline runs. The manifest is the only asset information
 * that ever reaches a model.
 */

import type { AgentBrief } from "./brief.js";

export interface ClipProbe {
  ok: boolean;
  durationSeconds?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  codec?: string;
  error?: string;
}

export interface ManifestClip {
  id: string;
  path: string;
  probed: boolean;
  durationSeconds?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  codec?: string;
  note?: string;
}

export interface AssetManifest {
  clips: ManifestClip[];
}

export interface ManifestOptions {
  /** Probe a clip by id. Absent means "no probing available" (offline mode). */
  probe?: (id: string, path: string) => Promise<ClipProbe>;
}

export async function buildAssetManifest(
  brief: AgentBrief,
  opts: ManifestOptions = {},
): Promise<AssetManifest> {
  const clips: ManifestClip[] = [];
  for (const clip of brief.sourceClips) {
    if (!opts.probe) {
      clips.push({ id: clip.id, path: clip.path, probed: false, note: "not probed" });
      continue;
    }
    let result: ClipProbe;
    try {
      result = await opts.probe(clip.id, clip.path);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) {
      clips.push({
        id: clip.id,
        path: clip.path,
        probed: true,
        ...(result.durationSeconds !== undefined ? { durationSeconds: result.durationSeconds } : {}),
        ...(result.width !== undefined ? { width: result.width } : {}),
        ...(result.height !== undefined ? { height: result.height } : {}),
        ...(result.hasAudio !== undefined ? { hasAudio: result.hasAudio } : {}),
        ...(result.codec !== undefined ? { codec: result.codec } : {}),
      });
    } else {
      clips.push({
        id: clip.id,
        path: clip.path,
        probed: false,
        note: result.error ?? "probe failed",
      });
    }
  }
  return { clips };
}

/** Render the manifest as plain text for a prompt. No bytes, no data URIs. */
export function renderManifestText(manifest: AssetManifest): string {
  if (manifest.clips.length === 0) return "Source clips: none declared.";
  const lines = manifest.clips.map((c) => {
    if (!c.probed) {
      return `- ${c.id} (${c.path}): ${c.note ?? "unprobed"}`;
    }
    const dims = c.width && c.height ? `${c.width}x${c.height}` : "unknown size";
    const dur = c.durationSeconds !== undefined ? `${c.durationSeconds.toFixed(2)}s` : "unknown duration";
    const audio = c.hasAudio ? "has audio" : "no audio";
    const codec = c.codec ? `, ${c.codec}` : "";
    return `- ${c.id} (${c.path}): ${dur}, ${dims}, ${audio}${codec}`;
  });
  return ["Source clips (from FFprobe, text only):", ...lines].join("\n");
}
