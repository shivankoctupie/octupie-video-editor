import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  discoverLocalAssets,
  intentTokens,
  type DiscoveryDirEntry,
  type DiscoveryFs,
  type LocalDiscoveryInput,
} from "../src/discovery/local.js";
import { parseAssetCandidate } from "../src/discovery/schemas.js";

const NOW = new Date("2026-07-28T00:00:00.000Z");
const ROOT = resolve("output", "__vfs_root__");

function dir(...names: Array<[string, Partial<DiscoveryDirEntry>]>): DiscoveryDirEntry[] {
  return names.map(([name, over]) => ({
    name,
    isFile: false,
    isDirectory: false,
    isSymbolicLink: false,
    ...over,
  }));
}

const PERMISSIVE = JSON.stringify({
  licenseId: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  attributionRequired: false,
  rightsStatus: "permissive",
  provenance: "licensed-source",
  title: "City skyline drone",
});
const LOCAL_OWNER = JSON.stringify({
  licenseId: "local-owner",
  attributionRequired: false,
  rightsStatus: "local-owner",
  provenance: "user-supplied",
});
const RESTRICTED = JSON.stringify({
  licenseId: "All-Rights-Reserved",
  attributionRequired: false,
  rightsStatus: "restricted",
  provenance: "licensed-source",
});

/** Build a virtual DiscoveryFs from explicit dir/file/sidecar/symlink maps. */
function vfs(spec: {
  dirs: Record<string, DiscoveryDirEntry[]>;
  files: Set<string>;
  sidecars: Record<string, string>;
  real?: Record<string, string>;
}): DiscoveryFs {
  const real = spec.real ?? {};
  return {
    readDir: (d) => {
      const e = spec.dirs[d];
      if (!e) throw new Error(`ENOENT ${d}`);
      return e;
    },
    realpath: (p) => real[p] ?? p,
    isFile: (p) => spec.files.has(p),
    readSidecar: (p) => spec.sidecars[p] ?? null,
  };
}

function base(over: Partial<LocalDiscoveryInput> = {}): LocalDiscoveryInput {
  return {
    query: { intent: "city skyline", sources: ["local"], maxResults: 20 },
    root: ROOT,
    now: NOW,
    ...over,
  };
}

describe("intentTokens", () => {
  it("splits on non-alphanumerics and lowercases", () => {
    expect(intentTokens("City Skyline, drone-shot!")).toEqual(["city", "skyline", "drone", "shot"]);
  });
});

