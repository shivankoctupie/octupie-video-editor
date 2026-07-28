import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import {
  buildClaudeCritiqueArgs,
  buildCritiquePrompt,
  critiqueWithClaude,
  CLAUDE_CRITIQUE_MODEL_LABEL,
  type CritiqueInput,
} from "../src/critique/claudeCritique.js";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import type { SampledMasterFrame } from "../src/critique/sampleMaster.js";
import type { ExecFn, ExecResult } from "../src/agent/exec.js";

function makePlan(): EditPlan {
  const parsed = parseEditPlan({
    format: "octupie-edit-plan/v1",
    title: "Neutral Founder Reel",
    preset: "neutral-founder-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 6,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes: [
      { id: "hook", type: "hook", start: 0, end: 3, heading: "Big claim" },
      { id: "payoff", type: "payoff", start: 3, end: 6, heading: "Proof" },
    ],
    output: { fileName: "neutral-founder-reel.mp4" },
  });
  if (!parsed.ok || !parsed.plan) throw new Error(parsed.errors.join("; "));
  return parsed.plan;
}

const PLAN = makePlan();
const MASTER = { path: "neutral-founder-reel.mp4" };
const FRAME_DIR = resolve("output", "critique-frames");
const frames: SampledMasterFrame[] = [
  { absPath: join(FRAME_DIR, "critique_frame_00001.jpg"), atSeconds: 0 },
  { absPath: join(FRAME_DIR, "critique_frame_00002.jpg"), atSeconds: 2 },
];

const goodModel = {
  approved: false,
  notes: [
    {
      atSeconds: 2,
      severity: "blocker",
      category: "visual",
      note: "A black frame flashes near two seconds.",
      evidenceFrame: { path: "critique_frame_00002.jpg", atSeconds: 2 },
    },
  ],
  summary: "One blocker near 2s.",
  limitations: ["Only 2 frames were sampled."],
};

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

function base(over: Partial<CritiqueInput> = {}): CritiqueInput {
  return {
    plan: PLAN,
    master: MASTER,
    durationSeconds: 6,
    frames,
    frameDir: FRAME_DIR,
    statFile: okStat,
    realpathFile: (p) => p,
    readFramePrefix: () => Buffer.from([0xff, 0xd8, 0xff]),
    now: new Date("2026-07-28T00:00:00.000Z"),
    ...over,
  };
}

describe("buildClaudeCritiqueArgs", () => {
  const args = buildClaudeCritiqueArgs("SYS", FRAME_DIR);
  it("restricts the tool set to Read only and enables safe-mode", () => {
    const t = args.indexOf("--tools");
    expect(args[t + 1]).toBe("Read");
    const a = args.indexOf("--allowedTools");
    expect(args[a + 1]).toBe("Read");
    expect(args).toContain("--safe-mode");
    expect(args.join(" ")).not.toMatch(/dangerously-skip-permissions/);
  });
  it("passes a direct top-level object schema (no $ref) for structured output", () => {
    const i = args.indexOf("--json-schema");
    const schema = JSON.parse(args[i + 1]!) as { type?: string; $ref?: string };
    expect(schema.type).toBe("object");
    expect(schema.$ref).toBeUndefined();
  });
  it("disables session persistence, uses an empty strict MCP config, and grants only the frame dir", () => {
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    const m = args.indexOf("--mcp-config");
    expect(args[m + 1]).toBe('{"mcpServers":{}}');
    const addDirs = args.map((a, i) => (a === "--add-dir" ? i : -1)).filter((i) => i >= 0);
    expect(addDirs).toHaveLength(1);
    expect(args[addDirs[0]! + 1]).toBe(FRAME_DIR);
    const perm = args.indexOf("--permission-mode");
    expect(args[perm + 1]).toBe("dontAsk");
    const oi = args.indexOf("--output-format");
    expect(args[oi + 1]).toBe("json");
  });
});

describe("buildCritiquePrompt", () => {
  it("combines the plan intent, frame list, and a JSON schema", () => {
    const p = buildCritiquePrompt(PLAN, MASTER, 6, frames);
    expect(p).toContain("Neutral Founder Reel");
    expect(p).toContain("critique_frame_00001.jpg");
    expect(p).toContain("JSON Schema");
    expect(p).toMatch(/"type"/);
  });
});

