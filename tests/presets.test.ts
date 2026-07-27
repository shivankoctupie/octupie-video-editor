import { describe, it, expect } from "vitest";
import { listPresets, getPreset, PRESETS } from "../src/presets/index.js";
import { makeStarterPlan } from "../src/presets/starter.js";
import { parseEditPlan } from "../src/schema/editPlan.js";

describe("presets", () => {
  it("ships the four required presets", () => {
    const ids = Object.keys(PRESETS).sort();
    expect(ids).toEqual(
      ["linkedin-landscape-reel", "neutral-founder-reel", "octupie-product-launch", "yc-series-vertical"].sort(),
    );
  });

  it("encodes the Octupie brand system on the product launch preset", () => {
    const p = getPreset("octupie-product-launch");
    expect(p.brand).toMatchObject({ font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" });
  });

  it("keeps the two required composition formats", () => {
    const comps = new Set(listPresets().map((p) => p.composition));
    expect(comps.has("PremiumProductFilm")).toBe(true);
    expect(comps.has("FounderSocialReel")).toBe(true);
  });

  it("every preset produces a schema-valid starter plan", () => {
    for (const preset of listPresets()) {
      const plan = makeStarterPlan(preset);
      const parsed = parseEditPlan(plan);
      expect(parsed.ok, `${preset.id}: ${parsed.errors.join("; ")}`).toBe(true);
    }
  });

  it("YC preset never lets proof cover the speaker and adds no auto SFX", () => {
    const p = getPreset("yc-series-vertical");
    expect(p.proofCard.coversSpeaker).toBe(false);
    expect(p.audio.musicByDefault).toBe(false);
  });
});
