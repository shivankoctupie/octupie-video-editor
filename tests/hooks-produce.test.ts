import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createPolicy } from "../src/permissions/policy.js";
import { parseEditPlan } from "../src/schema/editPlan.js";
import {
  assembleVariantSet,
  buildHookText,
  changesOutsideOpening,
  deterministicHookVariants,
  findInventedMedia,
  hashPlan,
  produceHookVariants,
  resolveVariantPlan,
  selectHookScene,
} from "../src/hooks/produce.js";
import type { HookVariantRequestValue, ModelHookVariantValue } from "../src/hooks/schemas.js";
import { basePlan, FIXED_NOW } from "./hooks-fixtures.js";

function request(over: Partial<HookVariantRequestValue> = {}): HookVariantRequestValue {
  return { objective: "grow a youtube channel", count: 4, sourcePlan: basePlan(), ...over };
}

describe("deterministic producer", () => {
  it("normalizes common instruction-style objectives into natural hook topics", () => {
    expect(buildHookText("direct-question", "explain why founder distribution matters")).toBe("What matters most about founder distribution?");
  });

  it("produces exactly the requested count, all distinct", async () => {
    const res = await produceHookVariants({ request: request({ count: 5 }), providerId: "deterministic", now: FIXED_NOW });
    expect(res.set.variants).toHaveLength(5);
    expect(res.set.count).toBe(5);
    expect(new Set(res.set.variants.map((v) => v.id)).size).toBe(5);
    expect(new Set(res.set.variants.map((v) => v.strategy)).size).toBe(5);
    expect(new Set(res.set.variants.map((v) => v.hookText)).size).toBe(5);
    expect(new Set(res.set.variants.map((v) => v.planHash)).size).toBe(5);
  });

  it("stamps engine identity the provider cannot forge", async () => {
    const res = await produceHookVariants({ request: request(), providerId: "deterministic", now: FIXED_NOW });
    expect(res.set.generatedAt).toBe(FIXED_NOW.toISOString());
    expect(res.set.provider.id).toBe("deterministic");
    expect(res.set.sourcePlan.hash).toBe(hashPlan(basePlan()));
    expect(res.set.sourcePlan.identity).toBe("octupie-edit-plan/v1");
    expect(res.set.count).toBe(4);
    expect(res.set.variants.map((v) => v.id)).toEqual(["hook-01", "hook-02", "hook-03", "hook-04"]);
  });

  it("is deterministically repeatable for the same request and clock", async () => {
    const a = await produceHookVariants({ request: request(), providerId: "deterministic", now: FIXED_NOW });
    const b = await produceHookVariants({ request: request(), providerId: "deterministic", now: FIXED_NOW });
    expect(JSON.stringify(a.set)).toBe(JSON.stringify(b.set));
  });

  it("every resolved plan validates against the edit-plan schema", async () => {
    const res = await produceHookVariants({ request: request(), providerId: "deterministic", now: FIXED_NOW });
    for (const v of res.set.variants) {
      const resolved = resolveVariantPlan(v.plan, basePlan());
      expect(resolved.ok).toBe(true);
      expect(parseEditPlan(resolved.plan).ok).toBe(true);
    }
  });

  it("changes only the opening: body scenes, media, and audio are unchanged", async () => {
    const source = basePlan();
    const res = await produceHookVariants({ request: request(), providerId: "deterministic", now: FIXED_NOW });
    for (const v of res.set.variants) {
      const resolved = resolveVariantPlan(v.plan, source).plan!;
      expect(changesOutsideOpening(source, resolved, "hook")).toEqual([]);
      // The opening heading actually changed.
      expect(resolved.scenes[0]!.heading).toBe(v.hookText);
      // Body scenes and source clips are byte-identical.
      expect(JSON.stringify(resolved.scenes.slice(1))).toBe(JSON.stringify(source.scenes.slice(1)));
      expect(JSON.stringify(resolved.audio)).toBe(JSON.stringify(source.audio));
      expect(JSON.stringify(resolved.sourceClips)).toBe(JSON.stringify(source.sourceClips));
    }
  });

  it("invents no media", async () => {
    const source = basePlan();
    const res = await produceHookVariants({ request: request(), providerId: "deterministic", now: FIXED_NOW });
    for (const v of res.set.variants) {
      const resolved = resolveVariantPlan(v.plan, source).plan!;
      expect(findInventedMedia(resolved, source)).toEqual([]);
    }
  });

  it("keeps all ten strategies distinct even with a one-word cap", async () => {
    const res = await produceHookVariants({
      request: request({ count: 10, style: { maxWords: 1 } }),
      providerId: "deterministic",
      now: FIXED_NOW,
    });
    expect(res.set.variants).toHaveLength(10);
    expect(new Set(res.set.variants.map((v) => v.hookText)).size).toBe(10);
  });

  it("respects a maxWords style cap on the opening text", async () => {
    const res = await produceHookVariants({
      request: request({ count: 3, style: { maxWords: 3 } }),
      providerId: "deterministic",
      now: FIXED_NOW,
    });
    for (const v of res.set.variants) {
      expect(v.hookText.trim().split(/\s+/).length).toBeLessThanOrEqual(3);
    }
    expect(new Set(res.set.variants.map((v) => v.hookText)).size).toBe(3);
  });
});

