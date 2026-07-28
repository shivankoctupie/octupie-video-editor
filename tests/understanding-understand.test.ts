import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { createPolicy } from "../src/permissions/policy.js";
import { understandSource, pairFrameTimes, selectFramesEvenly, type UnderstandSourceInput } from "../src/understanding/understand.js";
import type { SemanticUnderstandingValue } from "../src/understanding/schemas.js";
import type { VideoUnderstandingProvider } from "../src/understanding/claudeVision.js";
import type { SourceAnalysisValue } from "../src/analysis/schemas.js";

const ROOT = resolve("output");
const PERMISSIONS = createPolicy([
  { action: "network", grantedBy: "test", grantedAt: "2026-07-28T00:00:00.000Z" },
  { action: "media-upload", grantedBy: "test", grantedAt: "2026-07-28T00:00:00.000Z" },
]);

const analysis: SourceAnalysisValue = {
  format: "octupie-source-analysis/v1",
  clip: { path: "source/clip.mov" },
  durationSeconds: 6,
  generatedAt: "2026-07-28T00:00:00.000Z",
  transcription: { provider: "faster-whisper", model: "base.en", language: "en" },
  transcript: {
    clip: { path: "source/clip.mov" },
    durationSeconds: 6,
    language: "en",
    words: [{ text: "hello", startSeconds: 0, endSeconds: 0.4 }],
    segments: [],
    speakers: [],
  },
  marks: [],
  takes: [],
  candidateHooks: [],
  audio: {
    durationSeconds: 6,
    speechSeconds: 6,
    silenceSeconds: 0,
    speechRatio: 1,
    silenceThresholdDb: -30,
    minSilenceSeconds: 0.5,
    silences: [],
  },
  frames: [
    { atSeconds: 0, blur: 100, brightness: 0.5, faceCount: 0, faces: [] },
    { atSeconds: 2, blur: 90, brightness: 0.5, faceCount: 1, faces: [] },
  ],
  notes: ["heuristic"],
};

const understanding: SemanticUnderstandingValue = {
  format: "octupie-semantic-understanding/v1",
  clip: { path: "source/clip.mov" },
  durationSeconds: 6,
  generatedAt: "2026-07-28T00:00:00.000Z",
  provider: { id: "claude-cli", model: "claude-code-vision" },
  findings: [
    {
      kind: "hook-moment",
      startSeconds: 0,
      endSeconds: 0.4,
      confidence: 0.8,
      rationale: "direct claim",
      evidenceFrames: [{ path: "frame_00001.jpg", atSeconds: 0 }],
    },
  ],
  segments: [],
  summary: "ok",
  limitations: ["sampled frames only"],
};

function fakeProvider(capture: (inp: unknown) => void): VideoUnderstandingProvider {
  return {
    id: "claude-cli",
    understand: async (inp) => {
      capture(inp);
      return understanding;
    },
  };
}

function base(over: Partial<UnderstandSourceInput> = {}): UnderstandSourceInput {
  return {
    analysisPath: "output/analysis/clip/analysis.json",
    providerId: "claude",
    permissionPolicy: PERMISSIONS,
    root: ROOT,
    readAnalysis: () => JSON.stringify(analysis),
    listFrames: () => ["frame_00001.jpg", "frame_00002.jpg", "frame-manifest.json"],
    realpathPath: (p) => p,
    writeFile: () => {},
    ensureDir: () => {},
    provider: () => fakeProvider(() => {}),
    ...over,
  };
}

