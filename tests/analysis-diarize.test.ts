import { describe, it, expect } from "vitest";
import {
  alignWordsToTurns,
  buildDiarizeArgs,
  diarize,
  diarizeScriptPath,
  parseSpeakerTurns,
  resolveDiarizeConfig,
  type SpeakerTurn,
} from "../src/analysis/diarize.js";
import type { WordValue } from "../src/analysis/schemas.js";
import type { ExecFn, ExecResult } from "../src/agent/exec.js";

function cfg(over = {}) {
  return resolveDiarizeConfig({ model: "pyannote/speaker-diarization-3.1", ...over });
}

function capturingRunner(result: Partial<ExecResult>): {
  fn: ExecFn;
  calls: Array<{ bin: string; args: readonly string[]; opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number } }>;
} {
  const calls: Array<{ bin: string; args: readonly string[]; opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number } }> = [];
  const fn: ExecFn = async (bin, args, opts) => {
    calls.push({ bin, args, opts: (opts ?? {}) as never });
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { fn, calls };
}

const goodStdout = JSON.stringify({
  model: "pyannote/speaker-diarization-3.1",
  turns: [
    { speaker: "SPEAKER_00", start: 0, end: 2 },
    { speaker: "SPEAKER_01", start: 2.1, end: 4 },
  ],
});

describe("diarizeScriptPath", () => {
  it("points at the checked-in bridge under python/", () => {
    expect(diarizeScriptPath().replace(/\\/g, "/")).toMatch(/python\/diarize_pyannote\.py$/);
  });
});

describe("buildDiarizeArgs", () => {
  const args = buildDiarizeArgs("/repo/python/diarize_pyannote.py", "/run/audio.wav", cfg());
  it("is an argument array with script, audio, and model", () => {
    expect(args[0]).toBe("/repo/python/diarize_pyannote.py");
    expect(args).toContain("--audio");
    expect(args).toContain("/run/audio.wav");
    expect(args).toContain("--model");
    expect(args).toContain("pyannote/speaker-diarization-3.1");
  });
  it("never emits a prompt flag (prompt-free)", () => {
    expect(args.join(" ")).not.toMatch(/prompt/i);
  });
  it("defaults to cached-only and requires an explicit download flag", () => {
    expect(args).not.toContain("--allow-model-download");
    expect(buildDiarizeArgs("/s.py", "/a.wav", cfg({ allowModelDownload: true }))).toContain("--allow-model-download");
  });
});

describe("resolveDiarizeConfig", () => {
  it("defaults to cached/local-only (no download)", () => {
    expect(resolveDiarizeConfig().allowModelDownload).toBe(false);
  });
});

describe("parseSpeakerTurns", () => {
  it("validates and maps turns into Seconds naming", () => {
    const turns = parseSpeakerTurns(goodStdout);
    expect(turns).toEqual([
      { speaker: "SPEAKER_00", startSeconds: 0, endSeconds: 2 },
      { speaker: "SPEAKER_01", startSeconds: 2.1, endSeconds: 4 },
    ]);
  });
  it("rejects a turn whose end precedes its start", () => {
    const bad = JSON.stringify({ turns: [{ speaker: "S0", start: 3, end: 1 }] });
    expect(() => parseSpeakerTurns(bad)).toThrow(/end must be >= start/);
  });
  it("rejects a negative start", () => {
    const bad = JSON.stringify({ turns: [{ speaker: "S0", start: -1, end: 1 }] });
    expect(() => parseSpeakerTurns(bad)).toThrow(/negative/);
  });
  it("rejects non-JSON stdout", () => {
    expect(() => parseSpeakerTurns("nope")).toThrow(/did not return JSON/);
  });
});

