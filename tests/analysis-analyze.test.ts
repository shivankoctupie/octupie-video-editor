import { describe, it, expect } from "vitest";
import { analyzeSource, buildAudioExtractArgs, defaultAnalysisOutDir } from "../src/analysis/analyze.js";
import type { TranscriptValue, AudioFactsValue } from "../src/analysis/schemas.js";

function fakeTranscript(): TranscriptValue {
  return {
    clip: { path: "source/clip.mov" },
    durationSeconds: 6,
    language: "en",
    words: [
      { text: "why", startSeconds: 0, endSeconds: 0.3 },
      { text: "nobody", startSeconds: 0.3, endSeconds: 0.7 },
      { text: "talks", startSeconds: 0.7, endSeconds: 1.0 },
      { text: "um", startSeconds: 1.0, endSeconds: 1.2 },
    ],
    segments: [
      { id: "seg0", startSeconds: 0, endSeconds: 1.0, text: "why nobody talks", words: [
        { text: "why", startSeconds: 0, endSeconds: 0.3 },
        { text: "nobody", startSeconds: 0.3, endSeconds: 0.7 },
        { text: "talks", startSeconds: 0.7, endSeconds: 1.0 },
      ] },
    ],
    speakers: [],
  };
}

const fakeAudio: AudioFactsValue = {
  durationSeconds: 6, speechSeconds: 5, silenceSeconds: 1, speechRatio: 0.83,
  silenceThresholdDb: -30, minSilenceSeconds: 0.5, silences: [{ startSeconds: 5, endSeconds: 6 }],
};

function baseDeps(writes: Record<string, string>, extras = {}) {
  return {
    clipRelPath: "source/clip.mov",
    outDir: "/run/out",
    now: new Date("2026-07-28T00:00:00.000Z"),
    resolveClipPath: (rel: string) => "/abs/root/" + rel,
    probeDuration: async () => 6,
    extractAudio: async () => {},
    transcribe: async () => fakeTranscript(),
    detectSilenceFn: async () => fakeAudio,
    ensureDir: () => {},
    writeFile: (p: string, d: string) => { writes[p] = d; },
    ...extras,
  };
}

describe("buildAudioExtractArgs / defaultAnalysisOutDir", () => {
  it("extracts a mono 16 kHz wav with argument array", () => {
    const args = buildAudioExtractArgs("/abs/clip.mov", "/run/out/audio.wav");
    expect(args).toEqual(["-i", "/abs/clip.mov", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", "/run/out/audio.wav"]);
  });
  it("derives a portable output dir under output/analysis", () => {
    expect(defaultAnalysisOutDir("source/Main aroll hook1.mov").replace(/\\/g, "/")).toMatch(/\/output\/analysis\/Main_aroll_hook1\.mov-[0-9a-f]{8}$/);
  });
});

describe("analyzeSource", () => {
  it("writes analysis, transcript, srt, and vtt all under the out dir", async () => {
    const writes: Record<string, string> = {};
    const res = await analyzeSource(baseDeps(writes));
    for (const p of [res.analysisPath, res.transcriptPath, res.srtPath, res.vttPath]) {
      expect(p.replace(/\\/g, "/")).toMatch(/^\/run\/out\//);
    }
    expect(Object.keys(writes)).toHaveLength(4);
    const analysis = JSON.parse(writes[res.analysisPath]!);
    expect(analysis.format).toBe("octupie-source-analysis/v1");
    expect(analysis.transcription.provider).toBe("faster-whisper");
    // Editorial pass produced a filler mark, a silence mark, and a candidate hook.
    expect(analysis.marks.some((m: { kind: string }) => m.kind === "filler")).toBe(true);
    expect(analysis.marks.some((m: { kind: string }) => m.kind === "silence")).toBe(true);
    expect(analysis.candidateHooks.length).toBeGreaterThan(0);
    // Honest caveats present.
    expect(analysis.notes.join(" ")).toMatch(/not semantic certainty/);
    expect(analysis.notes.join(" ")).toMatch(/diarization is not implemented/i);
  });

  it("passes the model and language through to the transcriber and records them", async () => {
    const writes: Record<string, string> = {};
    let seenConfig: unknown;
    const res = await analyzeSource(baseDeps(writes, {
      model: "small.en",
      language: "en",
      transcribe: async (a: { config?: unknown }) => { seenConfig = a.config; return fakeTranscript(); },
    }));
    expect(seenConfig).toMatchObject({ model: "small.en", language: "en" });
    expect(res.analysis.transcription.model).toBe("small.en");
  });

  it("includes frame metrics only when includeFrames is set", async () => {
    const writes: Record<string, string> = {};
    let framesCalled = 0;
    const withFrames = await analyzeSource(baseDeps(writes, {
      includeFrames: true,
      analyzeFrames: async () => { framesCalled++; return [{ atSeconds: 0, blur: 100, brightness: 0.5, faceCount: 1, faces: [{ xNorm: 0.4, yNorm: 0.3, wNorm: 0.2, hNorm: 0.3 }] }]; },
    }));
    expect(framesCalled).toBe(1);
    expect(withFrames.analysis.frames).toHaveLength(1);

    const writes2: Record<string, string> = {};
    const noFrames = await analyzeSource(baseDeps(writes2));
    expect(noFrames.analysis.frames).toBeUndefined();
  });

  it("propagates the containment guard (a path escape rejects before any spawn)", async () => {
    const writes: Record<string, string> = {};
    let extracted = false;
    await expect(analyzeSource(baseDeps(writes, {
      resolveClipPath: () => { throw new Error("escapes the asset root"); },
      extractAudio: async () => { extracted = true; },
    }))).rejects.toThrow(/escapes the asset root/);
    expect(extracted).toBe(false);
    expect(Object.keys(writes)).toHaveLength(0);
  });
});
