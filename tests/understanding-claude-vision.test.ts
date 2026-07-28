import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import {
  buildClaudeVisionArgs,
  buildVisionPrompt,
  understandWithClaudeVision,
  type ClaudeVisionInput,
  type FrameFile,
} from "../src/understanding/claudeVision.js";
import type { SourceAnalysisValue } from "../src/analysis/schemas.js";
import type { ExecFn, ExecResult } from "../src/agent/exec.js";

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
    words: [
      { text: "hello", startSeconds: 0, endSeconds: 0.4 },
      { text: "world", startSeconds: 0.5, endSeconds: 0.9 },
    ],
    segments: [],
    speakers: [],
  },
  marks: [{ kind: "filler", startSeconds: 1, endSeconds: 1.2, reason: "um" }],
  takes: [],
  candidateHooks: [{ startSeconds: 0, endSeconds: 0.9, text: "hello world", score: 0.6, reasons: ["early-start"] }],
  audio: {
    durationSeconds: 6,
    speechSeconds: 6,
    silenceSeconds: 0,
    speechRatio: 1,
    silenceThresholdDb: -30,
    minSilenceSeconds: 0.5,
    silences: [],
  },
  notes: ["heuristic"],
};

const FRAME_DIR = resolve("output", "analysis", "clip", "frames");
const frames: FrameFile[] = [
  { absPath: join(FRAME_DIR, "frame_00001.jpg"), atSeconds: 0 },
  { absPath: join(FRAME_DIR, "frame_00002.jpg"), atSeconds: 2 },
];

const goodModel = {
  findings: [
    {
      kind: "hook-moment",
      startSeconds: 0,
      endSeconds: 0.9,
      confidence: 0.8,
      rationale: "Opens with a direct claim to camera.",
      evidenceFrames: [{ path: "frame_00001.jpg", atSeconds: 0 }],
    },
  ],
  segments: [{ startSeconds: 0, endSeconds: 2, description: "intro", salience: 0.7, tags: ["intro"] }],
  summary: "A short intro.",
  limitations: ["Only 2 frames sampled."],
};

/** A claude `--output-format json` envelope wrapping the model's text reply. */
function envelope(resultText: string): string {
  return JSON.stringify({ result: resultText, is_error: false });
}

function structuredEnvelope(value: unknown): string {
  return JSON.stringify({ result: "", structured_output: value, is_error: false });
}

function capturingRunner(result: Partial<ExecResult>): {
  fn: ExecFn;
  calls: Array<{ bin: string; args: readonly string[]; opts: unknown }>;
} {
  const calls: Array<{ bin: string; args: readonly string[]; opts: unknown }> = [];
  const fn: ExecFn = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { fn, calls };
}

const okStat = () => ({ size: 1000, isFile: true });

function baseInput(over: Partial<ClaudeVisionInput> = {}): ClaudeVisionInput {
  return {
    analysis,
    frames,
    frameDir: FRAME_DIR,
    statFile: okStat,
    realpathFile: (p) => p,
    readFramePrefix: () => Buffer.from([0xff, 0xd8, 0xff]),
    now: new Date("2026-07-28T00:00:00.000Z"),
    ...over,
  };
}

