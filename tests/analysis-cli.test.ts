import { beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { runAgentCli, type AgentCliDeps } from "../src/agent/cli.js";
import type { AnalyzeSourceInput, AnalyzeSourceResult } from "../src/analysis/analyze.js";

const analysisResult: AnalyzeSourceResult = {
  analysisPath: "C:/repo/output/custom/analysis.json",
  transcriptPath: "C:/repo/output/custom/transcript.json",
  srtPath: "C:/repo/output/custom/captions.srt",
  vttPath: "C:/repo/output/custom/captions.vtt",
  analysis: {
    format: "octupie-source-analysis/v1",
    clip: { path: "source/clip.mov" },
    durationSeconds: 6,
    generatedAt: "2026-07-28T00:00:00.000Z",
    transcription: { provider: "faster-whisper", model: "tiny.en", language: "en" },
    transcript: {
      clip: { path: "source/clip.mov" },
      durationSeconds: 6,
      language: "en",
      words: [{ text: "hello", startSeconds: 0, endSeconds: 0.4 }],
      segments: [{
        id: "seg0",
        startSeconds: 0,
        endSeconds: 0.4,
        text: "hello",
        words: [{ text: "hello", startSeconds: 0, endSeconds: 0.4 }],
      }],
      speakers: [],
    },
    marks: [],
    takes: [],
    candidateHooks: [{ startSeconds: 0, endSeconds: 0.4, text: "hello", score: 0.5, reasons: ["early-start"] }],
    audio: {
      durationSeconds: 6,
      speechSeconds: 6,
      silenceSeconds: 0,
      speechRatio: 1,
      silenceThresholdDb: -30,
      minSilenceSeconds: 0.5,
      silences: [],
    },
    frames: [{ atSeconds: 0, blur: 100, brightness: 0.5, faceCount: 0, faces: [] }],
    notes: ["heuristic"],
  },
};

describe("agent analyze CLI", () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
  });

  it("requires a relative clip path", async () => {
    const code = await runAgentCli(["analyze"], {
      log: (s) => out.push(s),
      errorLog: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/relative-clip-path/);
  });

  it("passes explicit analysis flags and emits machine-readable output", async () => {
    let seen: AnalyzeSourceInput | undefined;
    const deps: AgentCliDeps = {
      log: (s) => out.push(s),
      errorLog: (s) => err.push(s),
      now: new Date("2026-07-28T00:00:00.000Z"),
      analyze: async (input) => {
        seen = input;
        return analysisResult;
      },
    };

    const code = await runAgentCli([
      "analyze",
      "source/clip.mov",
      "--out",
      "output/custom",
      "--model",
      "tiny.en",
      "--language",
      "en",
      "--allow-model-download",
      "--frames",
      "--json",
    ], deps);

    expect(code).toBe(0);
    expect(seen).toMatchObject({
      clipRelPath: "source/clip.mov",
      outDir: resolve(process.cwd(), "output/custom"),
      model: "tiny.en",
      language: "en",
      allowModelDownload: true,
      includeFrames: true,
    });
    const payload = JSON.parse(out.join("\n"));
    expect(payload).toMatchObject({
      analysisPath: analysisResult.analysisPath,
      words: 1,
      candidateHooks: 1,
      frames: 1,
    });
    expect(err).toEqual([]);
  });

  it("returns a concise error when analysis fails", async () => {
    const code = await runAgentCli(["analyze", "source/clip.mov"], {
      log: (s) => out.push(s),
      errorLog: (s) => err.push(s),
      analyze: async () => {
        throw new Error("escapes the asset root");
      },
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Analyze failed: escapes the asset root/);
  });
});
