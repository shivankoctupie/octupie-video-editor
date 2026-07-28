import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { createPolicy } from "../src/permissions/policy.js";
import { discoverAssets, type DiscoverAssetsInput } from "../src/discovery/discover.js";
import { createWebReferenceProvider, createDriveProvider, type RemoteDiscoveryProvider } from "../src/discovery/providers.js";
import type { AssetCandidateValue, AssetDiscoveryQueryValue } from "../src/discovery/schemas.js";
import type { LocalDiscoveryResult } from "../src/discovery/local.js";

const NOW = new Date("2026-07-28T00:00:00.000Z");
const ROOT = resolve("output", "__disc_root__");
const NETWORK = createPolicy([{ action: "network", grantedBy: "test", grantedAt: NOW.toISOString() }]);

function localCandidate(over: Partial<AssetCandidateValue> = {}): AssetCandidateValue {
  return {
    source: "local",
    ref: "broll/city.mp4",
    title: "City",
    relevance: 0.7,
    mediaKind: "video",
    intentMatch: "matched tokens: city",
    provenance: "user-supplied",
    license: { id: "local-owner", attributionRequired: false },
    rightsStatus: "local-owner",
    retrievedAt: NOW.toISOString(),
    bytesLocal: true,
    ...over,
  };
}

function fakeLocal(result: LocalDiscoveryResult): DiscoverAssetsInput["localDiscover"] {
  return () => result;
}

function query(over: Partial<AssetDiscoveryQueryValue> = {}): AssetDiscoveryQueryValue {
  return { intent: "city skyline", sources: ["local"], maxResults: 20, ...over };
}

describe("discoverAssets local-only", () => {
  it("works offline with no permission policy", async () => {
    const res = await discoverAssets({
      query: query(),
      assetRoot: ROOT,
      now: NOW,
      localDiscover: fakeLocal({ candidates: [localCandidate()], diagnostics: [] }),
    });
    expect(res.candidates).toHaveLength(1);
    expect(res.sourcesQueried).toEqual(["local"]);
  });

  it("drops untrusted candidates before returning", async () => {
    const res = await discoverAssets({
      query: query(),
      assetRoot: ROOT,
      now: NOW,
      localDiscover: fakeLocal({
        candidates: [
          localCandidate({ ref: "ok.mp4" }),
          localCandidate({ ref: "bad.mp4", rightsStatus: "unknown", license: { id: "unknown", attributionRequired: false } }),
        ],
        diagnostics: [],
      }),
    });
    expect(res.candidates.map((c) => c.ref)).toEqual(["ok.mp4"]);
    expect(res.diagnostics.some((d) => /not cleared/.test(d.message))).toBe(true);
  });
});

describe("discoverAssets remote permission", () => {
  it("denies mixed drive/web BEFORE any provider call when network is not granted", async () => {
    const web = createWebReferenceProvider({ now: NOW, adapter: async () => ({ rows: [] }) });
    const spy = vi.spyOn(web, "discover");
    const localSpy = vi.fn(() => ({ candidates: [], diagnostics: [] }));
    await expect(
      discoverAssets({
        query: query({ sources: ["local", "web"] }),
        assetRoot: ROOT,
        now: NOW,
        web,
        localDiscover: localSpy,
      }),
    ).rejects.toThrow(/Permission denied for 'network'/);
    expect(spy).not.toHaveBeenCalled();
    expect(localSpy).not.toHaveBeenCalled();
  });

  it("calls remote providers once network is granted", async () => {
    const web = createWebReferenceProvider({
      now: NOW,
      adapter: async () => ({
        rows: [
          { ref: "https://example.com/a.jpg", title: "A", rightsStatus: "permissive", license: { id: "CC0-1.0", attributionRequired: false }, relevance: 0.9 },
        ],
      }),
    });
    const res = await discoverAssets({
      query: query({ sources: ["web"] }),
      assetRoot: ROOT,
      now: NOW,
      permissionPolicy: NETWORK,
      web,
    });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]!.source).toBe("web");
  });

  it("preserves a provider error as a diagnostic, not a candidate", async () => {
    const drive: RemoteDiscoveryProvider = {
      kind: "drive",
      requiresPermissions: ["network"],
      configured: true,
      discover: async () => {
        throw new Error("drive exploded");
      },
      materialize: async () => ({ localRef: "x" }),
    };
    const res = await discoverAssets({
      query: query({ sources: ["drive"] }),
      assetRoot: ROOT,
      now: NOW,
      permissionPolicy: NETWORK,
      drive,
    });
    expect(res.candidates).toHaveLength(0);
    expect(res.diagnostics.some((d) => d.level === "error" && /drive exploded/.test(d.message))).toBe(true);
  });
});

describe("discoverAssets merge, dedupe, sort, cap", () => {
  it("de-duplicates stable refs and keeps the higher relevance", async () => {
    const web = createWebReferenceProvider({
      now: NOW,
      adapter: async () => ({
        rows: [
          { ref: "https://example.com/a.jpg", title: "A low", relevance: 0.3, rightsStatus: "permissive", license: { id: "CC0-1.0", attributionRequired: false } },
          { ref: "https://example.com/a.jpg", title: "A high", relevance: 0.95, rightsStatus: "permissive", license: { id: "CC0-1.0", attributionRequired: false } },
        ],
      }),
    });
    const res = await discoverAssets({
      query: query({ sources: ["web"] }),
      assetRoot: ROOT,
      now: NOW,
      permissionPolicy: NETWORK,
      web,
    });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]!.relevance).toBe(0.95);
  });

  it("sorts by relevance, then source, then ref, and caps at maxResults", async () => {
    const web = createWebReferenceProvider({
      now: NOW,
      adapter: async () => ({
        rows: [
          { ref: "https://example.com/hi.jpg", title: "hi", relevance: 0.9, rightsStatus: "permissive", license: { id: "CC0-1.0", attributionRequired: false } },
          { ref: "https://example.com/lo.jpg", title: "lo", relevance: 0.2, rightsStatus: "permissive", license: { id: "CC0-1.0", attributionRequired: false } },
        ],
      }),
    });
    const res = await discoverAssets({
      query: query({ sources: ["local", "web"], maxResults: 2 }),
      assetRoot: ROOT,
      now: NOW,
      permissionPolicy: NETWORK,
      web,
      localDiscover: fakeLocal({ candidates: [localCandidate({ ref: "mid.mp4", relevance: 0.5 })], diagnostics: [] }),
    });
    expect(res.candidates).toHaveLength(2);
    expect(res.candidates.map((c) => c.relevance)).toEqual([0.9, 0.5]);
    expect(res.candidates[0]!.source).toBe("web");
  });
});

describe("discoverAssets validation", () => {
  it("rejects an invalid query", async () => {
    await expect(
      discoverAssets({ query: { intent: "", sources: ["local"], maxResults: 5 } as AssetDiscoveryQueryValue, assetRoot: ROOT, now: NOW }),
    ).rejects.toThrow(/Invalid discovery query/);
  });
});
