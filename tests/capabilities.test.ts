import { describe, it, expect } from "vitest";
import {
  CAPABILITY_IDS,
  CAPABILITIES,
  CAPABILITY_STATUSES,
  diagnoseCapabilities,
  getCapability,
  type CapabilityProbe,
} from "../src/capabilities/registry.js";
import { PERMISSION_ACTIONS } from "../src/permissions/policy.js";

describe("capability registry shape", () => {
  it("declares exactly the eight requested parity areas", () => {
    expect(CAPABILITY_IDS).toHaveLength(8);
    expect([...CAPABILITY_IDS].sort()).toEqual(
      [
        "asset-discovery",
        "draft-critique-revision",
        "hermes-integration",
        "hook-variant-production",
        "improvement-proposals",
        "review-publishing",
        "semantic-video-understanding",
        "transcription-analysis",
      ].sort(),
    );
  });

  it("gives every capability a contract name, a summary and at least one acceptance gate", () => {
    for (const c of CAPABILITIES) {
      expect(c.contract.length).toBeGreaterThan(0);
      expect(c.summary.length).toBeGreaterThan(0);
      expect(c.acceptanceGateIds.length).toBeGreaterThan(0);
    }
  });

  it("references only known permission actions in requiresPermissions", () => {
    const known = new Set<string>(PERMISSION_ACTIONS);
    for (const c of CAPABILITIES) {
      for (const p of c.requiresPermissions) expect(known.has(p)).toBe(true);
    }
  });
});

describe("truthful default diagnosis", () => {
  it("reports every capability as unavailable when nothing is implemented", async () => {
    const diags = await diagnoseCapabilities();
    expect(diags).toHaveLength(8);
    for (const d of diags) {
      expect(CAPABILITY_STATUSES).toContain(d.status);
      expect(d.status).toBe("unavailable");
      expect(d.claimed).toBe(false);
    }
  });

  it("never invents a capability that is not in the registry", async () => {
    const diags = await diagnoseCapabilities();
    for (const d of diags) expect(CAPABILITY_IDS).toContain(d.id);
  });
});

describe("verified status requires acceptance-gate evidence", () => {
  it("downgrades an unproven 'verified' probe to 'configured' and flags the overclaim", async () => {
    const lying: Record<string, CapabilityProbe> = {
      "transcription-analysis": async () => ({ status: "verified", detail: "trust me" }),
    };
    const diags = await diagnoseCapabilities({ probes: lying });
    const d = diags.find((x) => x.id === "transcription-analysis")!;
    expect(d.status).toBe("configured");
    expect(d.detail).toMatch(/no acceptance gate/i);
  });

  it("downgrades a probe that cites a known but still-pending gate", async () => {
    const cap = getCapability("transcription-analysis");
    const gate = cap.acceptanceGateIds[0]!;
    const unproven: Record<string, CapabilityProbe> = {
      "transcription-analysis": async () => ({ status: "verified", detail: "trust me", verifiedByGateId: gate }),
    };
    const diags = await diagnoseCapabilities({ probes: unproven });
    const d = diags.find((x) => x.id === "transcription-analysis")!;
    expect(d.status).toBe("configured");
    expect(d.detail).toMatch(/has not passed/i);
  });

  it("keeps 'verified' only when the cited gate has executable pass evidence", async () => {
    const cap = getCapability("transcription-analysis");
    const gate = cap.acceptanceGateIds[0]!;
    const honest: Record<string, CapabilityProbe> = {
      "transcription-analysis": async () => ({ status: "verified", detail: "gate passed", verifiedByGateId: gate }),
    };
    const diags = await diagnoseCapabilities({ probes: honest, passedGateIds: [gate] });
    const d = diags.find((x) => x.id === "transcription-analysis")!;
    expect(d.status).toBe("verified");
  });

  it("rejects a 'verified' probe that cites a gate belonging to another capability", async () => {
    const other = getCapability("review-publishing").acceptanceGateIds[0]!;
    const cross: Record<string, CapabilityProbe> = {
      "transcription-analysis": async () => ({ status: "verified", detail: "x", verifiedByGateId: other }),
    };
    const diags = await diagnoseCapabilities({ probes: cross });
    expect(diags.find((x) => x.id === "transcription-analysis")!.status).toBe("configured");
  });
});
