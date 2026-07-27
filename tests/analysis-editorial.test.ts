import { describe, it, expect } from "vitest";
import {
  detectFillers,
  detectCrewPrompts,
  groupRepeatedTakes,
  scoreCandidateHooks,
  silenceMarks,
  analyzeEditorial,
  jaccardSimilarity,
  normalizeText,
} from "../src/analysis/editorial.js";
import type { TranscriptValue, AudioFactsValue } from "../src/analysis/schemas.js";

const w = (text: string, s: number, e: number) => ({ text, startSeconds: s, endSeconds: e });

function seg(id: string, s: number, e: number, text: string) {
  const parts = text.split(" ");
  const dur = (e - s) / parts.length;
  const words = parts.map((p, i) => w(p, +(s + i * dur).toFixed(3), +(s + (i + 1) * dur).toFixed(3)));
  return { id, startSeconds: s, endSeconds: e, text, words };
}

function transcript(segments: ReturnType<typeof seg>[]): TranscriptValue {
  const words = segments.flatMap((sg) => sg.words);
  const dur = Math.max(...segments.map((sg) => sg.endSeconds)) + 0.1;
  return { clip: { path: "source/c.mov" }, durationSeconds: dur, language: "en", words, segments, speakers: [] };
}

describe("detectFillers", () => {
  it("flags single-token and phrase fillers with their reason", () => {
    const words = [w("um", 0, 0.2), w("so", 0.2, 0.4), w("you", 0.4, 0.6), w("know", 0.6, 0.8), w("growth", 0.8, 1.2)];
    const marks = detectFillers(words);
    const texts = marks.map((m) => m.text);
    expect(texts).toContain("um");
    expect(texts).toContain("you know");
    expect(marks.every((m) => m.kind === "filler")).toBe(true);
    expect(marks.find((m) => m.text === "um")!.reason).toMatch(/filler word/);
  });
  it("does not flag ordinary words", () => {
    expect(detectFillers([w("hello", 0, 0.4), w("world", 0.5, 0.9)])).toHaveLength(0);
  });
});

describe("detectCrewPrompts", () => {
  it("flags a restart/crew cue segment", () => {
    const marks = detectCrewPrompts([seg("s0", 0, 2, "okay let me restart from the top"), seg("s1", 2, 5, "growth is about retention")]);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kind).toBe("crew-prompt");
    expect(marks[0]!.reason).toMatch(/restart|crew/);
  });
});

describe("groupRepeatedTakes", () => {
  it("groups adjacent near-identical takes and offers the fullest as preferred", () => {
    const segs = [
      seg("s0", 0, 3, "here is the thing about growth"),
      seg("s1", 3, 6, "here is the thing about growth marketing today"),
      seg("s2", 6, 9, "completely different closing statement now"),
    ];
    const groups = groupRepeatedTakes(segs);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.segmentIds).toEqual(["s0", "s1"]);
    expect(groups[0]!.preferredSegmentId).toBe("s1");
  });
  it("does not group unrelated segments", () => {
    const segs = [seg("s0", 0, 3, "apples and oranges"), seg("s1", 3, 6, "quantum physics lecture notes")];
    expect(groupRepeatedTakes(segs)).toHaveLength(0);
  });
});

describe("jaccardSimilarity + normalizeText", () => {
  it("is 1 for identical and lower for divergent text", () => {
    expect(jaccardSimilarity("growth is good", "growth is good")).toBe(1);
    expect(jaccardSimilarity("growth is good", "totally unrelated")).toBeLessThan(0.2);
    expect(normalizeText("Hello, World!!")).toBe("hello world");
  });
});

describe("scoreCandidateHooks", () => {
  it("ranks an early tight question opener above a late filler opener", () => {
    const t = transcript([
      seg("s0", 0, 2, "why does nobody talk about retention"),
      seg("s1", 25, 27, "um so anyway that is basically it"),
    ]);
    const hooks = scoreCandidateHooks(t, { windowSeconds: 20 });
    expect(hooks.length).toBeGreaterThanOrEqual(1);
    expect(hooks[0]!.text).toContain("retention");
    expect(hooks[0]!.reasons).toContain("question-frame");
    // The 25s segment is outside the hook window and should be excluded.
    expect(hooks.some((h) => h.startSeconds === 25)).toBe(false);
  });
});

describe("silenceMarks + analyzeEditorial", () => {
  const audio: AudioFactsValue = {
    durationSeconds: 10, speechSeconds: 8, silenceSeconds: 2, speechRatio: 0.8,
    silenceThresholdDb: -30, minSilenceSeconds: 0.5, silences: [{ startSeconds: 4, endSeconds: 6 }],
  };
  it("turns silence regions into marks", () => {
    const marks = silenceMarks(audio);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kind).toBe("silence");
  });
  it("combines fillers, crew prompts, and silence, sorted by time", () => {
    const t = transcript([
      seg("s0", 0, 2, "why does nobody talk about retention"),
      seg("s1", 2, 4, "um let me restart from the top"),
    ]);
    const res = analyzeEditorial(t, audio);
    const kinds = new Set(res.marks.map((m) => m.kind));
    expect(kinds.has("filler")).toBe(true);
    expect(kinds.has("crew-prompt")).toBe(true);
    expect(kinds.has("silence")).toBe(true);
    const times = res.marks.map((m) => m.startSeconds);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(res.candidateHooks.length).toBeGreaterThan(0);
  });
});
