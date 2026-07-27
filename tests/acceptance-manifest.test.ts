import { describe, it, expect } from "vitest";
import {
  loadAcceptanceManifest,
  assertNoGreenGates,
  ACCEPTANCE_STATUSES,
} from "../src/capabilities/acceptance.js";
import { CAPABILITIES, CAPABILITY_IDS } from "../src/capabilities/registry.js";

describe("acceptance manifest", () => {
  const manifest = loadAcceptanceManifest();

  it("lists at least one blocking end-to-end gate per capability", () => {
    for (const cap of CAPABILITIES) {
      const gates = manifest.gates.filter((g) => g.capability === cap.id);
      expect(gates.length).toBeGreaterThan(0);
      for (const g of gates) {
        expect(g.kind).toBe("e2e");
        expect(g.blocking).toBe(true);
        expect(g.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("every gate belongs to a real capability", () => {
    for (const g of manifest.gates) expect(CAPABILITY_IDS).toContain(g.capability);
  });

  it("its gate ids exactly match the registry's acceptanceGateIds (both directions)", () => {
    const manifestIds = new Set(manifest.gates.map((g) => g.id));
    const registryIds = new Set(CAPABILITIES.flatMap((c) => c.acceptanceGateIds));
    expect([...manifestIds].sort()).toEqual([...registryIds].sort());
  });

  it("marks every gate pending, never green", () => {
    for (const g of manifest.gates) {
      expect(g.status).toBe("pending");
      expect(ACCEPTANCE_STATUSES).toContain(g.status);
    }
  });

  it("assertNoGreenGates passes because nothing is faked green", () => {
    expect(() => assertNoGreenGates(manifest)).not.toThrow();
  });

  it("assertNoGreenGates throws if a gate is flipped to passed", () => {
    const tampered = {
      ...manifest,
      gates: manifest.gates.map((g, i) => (i === 0 ? { ...g, status: "passed" as const } : g)),
    };
    expect(() => assertNoGreenGates(tampered)).toThrow(/green|passed/i);
  });
});
