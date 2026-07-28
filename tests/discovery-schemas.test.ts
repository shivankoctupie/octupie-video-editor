import { describe, it, expect } from "vitest";
import {
  parseAssetDiscoveryQuery,
  parseAssetCandidate,
  parseRightsSidecar,
  filterTrustedCandidates,
  isTrustedRightsStatus,
  isAllowedRemoteUrl,
  MAX_DISCOVERY_RESULTS,
  type AssetCandidateValue,
} from "../src/discovery/schemas.js";

function candidate(over: Partial<AssetCandidateValue> = {}): AssetCandidateValue {
  return {
    source: "local",
    ref: "broll/city.mp4",
    title: "City skyline",
    relevance: 0.8,
    mediaKind: "video",
    intentMatch: "matched tokens: city",
    provenance: "user-supplied",
    license: { id: "local-owner", attributionRequired: false },
    rightsStatus: "local-owner",
    retrievedAt: "2026-07-28T00:00:00.000Z",
    bytesLocal: true,
    ...over,
  };
}

describe("assetDiscoveryQuerySchema", () => {
  it("accepts a valid query", () => {
    const r = parseAssetDiscoveryQuery({ intent: "city skyline", sources: ["local"], maxResults: 10 });
    expect(r.ok).toBe(true);
    expect(r.data?.sources).toEqual(["local"]);
  });

  it("rejects unknown fields", () => {
    const r = parseAssetDiscoveryQuery({ intent: "x", sources: ["local"], maxResults: 5, extra: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/extra|unrecognized/i);
  });

  it("requires at least one source", () => {
    const r = parseAssetDiscoveryQuery({ intent: "x", sources: [], maxResults: 5 });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown source kind", () => {
    const r = parseAssetDiscoveryQuery({ intent: "x", sources: ["ftp"], maxResults: 5 });
    expect(r.ok).toBe(false);
  });

  it("caps maxResults", () => {
    const r = parseAssetDiscoveryQuery({ intent: "x", sources: ["local"], maxResults: MAX_DISCOVERY_RESULTS + 1 });
    expect(r.ok).toBe(false);
  });
});

describe("assetCandidateSchema", () => {
  it("accepts a fully-specified trusted local candidate", () => {
    const r = parseAssetCandidate(candidate());
    expect(r.ok).toBe(true);
  });

  it("rejects unknown fields", () => {
    const r = parseAssetCandidate({ ...candidate(), sneaky: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects a local ref that escapes the root", () => {
    const r = parseAssetCandidate(candidate({ ref: "../secret.mp4" }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/relative path/);
  });

  it("rejects a remote candidate with a non-http ref", () => {
    const r = parseAssetCandidate(
      candidate({ source: "web", ref: "file:///etc/passwd", bytesLocal: false }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a remote candidate that claims local bytes", () => {
    const r = parseAssetCandidate(
      candidate({ source: "web", ref: "https://example.com/x.jpg", bytesLocal: true }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/bytesLocal/);
  });

  it("rejects a blank license id", () => {
    expect(parseAssetCandidate(candidate({ license: { id: "   ", attributionRequired: false } })).ok).toBe(false);
    expect(parseRightsSidecar({
      licenseId: "   ",
      attributionRequired: false,
      rightsStatus: "permissive",
      provenance: "licensed-source",
    }).ok).toBe(false);
  });

  it("requires attribution text when attribution is required", () => {
    const r = parseAssetCandidate(
      candidate({ license: { id: "CC-BY-4.0", attributionRequired: true } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/attributionText/);
  });
});

describe("rightsSidecarSchema", () => {
  it("accepts a permissive sidecar", () => {
    const r = parseRightsSidecar({
      licenseId: "CC0-1.0",
      attributionRequired: false,
      rightsStatus: "permissive",
      provenance: "licensed-source",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown fields", () => {
    const r = parseRightsSidecar({
      licenseId: "CC0-1.0",
      attributionRequired: false,
      rightsStatus: "permissive",
      provenance: "licensed-source",
      note: "hi",
    });
    expect(r.ok).toBe(false);
  });
});

describe("filterTrustedCandidates", () => {
  it("keeps permissive and local-owner, drops unknown and restricted with diagnostics", () => {
    const cands = [
      candidate({ ref: "a.mp4", rightsStatus: "local-owner", license: { id: "local-owner", attributionRequired: false } }),
      candidate({ ref: "b.mp4", rightsStatus: "permissive", license: { id: "CC0-1.0", attributionRequired: false } }),
      candidate({ ref: "c.mp4", rightsStatus: "unknown", license: { id: "unknown", attributionRequired: false } }),
      candidate({ ref: "d.mp4", rightsStatus: "restricted", license: { id: "All-Rights-Reserved", attributionRequired: false } }),
    ];
    const { trusted, diagnostics } = filterTrustedCandidates(cands);
    expect(trusted.map((c) => c.ref)).toEqual(["a.mp4", "b.mp4"]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((d) => d.level === "warn")).toBe(true);
  });

  it("drops a candidate whose license id is literally 'unknown' even if status claims permissive", () => {
    const cands = [candidate({ rightsStatus: "permissive", license: { id: "unknown", attributionRequired: false } })];
    const { trusted, diagnostics } = filterTrustedCandidates(cands);
    expect(trusted).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("isTrustedRightsStatus", () => {
    expect(isTrustedRightsStatus("permissive")).toBe(true);
    expect(isTrustedRightsStatus("local-owner")).toBe(true);
    expect(isTrustedRightsStatus("unknown")).toBe(false);
    expect(isTrustedRightsStatus("restricted")).toBe(false);
  });

  it("isAllowedRemoteUrl accepts http(s) only", () => {
    expect(isAllowedRemoteUrl("https://x.com/a.jpg")).toBe(true);
    expect(isAllowedRemoteUrl("http://x.com/a.jpg")).toBe(true);
    expect(isAllowedRemoteUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedRemoteUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedRemoteUrl("not a url")).toBe(false);
  });
});