describe("engine assembly guards", () => {
  it("fails rather than return fewer than requested", () => {
    const req = request({ count: 3 });
    const two = deterministicHookVariants(req).slice(0, 2);
    expect(() => assembleVariantSet({ request: req, modelVariants: two, providerId: "deterministic", providerModel: "m", now: FIXED_NOW })).toThrow(/exactly 3/);
  });

  it("rejects a provider label that does not match the rendered opening", () => {
    const req = request({ count: 1 });
    const variant = deterministicHookVariants(req)[0]!;
    const mislabeled = { ...variant, hookText: "A clean but forged manifest label" };
    expect(() => assembleVariantSet({ request: req, modelVariants: [mislabeled], providerId: "claude", providerModel: "m", now: FIXED_NOW })).toThrow(/does not match any rendered opening/);
  });

  it("rejects a duplicate variant from a provider", () => {
    const req = request({ count: 2 });
    const one = deterministicHookVariants(req)[0]!;
    expect(() => assembleVariantSet({ request: req, modelVariants: [one, { ...one }], providerId: "claude", providerModel: "m", now: FIXED_NOW })).toThrow(/repeats/);
  });

  it("rejects an invented-media plan", () => {
    const source = basePlan();
    const req = request({ count: 1 });
    const bad = structuredClone(source);
    bad.scenes[0]!.broll = "broll/does-not-exist.mp4";
    const mv: ModelHookVariantValue = {
      strategy: "bold-claim",
      style: "confident",
      hookText: "New opening",
      rationale: "r",
      confidence: 0.5,
      plan: { kind: "complete", plan: bad },
    };
    expect(() => assembleVariantSet({ request: req, modelVariants: [mv], providerId: "claude", providerModel: "m", now: FIXED_NOW })).toThrow(/media not present/);
  });

  it("rejects a body change when body changes are not permitted", () => {
    const source = basePlan();
    const req = request({ count: 1 });
    const bad = structuredClone(source);
    bad.scenes[1]!.body = "TAMPERED body text";
    const mv: ModelHookVariantValue = {
      strategy: "bold-claim",
      style: "confident",
      hookText: "New opening",
      rationale: "r",
      confidence: 0.5,
      plan: { kind: "complete", plan: bad },
    };
    expect(() => assembleVariantSet({ request: req, modelVariants: [mv], providerId: "claude", providerModel: "m", now: FIXED_NOW })).toThrow(/outside the opening/);
  });

  it("rejects source-range or audio changes even when body changes are explicitly allowed", () => {
    const source = basePlan();
    const req = request({ count: 1, style: { allowBodyChanges: true } });
    const makeVariant = (plan: typeof source): ModelHookVariantValue => ({
      strategy: "bold-claim",
      style: "confident",
      hookText: "A distinct safe opening",
      rationale: "r",
      confidence: 0.5,
      plan: { kind: "complete", plan },
    });
    const changedRange = structuredClone(source);
    changedRange.sourceClips[0]!.out = 21;
    expect(() => assembleVariantSet({ request: req, modelVariants: [makeVariant(changedRange)], providerId: "claude", providerModel: "m", now: FIXED_NOW })).toThrow(/source clip declarations or ranges changed/);
    const changedAudio = structuredClone(source);
    changedAudio.audio.targetLufs = -12;
    expect(() => assembleVariantSet({ request: req, modelVariants: [makeVariant(changedAudio)], providerId: "claude", providerModel: "m", now: FIXED_NOW })).toThrow(/audio declarations changed/);
  });

  it("enforces banned phrases and required keywords on every provider result", async () => {
    await expect(produceHookVariants({
      request: request({ count: 1, style: { bannedPhrases: ["what matters"] } }),
      providerId: "deterministic",
      now: FIXED_NOW,
    })).rejects.toThrow(/banned phrase/);
    await expect(produceHookVariants({
      request: request({ count: 1, style: { requiredKeywords: ["unspoken-keyword"] } }),
      providerId: "deterministic",
      now: FIXED_NOW,
    })).rejects.toThrow(/missing required keyword/);
  });

  it("selects the hook scene", () => {
    expect(selectHookScene(basePlan()).scene.id).toBe("hook");
  });
});