describe("discoverLocalAssets", () => {
  it("finds a seeded permissive asset and returns a portable relative ref", () => {
    const brollDir = join(ROOT, "broll");
    const city = join(brollDir, "city.mp4");
    const fs = vfs({
      dirs: {
        [ROOT]: dir(["broll", { isDirectory: true }]),
        [brollDir]: dir(["city.mp4", { isFile: true }], ["city.mp4.rights.json", { isFile: true }]),
      },
      files: new Set([city]),
      sidecars: { [city + ".rights.json"]: PERMISSIVE },
    });
    const { candidates, diagnostics } = discoverLocalAssets(base({ fs }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.ref).toBe("broll/city.mp4");
    expect(candidates[0]!.source).toBe("local");
    expect(candidates[0]!.bytesLocal).toBe(true);
    expect(candidates[0]!.rightsStatus).toBe("permissive");
    expect(candidates[0]!.mediaKind).toBe("video");
    expect(parseAssetCandidate(candidates[0]).ok).toBe(true);
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);
  });

  it("skips a file with no rights sidecar (never infers a license from a filename)", () => {
    const priv = join(ROOT, "city_private.mp4");
    const fs = vfs({
      dirs: { [ROOT]: dir(["city_private.mp4", { isFile: true }]) },
      files: new Set([priv]),
      sidecars: {},
    });
    const { candidates, diagnostics } = discoverLocalAssets(base({ fs }));
    expect(candidates).toHaveLength(0);
    expect(diagnostics.some((d) => /no rights sidecar/.test(d.message))).toBe(true);
  });

  it("skips a file whose sidecar rights are restricted", () => {
    const r = join(ROOT, "city_stock.mp4");
    const fs = vfs({
      dirs: { [ROOT]: dir(["city_stock.mp4", { isFile: true }]) },
      files: new Set([r]),
      sidecars: { [r + ".rights.json"]: RESTRICTED },
    });
    const { candidates, diagnostics } = discoverLocalAssets(base({ fs }));
    expect(candidates).toHaveLength(0);
    expect(diagnostics.some((d) => /not cleared/.test(d.message))).toBe(true);
  });

  it("rejects a symlink whose real target escapes the asset root", () => {
    const link = join(ROOT, "city_escape.mp4");
    const outside = resolve("output", "__outside__", "secret.mp4");
    const fs = vfs({
      dirs: { [ROOT]: dir(["city_escape.mp4", { isSymbolicLink: true }]) },
      files: new Set([outside]),
      sidecars: { [outside + ".rights.json"]: PERMISSIVE },
      real: { [link]: outside },
    });
    const { candidates, diagnostics } = discoverLocalAssets(base({ fs }));
    expect(candidates).toHaveLength(0);
    expect(diagnostics.some((d) => /escaping the asset root/.test(d.message))).toBe(true);
  });

  it("bounds recursion depth", () => {
    const d1 = join(ROOT, "a");
    const d2 = join(d1, "b");
    const deep = join(d2, "city.mp4");
    const fs = vfs({
      dirs: {
        [ROOT]: dir(["a", { isDirectory: true }]),
        [d1]: dir(["b", { isDirectory: true }]),
        [d2]: dir(["city.mp4", { isFile: true }]),
      },
      files: new Set([deep]),
      sidecars: { [deep + ".rights.json"]: PERMISSIVE },
    });
    const { candidates, diagnostics } = discoverLocalAssets(base({ fs, maxDepth: 1 }));
    expect(candidates).toHaveLength(0);
    expect(diagnostics.some((d) => /Recursion depth/.test(d.message))).toBe(true);
  });

  it("bounds total file count", () => {
    const a = join(ROOT, "city_a.mp4");
    const b = join(ROOT, "city_b.mp4");
    const fs = vfs({
      dirs: { [ROOT]: dir(["city_a.mp4", { isFile: true }], ["city_b.mp4", { isFile: true }]) },
      files: new Set([a, b]),
      sidecars: { [a + ".rights.json"]: PERMISSIVE, [b + ".rights.json"]: PERMISSIVE },
    });
    const { candidates, diagnostics } = discoverLocalAssets(base({ fs, maxFiles: 1 }));
    expect(candidates.length).toBeLessThanOrEqual(1);
    expect(diagnostics.some((d) => /File-count bound/.test(d.message))).toBe(true);
  });

  it("orders results deterministically by relevance then ref", () => {
    const one = join(ROOT, "city_skyline.mp4"); // matches two tokens
    const two = join(ROOT, "city_street.mp4"); // matches one token
    const fs = vfs({
      dirs: { [ROOT]: dir(["city_skyline.mp4", { isFile: true }], ["city_street.mp4", { isFile: true }]) },
      files: new Set([one, two]),
      sidecars: { [one + ".rights.json"]: LOCAL_OWNER, [two + ".rights.json"]: LOCAL_OWNER },
    });
    const { candidates } = discoverLocalAssets(base({ fs }));
    expect(candidates.map((c) => c.ref)).toEqual(["city_skyline.mp4", "city_street.mp4"]);
    expect(candidates[0]!.relevance).toBeGreaterThan(candidates[1]!.relevance);
  });

  it("ignores non-allowlisted extensions", () => {
    const notes = join(ROOT, "city_notes.txt");
    const fs = vfs({
      dirs: { [ROOT]: dir(["city_notes.txt", { isFile: true }]) },
      files: new Set([notes]),
      sidecars: { [notes + ".rights.json"]: PERMISSIVE },
    });
    const { candidates } = discoverLocalAssets(base({ fs }));
    expect(candidates).toHaveLength(0);
  });

  it("runs against a real temporary directory (offline smoke)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ove-discovery-"));
    try {
      mkdirSync(join(tmp, "broll"));
      const clip = join(tmp, "broll", "city_drone.mp4");
      writeFileSync(clip, "not real bytes, just a fixture");
      writeFileSync(clip + ".rights.json", PERMISSIVE);
      // A second clip with no sidecar must not appear.
      writeFileSync(join(tmp, "broll", "city_private.mp4"), "x");
      const { candidates } = discoverLocalAssets(base({ root: tmp }));
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.ref).toBe("broll/city_drone.mp4");
      expect(candidates[0]!.title).toBe("City skyline drone");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
