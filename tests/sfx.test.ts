import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { validateCues } from "../src/sfx/gates.js";
import { validateCueSheetFile } from "../src/sfx/validator.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("SFX gate engine", () => {
  it("blacklists impact_ultra_serious_48k_pcm24.wav and renamed derivatives", () => {
    const direct = validateCues([
      { time: 5, asset: "impact_ultra_serious_48k_pcm24.wav", family: "impact", intensity: "hero", role: "x" },
    ]);
    expect(direct.errors.some((e) => e.includes("blacklisted"))).toBe(true);

    const renamed = validateCues([
      { time: 5, asset: "impact_ultra_serious_v2_pitched.wav", family: "impact", intensity: "hero", role: "x" },
    ]);
    expect(renamed.errors.some((e) => e.includes("blacklisted"))).toBe(true);
  });

  it("rejects the default whoosh + riser + impact stack near one time", () => {
    const result = validateCues([
      { time: 10.0, asset: "whoosh.wav", family: "whoosh", intensity: "support", role: "a" },
      { time: 10.03, asset: "riser.wav", family: "riser", intensity: "hero", role: "b" },
      { time: 10.05, asset: "impact.wav", family: "impact", intensity: "hero", role: "c" },
    ]);
    expect(result.errors.some((e) => e.includes("trailer stack"))).toBe(true);
  });

  it("rejects unknown families and invalid intensities", () => {
    const result = validateCues([
      { time: 1, asset: "x.wav", family: "explosion", intensity: "massive", role: "r" },
    ]);
    expect(result.errors.some((e) => e.includes("unknown family"))).toBe(true);
    expect(result.errors.some((e) => e.includes("invalid intensity"))).toBe(true);
  });

  it("warns on repeated waveforms, dense stacks, missing roles, and close hero cues", () => {
    const result = validateCues([
      { time: 1.0, asset: "same.wav", family: "foley", intensity: "support", role: "one" },
      { time: 2.0, asset: "same.wav", family: "foley", intensity: "support", role: "two" },
      { time: 4.0, asset: "noRole.wav", family: "ui", intensity: "support" },
      { time: 5.0, asset: "h1.wav", family: "impact", intensity: "hero", role: "h" },
      { time: 6.0, asset: "h2.wav", family: "impact", intensity: "hero", role: "h" },
    ]);
    expect(result.warnings.some((w) => w.includes("repeated waveform"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("no distinct editorial role"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("hero cues only"))).toBe(true);
  });

  it("passes a clean, spaced, single-layer cue plan", () => {
    const result = validateCues([
      { time: 1.25, asset: "air_whoosh.wav", family: "whoosh", intensity: "texture", role: "card move" },
      { time: 4.8, asset: "light_lock.wav", family: "impact", intensity: "support", role: "settle" },
    ]);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects the preserved ~33s regression fixture", () => {
    const fixture = resolve(here, "fixtures/rejected-33s-stack.json");
    const result = validateCueSheetFile(fixture);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("blacklisted"))).toBe(true);
    expect(result.errors.some((e) => e.includes("trailer stack"))).toBe(true);
  });
});
