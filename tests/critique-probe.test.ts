import { describe, it, expect } from "vitest";
import { draftCritiqueRevisionProbe, buildCapabilityProbes } from "../src/capabilities/probes.js";
import { diagnoseCapabilities } from "../src/capabilities/registry.js";
import type { ExecFn, ExecResult } from "../src/agent/exec.js";

const runnerReturning = (r: Partial<ExecResult>): ExecFn => async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...r });

describe("draftCritiqueRevisionProbe", () => {
  it("reports configured when the claude binary responds (never verified)", async () => {
    const res = await draftCritiqueRevisionProbe("claude", runnerReturning({ code: 0 }))();
    expect(res.status).toBe("configured");
    expect(res.verifiedByGateId).toBeUndefined();
  });
  it("reports unavailable when claude cannot be spawned", async () => {
    const res = await draftCritiqueRevisionProbe("claude", runnerReturning({ code: null, spawnError: "ENOENT" }))();
    expect(res.status).toBe("unavailable");
  });
  it("reports unavailable when claude exits nonzero", async () => {
    const res = await draftCritiqueRevisionProbe("claude", runnerReturning({ code: 1 }))();
    expect(res.status).toBe("unavailable");
  });
});

describe("diagnoseCapabilities includes draft-critique-revision", () => {
  it("marks it configured under a code-0 runner but never verified", async () => {
    const probes = buildCapabilityProbes({ runner: runnerReturning({ code: 0 }) });
    const diags = await diagnoseCapabilities({ probes });
    const dc = diags.find((d) => d.id === "draft-critique-revision")!;
    expect(dc.status).toBe("configured");
    expect(dc.claimed).toBe(true);
    expect(diags.every((d) => d.status !== "verified")).toBe(true);
  });

  it("keeps it unavailable when the provider cannot be spawned", async () => {
    const probes = buildCapabilityProbes({ runner: runnerReturning({ code: null, spawnError: "ENOENT" }) });
    const diags = await diagnoseCapabilities({ probes });
    expect(diags.find((d) => d.id === "draft-critique-revision")!.status).toBe("unavailable");
  });
});