describe("pairFrameTimes", () => {
  it("pairs each frame file with the source time from the analysis artifact", () => {
    const frameDir = resolve("output", "analysis", "clip", "frames");
    const paired = pairFrameTimes(["frame_00001.jpg", "frame_00002.jpg"], frameDir, analysis);
    expect(paired.map((p) => p.atSeconds)).toEqual([0, 2]);
    expect(paired[0]!.absPath).toContain("frame_00001.jpg");
  });

  it("rejects frame and metric count mismatches instead of fabricating timestamps", () => {
    const frameDir = resolve("output", "analysis", "clip", "frames");
    expect(() => pairFrameTimes(["frame_00001.jpg"], frameDir, analysis)).toThrow(/does not match/);
  });

  it("selects an even, endpoint-preserving subset for bounded providers", () => {
    const frames = Array.from({ length: 37 }, (_, i) => ({ absPath: `frame_${i}.jpg`, atSeconds: i * 2 }));
    const selected = selectFramesEvenly(frames, 24);
    expect(selected).toHaveLength(24);
    expect(selected[0]).toBe(frames[0]);
    expect(selected[23]).toBe(frames[36]);
  });
});

describe("understandSource", () => {
  it("denies network and media upload by default before reading analysis", async () => {
    let read = false;
    await expect(understandSource(base({ permissionPolicy: undefined, readAnalysis: () => { read = true; return "{}"; } })))
      .rejects.toThrow(/Permission denied for 'network'/);
    expect(read).toBe(false);
  });

  it("requires a separate media-upload grant", async () => {
    const networkOnly = createPolicy([
      { action: "network", grantedBy: "test", grantedAt: "2026-07-28T00:00:00.000Z" },
    ]);
    await expect(understandSource(base({ permissionPolicy: networkOnly }))).rejects.toThrow(/Permission denied for 'media-upload'/);
  });

  it("loads the analysis, gathers only frame images, and writes the result under the root", async () => {
    let seen: { frames?: unknown[]; frameDir?: string } = {};
    const writes: Array<{ path: string; data: string }> = [];
    const res = await understandSource(
      base({
        provider: () => fakeProvider((inp) => (seen = inp as typeof seen)),
        writeFile: (path, data) => writes.push({ path, data }),
      }),
    );
    expect(seen.frames).toHaveLength(2); // frame-manifest.json filtered out
    expect(seen.frameDir).toContain("frames");
    expect(res.frameCount).toBe(2);
    expect(res.understandingPath).toContain("understanding.json");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.data).format).toBe("octupie-semantic-understanding/v1");
  });

  it("refuses an analysis path outside the configured root (no arbitrary reads)", async () => {
    await expect(understandSource(base({ analysisPath: "../../etc/analysis.json" }))).rejects.toThrow(/outside the allowed root/);
  });

  it("refuses an analysis symlink whose real target escapes the configured root", async () => {
    let read = false;
    await expect(understandSource(base({
      readAnalysis: () => { read = true; return JSON.stringify(analysis); },
      realpathPath: (p) => p.endsWith("analysis.json") ? resolve("outside", "analysis.json") : p,
    }))).rejects.toThrow(/real analysis file.*outside the allowed root/);
    expect(read).toBe(false);
  });

  it("refuses a frame-directory symlink whose real target escapes the configured root", async () => {
    await expect(understandSource(base({
      realpathPath: (p) => p.endsWith("frames") ? resolve("outside", "frames") : p,
    }))).rejects.toThrow(/real frame directory.*outside the allowed root/);
  });

  it("refuses an output path outside the root", async () => {
    await expect(understandSource(base({ outFile: "../escape.json" }))).rejects.toThrow(/outside the allowed root/);
  });

  it("fails clearly when no sampled frames are present", async () => {
    await expect(understandSource(base({ listFrames: () => ["frame-manifest.json"] }))).rejects.toThrow(/No sampled frames/);
  });

  it("rejects an analysis file that fails schema validation", async () => {
    await expect(understandSource(base({ readAnalysis: () => JSON.stringify({ format: "wrong" }) }))).rejects.toThrow(/failed validation/);
  });

  it("rejects a non-JSON analysis file", async () => {
    await expect(understandSource(base({ readAnalysis: () => "not json" }))).rejects.toThrow(/not valid JSON/);
  });
});
