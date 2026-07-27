import { describe, it, expect } from "vitest";
import { parseSilenceLog, buildSilenceDetectArgs, silenceLogToAudioFacts, detectSilence } from "../src/analysis/silence.js";
import type { RunResult } from "../src/ffmpeg/spawn.js";

const LOG = `
[silencedetect @ 0x1] silence_start: 2.5
[silencedetect @ 0x1] silence_end: 3.4 | silence_duration: 0.9
[silencedetect @ 0x1] silence_start: 8.0
[Parsed_volumedetect] mean_volume: -21.3 dB
[Parsed_volumedetect] max_volume: -3.1 dB
`;

describe("parseSilenceLog", () => {
  it("parses closed regions and closes an open trailing region at the duration", () => {
    const log = parseSilenceLog(LOG, 10);
    expect(log.regions).toEqual([
      { startSeconds: 2.5, endSeconds: 3.4 },
      { startSeconds: 8.0, endSeconds: 10 },
    ]);
    expect(log.meanVolumeDb).toBe(-21.3);
    expect(log.maxVolumeDb).toBe(-3.1);
  });
  it("returns no regions for a clean log", () => {
    expect(parseSilenceLog("no silence here", 5).regions).toEqual([]);
  });
});

describe("buildSilenceDetectArgs", () => {
  it("runs silencedetect+volumedetect to the null muxer with the given threshold", () => {
    const args = buildSilenceDetectArgs("/run/audio.wav", -30, 0.5);
    const joined = args.join(" ");
    expect(joined).toContain("silencedetect=noise=-30dB:d=0.5");
    expect(joined).toContain("volumedetect");
    expect(args).toContain("-f");
    expect(args).toContain("null");
    expect(args).toContain("/run/audio.wav");
  });
});

describe("silenceLogToAudioFacts", () => {
  it("computes speech/silence split and ratio", () => {
    const facts = silenceLogToAudioFacts(parseSilenceLog(LOG, 10), 10, -30, 0.5);
    // 0.9 + 2.0 = 2.9s silent of 10s.
    expect(facts.silenceSeconds).toBeCloseTo(2.9);
    expect(facts.speechSeconds).toBeCloseTo(7.1);
    expect(facts.speechRatio).toBeCloseTo(0.71);
    expect(facts.silences).toHaveLength(2);
    expect(facts.meanVolumeDb).toBe(-21.3);
  });
});

describe("detectSilence", () => {
  it("runs the injected FFmpeg runner and validates the facts", async () => {
    let gotArgs: readonly string[] = [];
    const runner = async (args: readonly string[]): Promise<RunResult> => {
      gotArgs = args;
      return { code: 0, stdout: "", stderr: LOG };
    };
    const facts = await detectSilence({ audioPath: "/run/audio.wav", durationSeconds: 10, runner });
    expect(gotArgs.join(" ")).toContain("silencedetect");
    expect(facts.durationSeconds).toBe(10);
    expect(facts.silences).toHaveLength(2);
  });
  it("throws when FFmpeg fails to decode", async () => {
    const runner = async (): Promise<RunResult> => ({ code: 1, stdout: "", stderr: "boom" });
    await expect(detectSilence({ audioPath: "/a.wav", durationSeconds: 10, runner })).rejects.toThrow(/Silence detection failed/);
  });
});
