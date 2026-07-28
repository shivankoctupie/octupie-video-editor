import { describe, expect, it } from "vitest";
import type { ExecFn } from "../src/agent/exec.js";
import { buildCapabilityProbes, hookVariantProductionProbe } from "../src/capabilities/probes.js";

const unavailable: ExecFn = async () => ({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: "missing" });

describe("hookVariantProductionProbe", () => {
  it("reports the deterministic producer as configured but never verified", async () => {
    const result = await hookVariantProductionProbe("missing", unavailable)();
    expect(result.status).toBe("configured");
    expect(result.verifiedByGateId).toBeUndefined();
    expect(result.detail).toMatch(/Deterministic offline/);
  });

  it("is wired into the capability probe map", () => {
    expect(buildCapabilityProbes({ runner: unavailable })["hook-variant-production"]).toBeTypeOf("function");
  });
});
