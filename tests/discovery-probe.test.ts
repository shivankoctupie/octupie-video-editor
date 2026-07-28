import { describe, expect, it } from "vitest";
import { assetDiscoveryProbe, buildCapabilityProbes } from "../src/capabilities/probes.js";

describe("assetDiscoveryProbe", () => {
  it("reports configured for a usable real local provider without claiming verification", async () => {
    const result = await assetDiscoveryProbe("assets", { dirExists: () => true })();
    expect(result.status).toBe("configured");
    expect(result.verifiedByGateId).toBeUndefined();
    expect(result.detail).toMatch(/local asset root/);
  });

  it("reports configured only when an explicit remote adapter is present", async () => {
    expect((await assetDiscoveryProbe("missing", { dirExists: () => false, driveConfigured: true })()).status).toBe("configured");
    expect((await assetDiscoveryProbe("missing", { dirExists: () => false })()).status).toBe("unavailable");
  });

  it("is included in the default capability probe map", () => {
    expect(buildCapabilityProbes({ assetRootDir: "assets" })["asset-discovery"]).toBeTypeOf("function");
  });
});
