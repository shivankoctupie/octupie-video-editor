import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildMasterSampleArgs,
  sampleRenderedMaster,
  CRITIQUE_FRAME_RE,
  type SampleMasterInput,
} from "../src/critique/sampleMaster.js";
import type { ExecFn, ExecResult } from "../src/agent/exec.js";

const ROOT = resolve("output");
const MASTER = resolve(ROOT, "neutral-founder-reel.mp4");
const FRAME_DIR = join(ROOT, "critique-frames");

function capturingRunner(result: Partial<ExecResult> = {}): {
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

function base(over: Partial<SampleMasterInput> = {}): SampleMasterInput {
  return {
    masterPath: MASTER,
    outputRoot: ROOT,
    intervalSeconds: 2,
    realpathPath: (p) => p,
    statFile: () => ({ isFile: true }),
    listFrames: () => ["critique_frame_00001.jpg", "critique_frame_00002.jpg"],
    removeFile: () => {},
    ensureDir: () => {},
    ...over,
  };
}

describe("buildMasterSampleArgs", () => {
  const args = buildMasterSampleArgs(MASTER, FRAME_DIR, 2);
  it("samples at the fps derived from the interval, writes only generated frames, and is an array", () => {
    const joined = args.join(" ").replace(/\\/g, "/");
    expect(Array.isArray(args)).toBe(true);
    expect(joined).toContain("fps=0.5");
    expect(joined).toMatch(/critique-frames\/critique_frame_%05d\.jpg$/);
  });
  it("reads the master as input and passes -y only for the generated frame output", () => {
    const i = args.indexOf("-i");
    expect(args[i + 1]).toBe(MASTER);
    // -y is present but its only output target is the generated frame pattern.
    expect(args).toContain("-y");
    const y = args.indexOf("-y");
    expect(String(args[y + 1])).toContain("critique_frame_%05d.jpg");
  });
  it("exposes the exact generated-frame name matcher", () => {
    expect(CRITIQUE_FRAME_RE.test("critique_frame_00007.jpg")).toBe(true);
    expect(CRITIQUE_FRAME_RE.test("frame_00007.jpg")).toBe(false);
    expect(CRITIQUE_FRAME_RE.test("master.mp4")).toBe(false);
  });
});

describe("sampleRenderedMaster", () => {
  it("creates the default frame directory before canonicalizing and sampling it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ove-critique-sample-"));
    try {
      const master = join(root, "master.mp4");
      writeFileSync(master, "fixture");
      const runner: ExecFn = async (_bin, args) => {
        const output = String(args.at(-1));
        const frame = output.replace("%05d", "00001");
        writeFileSync(frame, Buffer.from([0xff, 0xd8, 0xff]));
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      };
      const res = await sampleRenderedMaster({ masterPath: master, outputRoot: root, runner });
      expect(res.frames).toHaveLength(1);
      expect(res.frameDir).toBe(resolve(root, "critique-frames"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("samples the master into a run directory and pairs frames with interval times", async () => {
    const { fn, calls } = capturingRunner();
    const res = await sampleRenderedMaster(base({ runner: fn }));
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0]!.args)).toBe(true);
    expect(res.frames.map((f) => f.atSeconds)).toEqual([0, 2]);
    expect(res.frames[0]!.absPath).toContain("critique_frame_00001.jpg");
    expect(res.frameDir).toContain("critique-frames");
    expect(res.masterPath).toBe(MASTER);
  });

  it("passes a bounded timeout and output cap to the runner and never uses a shell", async () => {
    let opts: { timeoutMs?: number; maxBuffer?: number } | undefined;
    const fn: ExecFn = async (_b, args, o) => {
      expect(Array.isArray(args)).toBe(true);
      opts = o as typeof opts;
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    await sampleRenderedMaster(base({ runner: fn, timeoutMs: 4321, maxOutputBytes: 8765 }));
    expect(opts).toMatchObject({ timeoutMs: 4321, maxBuffer: 8765 });
  });

  it("rejects a master path outside the output root before spawning", async () => {
    const { fn, calls } = capturingRunner();
    await expect(
      sampleRenderedMaster(base({ runner: fn, masterPath: resolve(ROOT, "..", "secret.mp4") })),
    ).rejects.toThrow(/outside the allowed root/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a master symlink whose real target escapes the output root before spawning", async () => {
    const { fn, calls } = capturingRunner();
    await expect(
      sampleRenderedMaster(base({
        runner: fn,
        realpathPath: (p) => (p.endsWith("neutral-founder-reel.mp4") ? resolve(ROOT, "..", "secret.mp4") : p),
      })),
    ).rejects.toThrow(/real master.*outside the allowed root/);
    expect(calls).toHaveLength(0);
  });

  it("requires the master to be a regular file before spawning", async () => {
    const { fn, calls } = capturingRunner();
    await expect(
      sampleRenderedMaster(base({ runner: fn, statFile: () => ({ isFile: false }) })),
    ).rejects.toThrow(/regular file/);
    expect(calls).toHaveLength(0);
  });

  it("never samples into the master's own directory (cannot overwrite the master)", async () => {
    const { fn, calls } = capturingRunner();
    await expect(
      sampleRenderedMaster(base({ runner: fn, frameDir: ROOT })),
    ).rejects.toThrow(/separate from the master/);
    expect(calls).toHaveLength(0);
  });

  it("cleans only exact generated frame names, never foreign files", async () => {
    const removed: string[] = [];
    const { fn } = capturingRunner();
    await sampleRenderedMaster(base({
      runner: fn,
      listFrames: () => ["critique_frame_00001.jpg", "critique_frame_00002.jpg", "keep.json", "neutral.mp4"],
      removeFile: (p) => removed.push(p),
    }));
    expect(removed.every((p) => CRITIQUE_FRAME_RE.test(p.split(/[\\/]/).pop()!))).toBe(true);
    expect(removed.some((p) => p.includes("keep.json"))).toBe(false);
    expect(removed.some((p) => p.includes("neutral.mp4"))).toBe(false);
    expect(removed).toHaveLength(2);
  });

  it("throws on a nonzero ffmpeg exit", async () => {
    const { fn } = capturingRunner({ code: 1, stderr: "decode error" });
    await expect(sampleRenderedMaster(base({ runner: fn }))).rejects.toThrow(/sampling failed/i);
  });

  it("throws on a spawn error", async () => {
    const { fn } = capturingRunner({ code: null, spawnError: "ENOENT" });
    await expect(sampleRenderedMaster(base({ runner: fn }))).rejects.toThrow(/Could not start/);
  });

  it("throws on timeout", async () => {
    const { fn } = capturingRunner({ code: null, timedOut: true });
    await expect(sampleRenderedMaster(base({ runner: fn }))).rejects.toThrow(/timed out/);
  });

  it("throws when output was truncated at the cap", async () => {
    const { fn } = capturingRunner({ code: 0, truncated: true });
    await expect(sampleRenderedMaster(base({ runner: fn }))).rejects.toThrow(/exceeded/);
  });

  it("throws when no frames were produced", async () => {
    const { fn } = capturingRunner();
    await expect(sampleRenderedMaster(base({ runner: fn, listFrames: () => [] }))).rejects.toThrow(/No sampled frames/);
  });

  it("caps the frame set to maxFrames, preserving the endpoints", async () => {
    const many = Array.from({ length: 10 }, (_, i) => `critique_frame_${String(i + 1).padStart(5, "0")}.jpg`);
    const { fn } = capturingRunner();
    const res = await sampleRenderedMaster(base({ runner: fn, listFrames: () => many, maxFrames: 4 }));
    expect(res.frames).toHaveLength(4);
    expect(res.frames[0]!.atSeconds).toBe(0);
    expect(res.frames[3]!.absPath).toContain("critique_frame_00010.jpg");
  });
});
