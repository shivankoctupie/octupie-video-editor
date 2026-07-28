import { describe, expect, it } from "vitest";
import {
  HOOK_STRATEGIES,
  MAX_HOOK_COUNT,
  normalizeHookText,
  parseHookVariantRequest,
  parseHookVariantSet,
  parseModelHookVariantSet,
  selectHookSceneId,
} from "../src/hooks/schemas.js";
import { basePlan, basePlanObject } from "./hooks-fixtures.js";

describe("hook variant request bounds", () => {
  it("accepts a valid bounded request", () => {
    const r = parseHookVariantRequest({ objective: "grow on youtube", count: 3, sourcePlan: basePlanObject() });
    expect(r.ok).toBe(true);
    expect(r.data!.count).toBe(3);
  });

  it("hard-bounds count to 1..10", () => {
    expect(parseHookVariantRequest({ objective: "x", count: 0, sourcePlan: basePlanObject() }).ok).toBe(false);
    expect(parseHookVariantRequest({ objective: "x", count: 11, sourcePlan: basePlanObject() }).ok).toBe(false);
    expect(parseHookVariantRequest({ objective: "x", count: 2.5, sourcePlan: basePlanObject() }).ok).toBe(false);
    expect(parseHookVariantRequest({ objective: "x", count: MAX_HOOK_COUNT, sourcePlan: basePlanObject() }).ok).toBe(true);
  });

  it("rejects an empty objective and an unknown field", () => {
    expect(parseHookVariantRequest({ objective: "", count: 2, sourcePlan: basePlanObject() }).ok).toBe(false);
    expect(parseHookVariantRequest({ objective: "x", count: 2, sourcePlan: basePlanObject(), extra: true }).ok).toBe(false);
  });

  it("rejects an invalid embedded source plan", () => {
    const bad = { ...basePlanObject(), duration: -5 };
    expect(parseHookVariantRequest({ objective: "x", count: 2, sourcePlan: bad }).ok).toBe(false);
  });
});

describe("model variant schema (interpretation only)", () => {
  it("rejects a variant that tries to carry an engine identity field", () => {
    const r = parseModelHookVariantSet({
      variants: [
        {
          strategy: "bold-claim",
          style: "confident",
          hookText: "Most people get x wrong.",
          rationale: "because",
          confidence: 0.5,
          plan: { kind: "fragment", fragment: { hookSceneId: "hook", heading: "Most people get x wrong." } },
          id: "hook-01", // not allowed on model output; the engine stamps ids
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a well-formed fragment carrier", () => {
    const r = parseModelHookVariantSet({
      variants: [
        {
          strategy: "bold-claim",
          style: "confident",
          hookText: "Most people get x wrong.",
          rationale: "because",
          confidence: 0.5,
          plan: { kind: "fragment", fragment: { hookSceneId: "hook", heading: "Most people get x wrong." } },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

describe("hook variant set uniqueness and count", () => {
  const sourceHash = "a".repeat(64);
  function variant(over: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "hook-01",
      strategy: "bold-claim",
      style: "confident",
      hookText: "Most people get x wrong.",
      rationale: "because",
      confidence: 0.5,
      plan: { kind: "fragment", fragment: { hookSceneId: "hook", heading: "h" } },
      planHash: "b".repeat(64),
      ...over,
    };
  }
  function set(variants: Record<string, unknown>[], count: number): Record<string, unknown> {
    return {
      format: "octupie-hook-variant-set/v1",
      objective: "x",
      count,
      generatedAt: "2026-07-28T00:00:00.000Z",
      provider: { id: "deterministic", model: "deterministic-offline" },
      sourcePlan: { title: "Base plan", identity: "octupie-edit-plan/v1", hash: sourceHash },
      variants,
    };
  }

  it("rejects a set whose variant count does not equal count", () => {
    expect(parseHookVariantSet(set([variant({})], 2)).ok).toBe(false);
  });

  it("rejects duplicate ids, strategies, texts, or plan hashes", () => {
    const dupId = set([variant({ planHash: "b".repeat(64) }), variant({ id: "hook-01", strategy: "curiosity-gap", hookText: "y", planHash: "c".repeat(64) })], 2);
    expect(parseHookVariantSet(dupId).ok).toBe(false);

    const dupStrategy = set([variant({ id: "hook-01", planHash: "b".repeat(64) }), variant({ id: "hook-02", hookText: "y", planHash: "c".repeat(64) })], 2);
    expect(parseHookVariantSet(dupStrategy).ok).toBe(false);

    const dupHash = set([variant({ id: "hook-01" }), variant({ id: "hook-02", strategy: "curiosity-gap", hookText: "y" })], 2);
    expect(parseHookVariantSet(dupHash).ok).toBe(false);
  });

  it("accepts two fully-distinct variants", () => {
    const ok = set(
      [
        variant({ id: "hook-01", strategy: "bold-claim", hookText: "one", planHash: "b".repeat(64) }),
        variant({ id: "hook-02", strategy: "curiosity-gap", hookText: "two", planHash: "c".repeat(64) }),
      ],
      2,
    );
    expect(parseHookVariantSet(ok).ok).toBe(true);
  });
});

describe("helpers", () => {
  it("normalizes hook text for comparison", () => {
    expect(normalizeHookText("  Hello   World  ")).toBe("hello world");
  });
  it("has at least MAX_HOOK_COUNT distinct strategies", () => {
    expect(new Set(HOOK_STRATEGIES).size).toBeGreaterThanOrEqual(MAX_HOOK_COUNT);
  });
  it("selects the hook scene id", () => {
    expect(selectHookSceneId(basePlan())).toBe("hook");
  });
});
