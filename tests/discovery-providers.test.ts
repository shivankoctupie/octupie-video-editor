import { describe, it, expect, vi } from "vitest";
import { createPolicy } from "../src/permissions/policy.js";
import type { ExecResult } from "../src/agent/exec.js";
import {
  createDriveProvider,
  createWebReferenceProvider,
  createExecJsonAdapter,
  type RemoteDiscoveryAdapter,
  type RemoteReferenceRow,
} from "../src/discovery/providers.js";
import type { AssetCandidateValue } from "../src/discovery/schemas.js";

const NOW = new Date("2026-07-28T00:00:00.000Z");
const CTX = { intent: "city skyline", maxResults: 10, timeoutMs: 1000 };
const MEDIA = createPolicy([{ action: "media-upload", grantedBy: "test", grantedAt: NOW.toISOString() }]);

function adapterReturning(rows: RemoteReferenceRow[]): RemoteDiscoveryAdapter {
  return async () => ({ rows });
}

describe("remote provider not configured", () => {
  it("drive without an adapter returns zero candidates and a truthful diagnostic", async () => {
    const p = createDriveProvider();
    expect(p.configured).toBe(false);
    const { candidates, diagnostics } = await p.discover(CTX);
    expect(candidates).toHaveLength(0);
    expect(diagnostics[0]!.message).toMatch(/not configured/);
  });

  it("web without an adapter returns zero candidates", async () => {
    const p = createWebReferenceProvider();
    const { candidates } = await p.discover(CTX);
    expect(candidates).toHaveLength(0);
  });
});

describe("remote provider with a data-only adapter", () => {
  it("returns references (never bytes) and stamps the retrieval time", async () => {
    const p = createWebReferenceProvider({
      now: NOW,
      adapter: adapterReturning([
        {
          ref: "https://cdn.example.com/city.jpg",
          title: "City",
          mediaKind: "image",
          relevance: 0.9,
          provenance: "licensed-source",
          license: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/", attributionRequired: true, attributionText: "By Example" },
          rightsStatus: "permissive",
        },
      ]),
    });
    const { candidates } = await p.discover(CTX);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.source).toBe("web");
    expect(candidates[0]!.bytesLocal).toBe(false);
    expect(candidates[0]!.retrievedAt).toBe(NOW.toISOString());
    expect(candidates[0]!.rightsStatus).toBe("permissive");
  });

  it("rejects a row with a non-http(s) reference", async () => {
    const p = createWebReferenceProvider({
      now: NOW,
      adapter: adapterReturning([{ ref: "file:///etc/passwd", title: "bad" }]),
    });
    const { candidates, diagnostics } = await p.discover(CTX);
    expect(candidates).toHaveLength(0);
    expect(diagnostics.some((d) => /non-http/.test(d.message))).toBe(true);
  });

  it("defaults missing rights to unknown so the orchestrator can drop them", async () => {
    const p = createWebReferenceProvider({
      now: NOW,
      adapter: adapterReturning([{ ref: "https://example.com/x.jpg", title: "x" }]),
    });
    const { candidates } = await p.discover(CTX);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.rightsStatus).toBe("unknown");
    expect(candidates[0]!.license.id).toBe("unknown");
  });

  it("preserves an adapter error as a diagnostic, not a candidate", async () => {
    const p = createWebReferenceProvider({
      now: NOW,
      adapter: async () => {
        throw new Error("network down");
      },
    });
    const { candidates, diagnostics } = await p.discover(CTX);
    expect(candidates).toHaveLength(0);
    expect(diagnostics.some((d) => d.level === "error" && /network down/.test(d.message))).toBe(true);
  });

  it("bounds results to the smaller of query and hard caps", async () => {
    const rows: RemoteReferenceRow[] = Array.from({ length: 100 }, (_, i) => ({
      ref: `https://example.com/${i}.jpg`,
      title: `img ${i}`,
      rightsStatus: "permissive" as const,
      license: { id: "CC0-1.0", attributionRequired: false },
    }));
    const p = createWebReferenceProvider({ now: NOW, hardMaxResults: 5, adapter: adapterReturning(rows) });
    const { candidates } = await p.discover({ intent: "x", maxResults: 3, timeoutMs: 1000 });
    expect(candidates).toHaveLength(3);
  });
});