describe("output writing (contained, atomic, one plan per variant)", () => {
  it("writes a manifest and one validated plan file per variant, manifest last", async () => {
    const writes: Array<{ path: string; data: string }> = [];
    const dirs: string[] = [];
    const root = resolve("output", "__hook_out__");
    const res = await produceHookVariants({
      request: request({ count: 3 }),
      providerId: "deterministic",
      now: FIXED_NOW,
      outputRoot: root,
      outputDir: resolve(root, "run1"),
      writeFile: (p, d) => writes.push({ path: p, data: d }),
      ensureDir: (d) => dirs.push(d),
      canonicalize: (p) => p,
      isDirectory: () => true,
    });
    // 3 plan files + 1 manifest.
    expect(writes).toHaveLength(4);
    const planWrites = writes.slice(0, 3);
    const manifestWrite = writes[3]!;
    expect(manifestWrite.path.endsWith("manifest.json")).toBe(true); // manifest written LAST
    for (const w of planWrites) {
      expect(w.path.endsWith(".plan.json")).toBe(true);
      expect(parseEditPlan(JSON.parse(w.data)).ok).toBe(true);
    }
    expect(res.planPaths).toHaveLength(3);
    expect(res.manifestPath!.endsWith("manifest.json")).toBe(true);
  });

  it("rejects a canonical output directory that escapes through a symlink or junction", async () => {
    const root = resolve("output", "__hook_out__");
    const writes: string[] = [];
    await expect(produceHookVariants({
      request: request({ count: 2 }),
      providerId: "deterministic",
      now: FIXED_NOW,
      outputRoot: root,
      outputDir: resolve(root, "linked"),
      writeFile: (p) => writes.push(p),
      ensureDir: () => {},
      canonicalize: (p) => p.endsWith("linked") ? resolve("outside") : p,
      isDirectory: () => true,
    })).rejects.toThrow(/canonical.*outside the allowed root/i);
    expect(writes).toEqual([]);
  });

  it("rejects an output directory that escapes the root", async () => {
    const root = resolve("output", "__hook_out__");
    await expect(
      produceHookVariants({
        request: request({ count: 2 }),
        providerId: "deterministic",
        now: FIXED_NOW,
        outputRoot: root,
        outputDir: resolve(root, "..", "escape"),
        writeFile: () => {},
        ensureDir: () => {},
      }),
    ).rejects.toThrow(/outside the allowed root/);
  });
});

describe("permission", () => {
  it("deterministic runs offline with no grant", async () => {
    const res = await produceHookVariants({ request: request(), providerId: "deterministic", permissionPolicy: createPolicy([]), now: FIXED_NOW });
    expect(res.set.variants.length).toBe(4);
  });
});
