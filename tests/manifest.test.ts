import { describe, it, expect } from "vitest";
import { parseManifest, checkManifestRights } from "../src/sfx/manifest.js";

const clean = JSON.stringify({
  purpose: "candidates",
  blacklist: ["impact_ultra_serious_48k_pcm24.wav"],
  records: [
    {
      asset: "air_whoosh.wav",
      source: "Mixkit",
      sourceUrl: "https://mixkit.co/x",
      licenseUrl: "https://mixkit.co/license/",
      license: "Mixkit Free License",
      sha256: "abc",
    },
  ],
});

describe("SFX manifest rights", () => {
  it("accepts a clean, commercially-usable manifest", () => {
    const check = checkManifestRights(parseManifest(clean));
    expect(check.ok).toBe(true);
  });

  it("rejects NonCommercial and NoDerivatives licenses", () => {
    const nc = parseManifest(
      JSON.stringify({
        records: [{ asset: "x.wav", source: "s", sourceUrl: "https://a", licenseUrl: "https://b", license: "CC-BY-NC-4.0" }],
      }),
    );
    expect(checkManifestRights(nc).ok).toBe(false);

    const nd = parseManifest(
      JSON.stringify({
        records: [{ asset: "y.wav", source: "s", sourceUrl: "https://a", licenseUrl: "https://b", license: "CC-BY-ND-4.0" }],
      }),
    );
    expect(checkManifestRights(nd).ok).toBe(false);
  });

  it("rejects a manifest that lists a blacklisted asset", () => {
    const bad = parseManifest(
      JSON.stringify({
        blacklist: ["impact_ultra_serious_48k_pcm24.wav"],
        records: [
          {
            asset: "impact_ultra_serious_48k_pcm24.wav",
            source: "s",
            sourceUrl: "https://a",
            licenseUrl: "https://b",
            license: "CC0-1.0",
          },
        ],
      }),
    );
    expect(checkManifestRights(bad).ok).toBe(false);
  });
});
