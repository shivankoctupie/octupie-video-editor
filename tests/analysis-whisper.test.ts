import { describe, it, expect } from "vitest";
import { buildWhisperArgs, resolveWhisperConfig, transcribeWithWhisper, whisperScriptPath } from "../src/analysis/whisper.js";
import type { ExecFn, ExecResult } from "../src/agent/exec.js";

function cfg(over = {}) {
  return resolveWhisperConfig({ model: "base.en", language: "en", ...over });
}

function fakeRunner(result: Partial<ExecResult>): { fn: ExecFn; calls: Array<{ bin: string; args: readonly string[] }> } {
  const calls: Array<{ bin: string; args: readonly string[] }> = [];
  const fn: ExecFn = async (bin, args) => {
    calls.push({ bin, args });
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { fn, calls };
}

const goodBridge = JSON.stringify({
  language: "en",
  duration: 3.2,
  words: [
    { text: "hello", start: 0.0, end: 0.4, probability: 0.98 },
    { text: "world", start: 0.5, end: 0.9, probability: 0.97 },
  ],
  segments: [{ id: "seg0", start: 0.0, end: 0.9, text: "hello world", words: [
    { text: "hello", start: 0.0, end: 0.4 },
    { text: "world", start: 0.5, end: 0.9 },
  ] }],
});

describe("buildWhisperArgs", () => {
  const args = buildWhisperArgs("/repo/python/transcribe_faster_whisper.py", "/run/audio.wav", cfg());
  it("is an argument array with the script first and audio/model flags", () => {
    expect(Array.isArray(args)).toBe(true);
    expect(args[0]).toBe("/repo/python/transcribe_faster_whisper.py");
    expect(args).toContain("--audio");
    expect(args).toContain("/run/audio.wav");
    expect(args).toContain("--model");
    expect(args).toContain("base.en");
    expect(args).toContain("--language");
    expect(args).toContain("en");
  });
  it("never emits any prompt flag (prompt-free by construction)", () => {
    const joined = args.join(" ");
    expect(joined).not.toMatch(/prompt/i);
    expect(joined).not.toMatch(/hotword/i);
  });
  it("defaults to cached models only and requires an explicit download flag", () => {
    expect(args).not.toContain("--allow-model-download");
    const allowed = buildWhisperArgs(
      "/s.py",
      "/a.wav",
      resolveWhisperConfig({ allowModelDownload: true }),
    );
    expect(allowed).toContain("--allow-model-download");
  });
  it("omits --language when none is configured", () => {
    const a = buildWhisperArgs("/s.py", "/a.wav", resolveWhisperConfig({ language: undefined }));
    expect(a).not.toContain("--language");
  });
});

describe("whisperScriptPath", () => {
  it("points at the checked-in bridge under python/", () => {
    expect(whisperScriptPath().replace(/\\/g, "/")).toMatch(/python\/transcribe_faster_whisper\.py$/);
  });
});

describe("transcribeWithWhisper", () => {
  const clip = { path: "source/clip.mov" };

  it("spawns with an argument array (no shell string) and validates the transcript", async () => {
    const { fn, calls } = fakeRunner({ stdout: goodBridge });
    const t = await transcribeWithWhisper({ clip, mediaPath: "/run/audio.wav", durationSeconds: 3.2, config: cfg(), runner: fn });
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0]!.args)).toBe(true);
    expect(calls[0]!.args).toContain("--audio");
    expect(t.words.map((w) => w.text)).toEqual(["hello", "world"]);
    expect(t.language).toBe("en");
    expect(t.words[0]!.confidence).toBeCloseTo(0.98);
  });

  it("passes a bounded timeout and max buffer to the runner", async () => {
    let opts: unknown;
    const fn: ExecFn = async (_b, _a, o) => { opts = o; return { code: 0, stdout: goodBridge, stderr: "", timedOut: false }; };
    await transcribeWithWhisper({ clip, mediaPath: "/a.wav", durationSeconds: 3.2, config: cfg({ timeoutMs: 1234, maxBuffer: 5678 }), runner: fn });
    expect(opts).toMatchObject({ timeoutMs: 1234, maxBuffer: 5678 });
  });

  it("throws on a spawn error", async () => {
    const { fn } = fakeRunner({ code: null, spawnError: "ENOENT" });
    await expect(transcribeWithWhisper({ clip, mediaPath: "/a.wav", durationSeconds: 3, config: cfg(), runner: fn }))
      .rejects.toThrow(/Could not start/);
  });

  it("throws on timeout", async () => {
    const { fn } = fakeRunner({ code: null, timedOut: true });
    await expect(transcribeWithWhisper({ clip, mediaPath: "/a.wav", durationSeconds: 3, config: cfg(), runner: fn }))
      .rejects.toThrow(/timed out/);
  });

  it("throws when output was truncated at the buffer cap", async () => {
    const { fn } = fakeRunner({ code: 0, stdout: goodBridge, truncated: true });
    await expect(transcribeWithWhisper({ clip, mediaPath: "/a.wav", durationSeconds: 3, config: cfg(), runner: fn }))
      .rejects.toThrow(/limit/);
  });

  it("throws with stderr on a nonzero exit", async () => {
    const { fn } = fakeRunner({ code: 5, stderr: "transcription failed: boom" });
    await expect(transcribeWithWhisper({ clip, mediaPath: "/a.wav", durationSeconds: 3, config: cfg(), runner: fn }))
      .rejects.toThrow(/exited 5/);
  });

  it("throws on non-JSON stdout", async () => {
    const { fn } = fakeRunner({ code: 0, stdout: "not json" });
    await expect(transcribeWithWhisper({ clip, mediaPath: "/a.wav", durationSeconds: 3, config: cfg(), runner: fn }))
      .rejects.toThrow(/did not return JSON/);
  });

  it("rejects a bridge transcript whose words run past the clip", async () => {
    const bad = JSON.stringify({ language: "en", duration: 1, words: [{ text: "a", start: 0, end: 5 }], segments: [] });
    const { fn } = fakeRunner({ code: 0, stdout: bad });
    await expect(transcribeWithWhisper({ clip, mediaPath: "/a.wav", durationSeconds: 1, config: cfg(), runner: fn }))
      .rejects.toThrow(/validation/);
  });
});
