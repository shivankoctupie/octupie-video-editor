import { describe, expect, it } from "vitest";
import { buildCapabilityProbes, hermesIntegrationProbe } from "../src/capabilities/probes.js";
import { skippedOrchestration, standaloneOrchestrate } from "../src/hermes/standalone.js";
import { NOW } from "./hermes-fixtures.js";

describe("Hermes standalone preservation and probe", () => {
  it("returns deterministic offline data without any fetch dependency", () => {
    const result = standaloneOrchestrate({ request: { objective: "Review draft", workflowStage: "qa" }, now: NOW });
    expect(result.mode).toBe("standalone");
    expect(result.usedNetwork).toBe(false);
    expect(result.standalonePreserved).toBe(true);
    expect(result.data.requiresHumanApproval).toBe(true);
  });

  it("supports an explicit offline skipped result", () => {
    expect(skippedOrchestration("Hermes not configured", NOW)).toMatchObject({ mode: "skipped", usedNetwork: false, standalonePreserved: true });
  });

  it("reports unavailable without config and configured without overclaiming verification", async () => {
    expect((await hermesIntegrationProbe()()).status).toBe("unavailable");
    const configured = await hermesIntegrationProbe({ endpoint: "http://127.0.0.1:8642", tokenPresent: true })();
    expect(configured.status).toBe("configured");
    expect(configured.verifiedByGateId).toBeUndefined();
  });

  it("registers the Hermes probe", async () => {
    const probes = buildCapabilityProbes({ hermesEndpoint: "http://127.0.0.1:8642", hermesTokenPresent: true });
    expect(await probes["hermes-integration"]!()).toMatchObject({ status: "configured" });
  });
});