describe("materialize is the only byte path", () => {
  it("does not transfer bytes during discovery", async () => {
    const transport = vi.fn(async (_c: AssetCandidateValue) => ({ localRef: "assets/dl.jpg" }));
    const p = createWebReferenceProvider({
      now: NOW,
      transport,
      adapter: adapterReturning([
        { ref: "https://example.com/x.jpg", title: "x", rightsStatus: "permissive", license: { id: "CC0-1.0", attributionRequired: false } },
      ]),
    });
    await p.discover(CTX);
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses materialize without a media-upload grant", async () => {
    const p = createWebReferenceProvider({ transport: async () => ({ localRef: "assets/x.jpg" }) });
    const candidate = { source: "web", ref: "https://example.com/x.jpg" } as unknown as AssetCandidateValue;
    await expect(p.materialize(candidate, createPolicy([]), NOW)).rejects.toThrow(/Permission denied for 'media-upload'/);
  });

  it("refuses materialize with a grant but no configured transport", async () => {
    const p = createWebReferenceProvider({});
    const candidate = { source: "web", ref: "https://example.com/x.jpg" } as unknown as AssetCandidateValue;
    await expect(p.materialize(candidate, MEDIA, NOW)).rejects.toThrow(/requires a configured media transport/);
  });

  it("transfers only through the transport when granted", async () => {
    const transport = vi.fn(async (_c: AssetCandidateValue) => ({ localRef: "assets/dl.jpg" }));
    const p = createWebReferenceProvider({ transport });
    const candidate = { source: "web", ref: "https://example.com/x.jpg" } as unknown as AssetCandidateValue;
    const res = await p.materialize(candidate, MEDIA, NOW);
    expect(res.localRef).toBe("assets/dl.jpg");
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe("createExecJsonAdapter (concrete gws-style Drive mechanism)", () => {
  it("runs an argument array through the bounded runner and parses JSON data only", async () => {
    let sawBinary = "";
    let sawArgs: readonly string[] = [];
    const runner = async (binary: string, args: readonly string[]): Promise<ExecResult> => {
      sawBinary = binary;
      sawArgs = args;
      return {
        code: 0,
        stdout: JSON.stringify([{ id: "1", link: "https://drive.example.com/f/1", name: "City" }]),
        stderr: "",
        timedOut: false,
      };
    };
    const adapter = createExecJsonAdapter({
      binary: "gws",
      buildArgs: (intent, max) => ["drive", "search", "--query", intent, "--limit", String(max), "--json"],
      parseRows: (json) =>
        (json as Array<{ link: string; name: string }>).map((r) => ({
          ref: r.link,
          title: r.name,
          mediaKind: "image",
          rightsStatus: "permissive",
          license: { id: "CC0-1.0", attributionRequired: false },
        })),
      runner,
    });
    const drive = createDriveProvider({ now: NOW, adapter });
    const { candidates } = await drive.discover(CTX);
    expect(sawBinary).toBe("gws");
    expect(sawArgs).toEqual(["drive", "search", "--query", "city skyline", "--limit", "10", "--json"]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.source).toBe("drive");
    expect(candidates[0]!.ref).toBe("https://drive.example.com/f/1");
  });

  it("surfaces a non-zero exit as an adapter error diagnostic", async () => {
    const runner = async (): Promise<ExecResult> => ({ code: 2, stdout: "", stderr: "auth required", timedOut: false });
    const adapter = createExecJsonAdapter({
      binary: "gws",
      buildArgs: () => ["drive", "search"],
      parseRows: () => [],
      runner,
    });
    const drive = createDriveProvider({ now: NOW, adapter });
    const { candidates, diagnostics } = await drive.discover(CTX);
    expect(candidates).toHaveLength(0);
    expect(diagnostics.some((d) => d.level === "error" && /exited 2/.test(d.message))).toBe(true);
  });
});