describe("buildClaudeVisionArgs", () => {
  const args = buildClaudeVisionArgs("SYS", FRAME_DIR);
  it("restricts the actual tool set to Read only", () => {
    const tools = args.indexOf("--tools");
    expect(tools).toBeGreaterThanOrEqual(0);
    expect(args[tools + 1]).toBe("Read");
    const i = args.indexOf("--allowedTools");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("Read");
  });
  it("does not expose Bash, Edit, Write, browser, or task tools", () => {
    const i = args.indexOf("--tools");
    expect(String(args[i + 1])).toBe("Read");
    expect(args).toContain("--safe-mode");
  });
  it("passes a direct object schema accepted by Claude structured output", () => {
    const schemaIndex = args.indexOf("--json-schema");
    const schema = JSON.parse(args[schemaIndex + 1]!) as { type?: string; $ref?: string };
    expect(schema.type).toBe("object");
    expect(schema.$ref).toBeUndefined();
  });

  it("disables session persistence and requests JSON output", () => {
    expect(args).toContain("--no-session-persistence");
    const oi = args.indexOf("--output-format");
    expect(args[oi + 1]).toBe("json");
  });
  it("grants exactly the frame directory via --add-dir and nothing else", () => {
    const addDirIdxs = args.map((a, i) => (a === "--add-dir" ? i : -1)).filter((i) => i >= 0);
    expect(addDirIdxs).toHaveLength(1);
    expect(args[addDirIdxs[0]! + 1]).toBe(FRAME_DIR);
  });
  it("uses noninteractive deny-by-default permissions and an empty strict MCP config", () => {
    const permission = args.indexOf("--permission-mode");
    expect(args[permission + 1]).toBe("dontAsk");
    expect(args).toContain("--strict-mcp-config");
    const mcp = args.indexOf("--mcp-config");
    expect(args[mcp + 1]).toBe('{"mcpServers":{}}');
    expect(args.join(" ")).not.toMatch(/dangerously-skip-permissions/);
  });
});

