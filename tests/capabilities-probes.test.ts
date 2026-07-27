import { describe, it, expect, beforeEach } from "vitest";
import { transcriptionAnalysisProbe, semanticVideoUnderstandingProbe, buildCapabilityProbes } from "../src/capabilities/probes.js";
import { diagnoseCapabilities } from "../src/capabilities/registry.js";
import { runAgentCli, type AgentCliDeps } from "../src/agent/cli.js";
import type { ExecFn, ExecResult } from "../src/agent/exec.js";

const runnerReturning = (r: Partial<ExecResult>): ExecFn => async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...r });

describe("transcriptionAnalysisProbe", () => {
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

describe("semanticVideoUnderstandingProbe", () => {
  it("is always unavailable", async () => {
    const res = await semanticVideoUnderstandingProbe()();
    expect(res.status).toBe("unavailable");
  });
});

describe("diagnoseCapabilities with real probes", () => {
  it("marks transcription-analysis configured and semantic unavailable, never verified", async () => {
    const probes = buildCapabilityProbes({ runner: runnerReturning({ code: 0 }) });
    const diags = await diagnoseCapabilities({ probes });
    const trans = diags.find((d) => d.id === "transcription-analysis")!;
    const sem = diags.find((d) => d.id === "semantic-video-understanding")!;
    expect(trans.status).toBe("configured");
    expect(sem.status).toBe("unavailable");
    expect(diags.every((d) => d.status !== "verified")).toBe(true);
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
