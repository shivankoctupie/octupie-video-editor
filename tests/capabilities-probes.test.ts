import { describe, it, expect, beforeEach } from "vitest";
import {
  transcriptionAnalysisProbe,
  semanticVideoUnderstandingProbe,
  semanticVisionProbe,
  diarizationProbe,
  buildCapabilityProbes,
} from "../src/capabilities/probes.js";
import { diagnoseCapabilities } from "../src/capabilities/registry.js";
import { runAgentCli, type AgentCliDeps } from "../src/agent/cli.js";
import type { ExecFn, ExecResult } from "../src/agent/exec.js";

const runnerReturning = (r: Partial<ExecResult>): ExecFn => async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...r });

describe("transcriptionAnalysisProbe", () => {
  it("uses lightweight module discovery instead of importing the heavy runtime", async () => {
    let args: readonly string[] = [];
    const runner: ExecFn = async (_bin, seen) => {
      args = seen;
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    await transcriptionAnalysisProbe("python", runner)();
    expect(args.join(" ")).toContain("find_spec");
    expect(args.join(" ")).not.toMatch(/import faster_whisper/);
  });

  it("reports configured when faster_whisper imports (never verified)", async () => {
    const res = await transcriptionAnalysisProbe("python", runnerReturning({ code: 0 }))();
    expect(res.status).toBe("configured");
    expect(res.verifiedByGateId).toBeUndefined();
  });
  it("reports unavailable when the import fails", async () => {
    const res = await transcriptionAnalysisProbe("python", runnerReturning({ code: 1, stderr: "no module" }))();
    expect(res.status).toBe("unavailable");
  });
  it("reports unavailable when python cannot be spawned", async () => {
    const res = await transcriptionAnalysisProbe("python", runnerReturning({ code: null, spawnError: "ENOENT" }))();
    expect(res.status).toBe("unavailable");
  });
});

describe("semanticVideoUnderstandingProbe (offline default)", () => {
  it("is always unavailable", async () => {
    const res = await semanticVideoUnderstandingProbe()();
    expect(res.status).toBe("unavailable");
  });
});

describe("semanticVisionProbe (restricted Claude vision)", () => {
  it("reports configured when the claude binary responds (never verified)", async () => {
    const res = await semanticVisionProbe("claude", runnerReturning({ code: 0 }))();
    expect(res.status).toBe("configured");
    expect(res.verifiedByGateId).toBeUndefined();
  });
  it("reports unavailable when claude cannot be spawned", async () => {
    const res = await semanticVisionProbe("claude", runnerReturning({ code: null, spawnError: "ENOENT" }))();
    expect(res.status).toBe("unavailable");
  });
  it("reports unavailable when claude exits nonzero", async () => {
    const res = await semanticVisionProbe("claude", runnerReturning({ code: 1 }))();
    expect(res.status).toBe("unavailable");
  });
});

describe("diarizationProbe (optional pyannote)", () => {
  it("uses parent-safe module discovery instead of importing the heavy runtime", async () => {
    let args: readonly string[] = [];
    const runner: ExecFn = async (_bin, seen) => {
      args = seen;
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    await diarizationProbe("python", runner)();
    expect(args.join(" ")).toContain("find_spec");
    expect(args.join(" ")).not.toMatch(/import pyannote\.audio/);
  });

  it("reports configured when pyannote.audio imports (never verified)", async () => {
    const res = await diarizationProbe("python", runnerReturning({ code: 0 }))();
    expect(res.status).toBe("configured");
    expect(res.detail).toMatch(/two-speaker/);
  });
  it("reports unavailable when the import fails", async () => {
    const res = await diarizationProbe("python", runnerReturning({ code: 1 }))();
    expect(res.status).toBe("unavailable");
  });
});

describe("diagnoseCapabilities with real probes", () => {
  it("marks transcription-analysis and semantic-video-understanding configured, never verified", async () => {
    const probes = buildCapabilityProbes({ runner: runnerReturning({ code: 0 }) });
    const diags = await diagnoseCapabilities({ probes });
    const trans = diags.find((d) => d.id === "transcription-analysis")!;
    const sem = diags.find((d) => d.id === "semantic-video-understanding")!;
    expect(trans.status).toBe("configured");
    // The restricted vision provider is available under a code-0 runner, so the
    // capability is configured but stays short of verified without a passed gate.
    expect(sem.status).toBe("configured");
    expect(diags.every((d) => d.status !== "verified")).toBe(true);
  });

  it("keeps semantic unavailable when the vision provider cannot be spawned", async () => {
    const probes = buildCapabilityProbes({ runner: runnerReturning({ code: null, spawnError: "ENOENT" }) });
    const diags = await diagnoseCapabilities({ probes });
    const sem = diags.find((d) => d.id === "semantic-video-understanding")!;
    expect(sem.status).toBe("unavailable");
  });
});

describe("agent capabilities --probe", () => {
  let out: string[];
  let err: string[];
  beforeEach(() => { out = []; err = []; });
  const deps = (): AgentCliDeps => ({
    log: (s) => out.push(s),
    errorLog: (s) => err.push(s),
    capabilityProbes: buildCapabilityProbes({ runner: runnerReturning({ code: 0 }) }),
  });

  it("shows transcription-analysis configured with --probe but the gate ledger stays 0 green", async () => {
    const code = await runAgentCli(["capabilities", "--probe", "--json"], deps());
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    const trans = parsed.capabilities.find((c: { id: string }) => c.id === "transcription-analysis");
    expect(trans.status).toBe("configured");
    expect(parsed.acceptance.green).toBe(0);
    expect(parsed.capabilities.every((c: { status: string }) => c.status !== "verified")).toBe(true);
  });

  it("without --probe every capability stays unavailable (unchanged default)", async () => {
    const code = await runAgentCli(["capabilities", "--json"], deps());
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.capabilities.every((c: { status: string }) => c.status === "unavailable")).toBe(true);
  });
});