describe("critiqueWithClaude", () => {
  it("spawns with an argument array, delivers the prompt on stdin, and stamps engine identity", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    const c = await critiqueWithClaude(base({ runner: fn }));
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0]!.args)).toBe(true);
    expect((calls[0]!.opts as { input?: string }).input).toContain("Neutral Founder Reel");
    expect((calls[0]!.opts as { cwd?: string }).cwd).toBe(FRAME_DIR);
    expect(c.provider).toEqual({ id: "claude-cli", model: CLAUDE_CRITIQUE_MODEL_LABEL });
    expect(c.master.path).toBe("neutral-founder-reel.mp4");
    expect(c.approved).toBe(false);
    expect(c.notes[0]!.severity).toBe("blocker");
  });

  it("accepts Claude structured_output produced by --json-schema", async () => {
    const { fn } = capturingRunner({ stdout: structuredEnvelope(goodModel) });
    const c = await critiqueWithClaude(base({ runner: fn }));
    expect(c.notes[0]!.category).toBe("visual");
  });

  it("passes a bounded timeout and output cap to the runner", async () => {
    let opts: { timeoutMs?: number; maxBuffer?: number } | undefined;
    const fn: ExecFn = async (_b, _a, o) => {
      opts = o as typeof opts;
      return { code: 0, stdout: envelope(JSON.stringify(goodModel)), stderr: "", timedOut: false };
    };
    await critiqueWithClaude(base({ runner: fn, config: { timeoutMs: 4321, maxOutputBytes: 8765 } }));
    expect(opts).toMatchObject({ timeoutMs: 4321, maxBuffer: 8765 });
  });

  it("rejects a frame path outside the granted directory before spawning", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    const escaping = [{ absPath: resolve(FRAME_DIR, "..", "secret.jpg"), atSeconds: 0 }];
    await expect(critiqueWithClaude(base({ runner: fn, frames: escaping }))).rejects.toThrow(/escapes the granted frame directory/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a symlink whose real target escapes the granted directory before spawning", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    await expect(
      critiqueWithClaude(base({
        runner: fn,
        realpathFile: (p) => (p.endsWith("critique_frame_00001.jpg") ? resolve(FRAME_DIR, "..", "secret.txt") : p),
      })),
    ).rejects.toThrow(/real path escapes the granted frame directory/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-JPEG file before spawning", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    await expect(
      critiqueWithClaude(base({ runner: fn, readFramePrefix: () => Buffer.from("not an image") })),
    ).rejects.toThrow(/not a JPEG/);
    expect(calls).toHaveLength(0);
  });

  it("enforces the frame-count cap before spawning", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    const many = Array.from({ length: 5 }, (_, i) => ({ absPath: join(FRAME_DIR, `critique_frame_0000${i}.jpg`), atSeconds: i }));
    await expect(critiqueWithClaude(base({ runner: fn, frames: many, config: { maxFrames: 3 } }))).rejects.toThrow(/exceeds the cap/);
    expect(calls).toHaveLength(0);
  });

  it("enforces the prompt byte cap before spawning", async () => {
    const { fn, calls } = capturingRunner({ stdout: envelope(JSON.stringify(goodModel)) });
    await expect(critiqueWithClaude(base({ runner: fn, config: { maxPromptBytes: 10 } }))).rejects.toThrow(/over the .*-byte cap/);
    expect(calls).toHaveLength(0);
  });

  it("rejects non-JSON model output", async () => {
    const { fn } = capturingRunner({ stdout: envelope("not json at all") });
    await expect(critiqueWithClaude(base({ runner: fn }))).rejects.toThrow(/did not return a JSON object/);
  });

  it("rejects an evidence frame the provider was not given", async () => {
    const invented = {
      ...goodModel,
      notes: [{ ...goodModel.notes[0], evidenceFrame: { path: "critique_frame_99999.jpg", atSeconds: 2 } }],
    };
    const { fn } = capturingRunner({ stdout: envelope(JSON.stringify(invented)) });
    await expect(critiqueWithClaude(base({ runner: fn }))).rejects.toThrow(/was not supplied/);
  });

  it("rejects an evidence frame whose time does not match the supplied frame", async () => {
    const mismatched = {
      ...goodModel,
      notes: [{ ...goodModel.notes[0], evidenceFrame: { path: "critique_frame_00002.jpg", atSeconds: 5 } }],
    };
    const { fn } = capturingRunner({ stdout: envelope(JSON.stringify(mismatched)) });
    await expect(critiqueWithClaude(base({ runner: fn }))).rejects.toThrow(/does not match/);
  });

  it("rejects schema-invalid model output (note past the master duration)", async () => {
    const bad = { ...goodModel, notes: [{ ...goodModel.notes[0], atSeconds: 500, evidenceFrame: undefined }] };
    const { fn } = capturingRunner({ stdout: envelope(JSON.stringify(bad)) });
    await expect(critiqueWithClaude(base({ runner: fn }))).rejects.toThrow(/validation|duration/);
  });

  it("throws on spawn error, timeout, truncation, and nonzero exit", async () => {
    await expect(critiqueWithClaude(base({ runner: capturingRunner({ code: null, spawnError: "ENOENT" }).fn }))).rejects.toThrow(/Could not start/);
    await expect(critiqueWithClaude(base({ runner: capturingRunner({ code: null, timedOut: true }).fn }))).rejects.toThrow(/timed out/);
    await expect(critiqueWithClaude(base({ runner: capturingRunner({ code: 0, stdout: envelope(JSON.stringify(goodModel)), truncated: true }).fn }))).rejects.toThrow(/exceeded/);
    await expect(critiqueWithClaude(base({ runner: capturingRunner({ code: 2, stderr: "claude blew up" }).fn }))).rejects.toThrow(/claude blew up/);
  });
});