describe("diarize (process boundary)", () => {
  it("passes a bounded timeout and max buffer", async () => {
    const { fn, calls } = capturingRunner({ stdout: goodStdout });
    await diarize({ audioPath: "/run/audio.wav", config: cfg({ timeoutMs: 111, maxBuffer: 222 }), runner: fn });
    expect(calls[0]!.opts.timeoutMs).toBe(111);
    expect(calls[0]!.opts.maxBuffer).toBe(222);
  });

  it("returns validated turns and distinct speakers on success", async () => {
    const { fn } = capturingRunner({ stdout: goodStdout });
    const res = await diarize({ audioPath: "/a.wav", config: cfg(), runner: fn });
    expect(res.available).toBe(true);
    expect(res.speakers).toEqual(["SPEAKER_00", "SPEAKER_01"]);
    expect(res.turns).toHaveLength(2);
  });

  it("passes HF_TOKEN only in the child environment, never on argv, and never in the detail", async () => {
    const { fn, calls } = capturingRunner({ stdout: goodStdout });
    const token = "hf_SUPERSECRET_TOKEN";
    const res = await diarize({ audioPath: "/a.wav", config: cfg(), runner: fn, hfToken: token });
    expect(calls[0]!.opts.env?.HF_TOKEN).toBe(token);
    expect(calls[0]!.args.join(" ")).not.toContain(token);
    expect(res.detail).not.toContain(token);
  });

  it("reports unavailable (no throw) when pyannote is not installed", async () => {
    const { fn } = capturingRunner({ code: 3, stderr: "pyannote.audio import failed" });
    const res = await diarize({ audioPath: "/a.wav", config: cfg(), runner: fn });
    expect(res.available).toBe(false);
    expect(res.detail).toMatch(/not installed/);
  });

  it("reports unavailable when the model is not cached", async () => {
    const { fn } = capturingRunner({ code: 4 });
    const res = await diarize({ audioPath: "/a.wav", config: cfg(), runner: fn });
    expect(res.available).toBe(false);
    expect(res.detail).toMatch(/not cached/);
  });

  it("reports unavailable on a spawn error without throwing", async () => {
    const { fn } = capturingRunner({ code: null, spawnError: "ENOENT" });
    const res = await diarize({ audioPath: "/a.wav", config: cfg(), runner: fn });
    expect(res.available).toBe(false);
  });

  it("reports unavailable on malformed output rather than trusting it", async () => {
    const { fn } = capturingRunner({ code: 0, stdout: JSON.stringify({ turns: [{ speaker: "S0", start: 5, end: 1 }] }) });
    const res = await diarize({ audioPath: "/a.wav", config: cfg(), runner: fn });
    expect(res.available).toBe(false);
    expect(res.detail).toMatch(/unavailable/);
  });
});

describe("alignWordsToTurns", () => {
  const turns: SpeakerTurn[] = [
    { speaker: "SPEAKER_00", startSeconds: 0, endSeconds: 2 },
    { speaker: "SPEAKER_01", startSeconds: 2, endSeconds: 4 },
  ];
  const words: WordValue[] = [
    { text: "hi", startSeconds: 0.1, endSeconds: 0.5 },
    { text: "there", startSeconds: 2.5, endSeconds: 2.9 },
    { text: "edge", startSeconds: 1.8, endSeconds: 2.4 }, // straddles the boundary
    { text: "gap", startSeconds: 10, endSeconds: 11 }, // no overlapping turn
  ];

  it("assigns each word the speaker of the turn it overlaps most", () => {
    const aligned = alignWordsToTurns(words, turns);
    expect(aligned[0]!.speaker).toBe("SPEAKER_00");
    expect(aligned[1]!.speaker).toBe("SPEAKER_01");
    // "edge" overlaps SPEAKER_00 for 0.2s and SPEAKER_01 for 0.4s -> SPEAKER_01 wins.
    expect(aligned[2]!.speaker).toBe("SPEAKER_01");
  });

  it("leaves a word with no overlapping turn unassigned", () => {
    const aligned = alignWordsToTurns(words, turns);
    expect(aligned[3]!.speaker).toBeUndefined();
  });

  it("does not mutate the input words", () => {
    const before = JSON.parse(JSON.stringify(words));
    alignWordsToTurns(words, turns);
    expect(words).toEqual(before);
  });
});
