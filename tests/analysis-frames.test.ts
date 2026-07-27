import { describe, it, expect } from "vitest";
import {
  buildFrameExtractArgs,
  buildFrameMetricsArgs,
  parseFrameMetrics,
  extractSampledFrames,
  computeFrameMetrics,
  frameMetricsScriptPath,
} from "../src/analysis/frames.js";
import type { ExecFn } from "../src/agent/exec.js";
import type { RunResult } from "../src/ffmpeg/spawn.js";

describe("buildFrameExtractArgs", () => {
  it("samples at the fps derived from the interval into the out dir", () => {
    const args = buildFrameExtractArgs("/src/clip.mov", "/run/frames", 2);
    const joined = args.join(" ").replace(/\\/g, "/");
    expect(joined).toContain("fps=0.5");
    expect(joined).toContain("/run/frames/frame_%05d.jpg");
    expect(args).toContain("/src/clip.mov");
    expect(args).toContain("-y");
  });
});

describe("buildFrameMetricsArgs / script path", () => {
  it("is an array with the bridge script and manifest flag", () => {
    const args = buildFrameMetricsArgs("/repo/python/frame_metrics.py", "/run/frames.json");
    expect(args).toEqual(["/repo/python/frame_metrics.py", "--manifest", "/run/frames.json"]);
    expect(frameMetricsScriptPath().replace(/\\/g, "/")).toMatch(/python\/frame_metrics\.py$/);
  });
});

const goodMetrics = JSON.stringify({
  frames: [
    { atSeconds: 0, blur: 210.5, brightness: 0.52, faceCount: 1, faces: [{ xNorm: 0.4, yNorm: 0.3, wNorm: 0.2, hNorm: 0.3 }] },
    { atSeconds: 2, blur: 30.1, brightness: 0.48, faceCount: 0, faces: [], discontinuity: 0.4 },
  ],
});

describe("parseFrameMetrics", () => {
  it("validates well-formed bridge output", () => {
    const metrics = parseFrameMetrics(goodMetrics);
    expect(metrics).toHaveLength(2);
    expect(metrics[0]!.faceCount).toBe(1);
    expect(metrics[1]!.discontinuity).toBe(0.4);
  });
  it("throws on non-JSON and on invalid metrics", () => {
    expect(() => parseFrameMetrics("nope")).toThrow(/did not return JSON/);
    expect(() => parseFrameMetrics(JSON.stringify({ frames: [{ atSeconds: 0, blur: -1, brightness: 2, faceCount: 0, faces: [] }] }))).toThrow(/validation/);
  });
});

describe("extractSampledFrames", () => {
  it("maps produced files to interval timestamps", async () => {
    const runner = async (): Promise<RunResult> => ({ code: 0, stdout: "", stderr: "" });
    const frames = await extractSampledFrames({
      videoPath: "/src/clip.mov",
      outDir: "/run/frames",
      intervalSeconds: 2,
      frameFiles: ["/run/frames/frame_00001.jpg", "/run/frames/frame_00002.jpg"],
      runner,
    });
    expect(frames.map((f) => f.atSeconds)).toEqual([0, 2]);
  });
  it("throws when ffmpeg extraction fails", async () => {
    const runner = async (): Promise<RunResult> => ({ code: 1, stdout: "", stderr: "decode error" });
    await expect(extractSampledFrames({ videoPath: "/v", outDir: "/o", frameFiles: [], runner })).rejects.toThrow(/Frame extraction failed/);
  });
});

describe("computeFrameMetrics", () => {
  it("writes the manifest, spawns with an argument array, and returns metrics", async () => {
    let written: { path: string; data: string } | undefined;
    const calls: Array<readonly string[]> = [];
    const runner: ExecFn = async (_bin, args) => { calls.push(args); return { code: 0, stdout: goodMetrics, stderr: "", timedOut: false }; };
    const metrics = await computeFrameMetrics({
      frames: [{ path: "/run/frames/frame_00001.jpg", atSeconds: 0 }],
      manifestPath: "/run/frames.json",
      runner,
      writeFile: (p, d) => { written = { path: p, data: d }; },
    });
    expect(written?.path).toBe("/run/frames.json");
    expect(JSON.parse(written!.data)[0].atSeconds).toBe(0);
    expect(Array.isArray(calls[0])).toBe(true);
    expect(calls[0]).toContain("--manifest");
    expect(metrics).toHaveLength(2);
  });
  it("throws on a nonzero bridge exit", async () => {
    const runner: ExecFn = async () => ({ code: 3, stdout: "", stderr: "opencv import failed", timedOut: false });
    await expect(computeFrameMetrics({ frames: [], manifestPath: "/m.json", runner, writeFile: () => {} })).rejects.toThrow(/exited 3/);
  });
});
