import { describe, it, expect } from "vitest";
import {
  wordSchema,
  transcriptSchema,
  markSchema,
  takeGroupSchema,
  candidateHookSchema,
  audioFactsSchema,
  frameMetricSchema,
  sourceAnalysisSchema,
  parseSourceAnalysis,
} from "../src/analysis/schemas.js";

const word = (text: string, s: number, e: number) => ({ text, startSeconds: s, endSeconds: e });

function transcript(overrides: Record<string, unknown> = {}) {
  return {
    clip: { path: "source/clip.mov" },
    durationSeconds: 10,
    language: "en",
    words: [word("hello", 0, 0.5), word("world", 0.6, 1.0)],
    segments: [
      { id: "seg0", startSeconds: 0, endSeconds: 1.0, text: "hello world", words: [word("hello", 0, 0.5), word("world", 0.6, 1.0)] },
    ],
    speakers: [],
    ...overrides,
  };
}

describe("wordSchema", () => {
  it("accepts a well-formed word and rejects end before start", () => {
    expect(wordSchema.safeParse(word("hi", 0, 0.4)).success).toBe(true);
    expect(wordSchema.safeParse(word("hi", 1, 0.4)).success).toBe(false);
  });
  it("rejects an empty word text", () => {
    expect(wordSchema.safeParse(word("", 0, 0.4)).success).toBe(false);
  });
});

describe("transcriptSchema monotonic + in-clip timing", () => {
  it("accepts monotonic in-clip words", () => {
    expect(transcriptSchema.safeParse(transcript()).success).toBe(true);
  });
  it("rejects non-monotonic word starts", () => {
    const bad = transcript({ words: [word("a", 1, 1.5), word("b", 0.2, 0.6)] });
    expect(transcriptSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects a word that runs past the clip duration", () => {
    const bad = transcript({ durationSeconds: 1, words: [word("a", 0, 0.5), word("b", 0.6, 2.5)] });
    expect(transcriptSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects a non-portable clip path", () => {
    const bad = transcript({ clip: { path: "C:/abs/clip.mov" } });
    expect(transcriptSchema.safeParse(bad).success).toBe(false);
  });
});

describe("editorial sub-schemas", () => {
  it("marks require a kind and reason", () => {
    expect(markSchema.safeParse({ kind: "filler", startSeconds: 1, endSeconds: 1.2, reason: "um" }).success).toBe(true);
    expect(markSchema.safeParse({ kind: "nope", startSeconds: 1, endSeconds: 1.2, reason: "x" }).success).toBe(false);
  });
  it("take group needs at least one member segment", () => {
    expect(takeGroupSchema.safeParse({ id: "t1", segmentIds: ["seg0", "seg1"] }).success).toBe(true);
    expect(takeGroupSchema.safeParse({ id: "t1", segmentIds: [] }).success).toBe(false);
  });
  it("candidate hook score is bounded 0..1", () => {
    expect(candidateHookSchema.safeParse({ startSeconds: 0, endSeconds: 2, text: "x", score: 0.7, reasons: ["strong-open"] }).success).toBe(true);
    expect(candidateHookSchema.safeParse({ startSeconds: 0, endSeconds: 2, text: "x", score: 2, reasons: [] }).success).toBe(false);
  });
  it("audio facts and frame metrics validate", () => {
    expect(audioFactsSchema.safeParse({ durationSeconds: 10, speechSeconds: 7, silenceSeconds: 3, speechRatio: 0.7, silenceThresholdDb: -30, minSilenceSeconds: 0.5, silences: [{ startSeconds: 7, endSeconds: 10 }] }).success).toBe(true);
    expect(frameMetricSchema.safeParse({ atSeconds: 1, blur: 120, brightness: 0.5, faceCount: 1, faces: [{ xNorm: 0.4, yNorm: 0.3, wNorm: 0.2, hNorm: 0.3 }] }).success).toBe(true);
  });
});

describe("sourceAnalysisSchema", () => {
  const good = {
    format: "octupie-source-analysis/v1",
    clip: { path: "source/clip.mov" },
    durationSeconds: 10,
    generatedAt: "2026-07-28T00:00:00.000Z",
    transcription: { provider: "faster-whisper", model: "base.en", language: "en" },
    transcript: transcript(),
    marks: [{ kind: "silence", startSeconds: 1, endSeconds: 1.6, reason: "dead-air" }],
    takes: [],
    candidateHooks: [],
    audio: { durationSeconds: 10, speechSeconds: 7, silenceSeconds: 3, speechRatio: 0.7, silenceThresholdDb: -30, minSilenceSeconds: 0.5, silences: [] },
    notes: ["heuristic marks are advisory, not semantic certainty"],
  };
  it("round-trips a full analysis via parseSourceAnalysis", () => {
    const r = parseSourceAnalysis(good);
    expect(r.ok).toBe(true);
    expect(r.data?.transcription.model).toBe("base.en");
  });
  it("reports errors on a malformed analysis", () => {
    const r = parseSourceAnalysis({ ...good, format: "wrong" });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it("accepts optional frame metrics", () => {
    const withFrames = { ...good, frames: [{ atSeconds: 1, blur: 100, brightness: 0.5, faceCount: 0, faces: [] }] };
    expect(sourceAnalysisSchema.safeParse(withFrames).success).toBe(true);
  });
});