describe("buildVisionPrompt", () => {
  it("combines timed transcript, frame list, and a JSON schema", () => {
    const p = buildVisionPrompt(analysis, frames);
    expect(p).toContain("hello");
    expect(p).toContain("frame_00001.jpg");
    expect(p).toContain("JSON Schema");
    expect(p).toMatch(/\"type\"/); // the embedded schema
  });
});

describe("understandWithClaudeVision", () => {
  it("spawns with an argument array, delivers the prompt on stdin, and stamps engine identity", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    const u = await understandWithClaudeVision(baseInput({ runner: fn }));
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0]!.args)).toBe(true);
    expect((calls[0]!.opts as { input?: string; cwd?: string }).input).toContain("hello");
    expect((calls[0]!.opts as { cwd?: string }).cwd).toBe(FRAME_DIR);
    // Identity is stamped by the engine, not the model.
    expect(u.provider).toEqual({ id: "claude-cli", model: "claude-code-vision" });
    expect(u.clip.path).toBe("source/clip.mov");
    expect(u.findings[0]!.kind).toBe("hook-moment");
  });

  it("accepts Claude structured_output produced by --json-schema", async () => {
    const { fn } = capturingRunner({ stdout: structuredEnvelope(goodModel) });
    const u = await understandWithClaudeVision(baseInput({ runner: fn }));
    expect(u.findings[0]!.kind).toBe("hook-moment");
  });

  it("passes bounded timeout and output cap to the runner", async () => {
    let opts: { timeoutMs?: number; maxBuffer?: number } | undefined;
    const fn: ExecFn = async (_b, _a, o) => {
      opts = o as typeof opts;
      return { code: 0, stdout: envelope(JSON.stringify(goodModel)), stderr: "", timedOut: false };
    };
    await understandWithClaudeVision(baseInput({ runner: fn, config: { timeoutMs: 4321, maxOutputBytes: 8765 } }));
    expect(opts).toMatchObject({ timeoutMs: 4321, maxBuffer: 8765 });
  });

  it("rejects a frame path outside the granted directory before spawning", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    const escaping = [{ absPath: resolve(FRAME_DIR, "..", "secret.jpg"), atSeconds: 0 }];
    await expect(understandWithClaudeVision(baseInput({ runner: fn, frames: escaping })))
      .rejects.toThrow(/escapes the granted frame directory/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a symlink whose real target escapes the granted directory before spawning", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    await expect(
      understandWithClaudeVision(baseInput({
        runner: fn,
        realpathFile: (p) => p.endsWith("frame_00001.jpg") ? resolve(FRAME_DIR, "..", "secret.txt") : p,
      })),
    ).rejects.toThrow(/real path escapes the granted frame directory/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-JPEG file before spawning", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    await expect(
      understandWithClaudeVision(baseInput({ runner: fn, readFramePrefix: () => Buffer.from("not an image") })),
    ).rejects.toThrow(/not a JPEG/);
    expect(calls).toHaveLength(0);
  });

  it("enforces the frame-count cap before spawning", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    const many = Array.from({ length: 5 }, (_, i) => ({ absPath: join(FRAME_DIR, `frame_0000${i}.jpg`), atSeconds: i }));
    await expect(understandWithClaudeVision(baseInput({ runner: fn, frames: many, config: { maxFrames: 3 } })))
      .rejects.toThrow(/exceeds the cap/);
    expect(calls).toHaveLength(0);
  });

  it("enforces the per-frame byte cap before spawning", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    await expect(
      understandWithClaudeVision(baseInput({ runner: fn, statFile: () => ({ size: 9_000_000, isFile: true }), config: { maxFrameBytes: 1000 } })),
    ).rejects.toThrow(/over the .* cap/);
    expect(calls).toHaveLength(0);
  });

  it("enforces the prompt byte cap before spawning", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    await expect(understandWithClaudeVision(baseInput({ runner: fn, config: { maxPromptBytes: 10 } })))
      .rejects.toThrow(/over the .*-byte cap/);
    expect(calls).toHaveLength(0);
  });

  it("rejects non-JSON model output", async () => {
    const { fn } = capturingRunner({ stdout: envelope("not json at all") });
    await expect(understandWithClaudeVision(baseInput({ runner: fn }))).rejects.toThrow(/did not return a JSON object/);
  });

  it("rejects evidence frames the provider was not given", async () => {
    const invented = {
      ...goodModel,
      findings: [{
        ...goodModel.findings[0],
        evidenceFrames: [{ path: "frame_99999.jpg", atSeconds: 0 }],
      }],
    };
    const { fn } = capturingRunner({ stdout: envelope(JSON.stringify(invented)) });
    await expect(understandWithClaudeVision(baseInput({ runner: fn }))).rejects.toThrow(/was not supplied/);
  });

  it("rejects schema-invalid model output (finding past the clip)", async () => {
    const bad = { ...goodModel, findings: [{ ...goodModel.findings[0], startSeconds: 5, endSeconds: 500 }] };
    const { fn } = capturingRunner({ stdout: envelope(JSON.stringify(bad)) });
    await expect(understandWithClaudeVision(baseInput({ runner: fn }))).rejects.toThrow(/validation/);
  });

  it("throws on a spawn error", async () => {
    const { fn } = capturingRunner({ code: null, spawnError: "ENOENT" });
    await expect(understandWithClaudeVision(baseInput({ runner: fn }))).rejects.toThrow(/Could not start/);
  });

  it("throws on timeout", async () => {
    const { fn } = capturingRunner({ code: null, timedOut: true });
    await expect(understandWithClaudeVision(baseInput({ runner: fn }))).rejects.toThrow(/timed out/);
  });

  it("throws when output was truncated at the cap", async () => {
    const { fn } = capturingRunner({ code: 0, stdout: envelope(JSON.stringify(goodModel)), truncated: true });
    await expect(understandWithClaudeVision(baseInput({ runner: fn }))).rejects.toThrow(/exceeded/);
  });

  it("throws with stderr on a nonzero exit", async () => {
    const { fn } = capturingRunner({ code: 2, stderr: "claude blew up" });
    await expect(understandWithClaudeVision(baseInput({ runner: fn }))).rejects.toThrow(/claude blew up/);
  });

  it("uses bounded stdout diagnostics when a provider exits nonzero without stderr", async () => {
    const { fn } = capturingRunner({ code: 1, stdout: '{"is_error":true,"result":"schema rejected"}' });
    await expect(understandWithClaudeVision(baseInput({ runner: fn }))).rejects.toThrow(/schema rejected/);
  });
});
