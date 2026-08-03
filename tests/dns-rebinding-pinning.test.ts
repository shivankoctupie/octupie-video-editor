import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFetch, pinnedRequestOptions, type PinnedRequestOptions } from "../src/util/pinnedFetch.js";
import { materializeWebAsset } from "../src/materialize/web.js";
import { createPolicy, type PermissionGrant, type PermissionPolicy } from "../src/permissions/policy.js";
import type { FetchLike, FetchInitLike, FetchResponseLike } from "../src/util/fetchLike.js";
import type { HostResolver } from "../src/util/ssrf.js";

/*
 * DNS-rebinding TOCTOU. Validating one DNS lookup and then letting a global fetch resolve
 * the host again lets an attacker rebind the name to a private address between the check
 * and the connect. The fix pins the socket to the already-validated public IP while
 * keeping the hostname for Host/SNI, and never performs a second DNS lookup. These tests
 * prove the connect path uses the vetted address and a rebinding destination never
 * receives the connection.
 */

const NOW = new Date("2026-08-01T10:00:00.000Z");
const grant = (action: PermissionGrant["action"]): PermissionGrant => ({ action, grantedBy: "operator", grantedAt: NOW.toISOString() });
const bothGrants = (): PermissionPolicy => createPolicy([grant("network"), grant("media-upload")]);
const RIGHTS = { license: "CC0-1.0", attribution: "Test", reusable: true as const, source: "https://example.com/x" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function pngResponse(): FetchResponseLike {
  const ab = new ArrayBuffer(PNG.byteLength);
  new Uint8Array(ab).set(PNG);
  return {
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "image/png" : null) },
    arrayBuffer: async () => ab,
    text: async () => "",
    json: async () => ({}),
  };
}

/** Invoke a pinned lookup and return the single address it would connect to. */
function dialViaLookup(opts: PinnedRequestOptions, hostname: string): string | undefined {
  let dialed: string | undefined;
  opts.lookup?.(hostname, { all: false } as never, ((_err: unknown, address: string) => { dialed = address; }) as never);
  return dialed;
}

describe("pinnedRequestOptions", () => {
  it("preserves the hostname for Host/SNI and the real path/port", () => {
    const opts = pinnedRequestOptions(new URL("https://cdn.example.com/a.png?x=1"), { method: "GET", pinnedAddress: "93.184.216.34" });
    expect(opts.host).toBe("cdn.example.com");
    expect(opts.servername).toBe("cdn.example.com");
    expect(opts.port).toBe(443);
    expect(opts.path).toBe("/a.png?x=1");
    expect(opts.method).toBe("GET");
  });

  it("pins the connect to the vetted address and never performs a second DNS lookup", () => {
    const opts = pinnedRequestOptions(new URL("https://cdn.example.com/a.png"), { pinnedAddress: "93.184.216.34" });
    expect(typeof opts.lookup).toBe("function");
    // The lookup ignores the hostname entirely: even a rebound name yields the vetted IP.
    expect(dialViaLookup(opts, "cdn.example.com")).toBe("93.184.216.34");
    expect(dialViaLookup(opts, "rebound-to-internal.example")).toBe("93.184.216.34");
    // all:true form returns the same single vetted address as a record array.
    let arr: Array<{ address: string; family: number }> | undefined;
    opts.lookup?.("cdn.example.com", { all: true } as never, ((_e: unknown, addrs: Array<{ address: string; family: number }>) => { arr = addrs; }) as never);
    expect(arr).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("marks an IPv6 pinned address as family 6", () => {
    const opts = pinnedRequestOptions(new URL("https://v6.example.com/x"), { pinnedAddress: "2606:2800:220:1:248:1893:25c8:1946" });
    let family: number | undefined;
    opts.lookup?.("v6.example.com", { all: false } as never, ((_e: unknown, _a: string, f: number) => { family = f; }) as never);
    expect(family).toBe(6);
  });

  it("uses the system resolver (no pinned lookup) when no address is pinned", () => {
    const opts = pinnedRequestOptions(new URL("https://www.googleapis.com/drive/v3/files/x?alt=media"), { method: "GET" });
    expect(opts.lookup).toBeUndefined();
    expect(opts.host).toBe("www.googleapis.com");
  });
});

describe("createNodeFetch connects only to the pinned address", () => {
  it("dials the vetted public IP, not a rebinding private one, and preserves the Host", async () => {
    const seen: { dialed?: string; host?: string; servername?: string } = {};
    const fakeRequest = (options: PinnedRequestOptions, cb: (res: any) => void) => {
      seen.host = options.host;
      seen.servername = options.servername;
      // Whatever IP the transport pins to is the IP the socket would dial.
      seen.dialed = dialViaLookup(options, options.host);
      const res: any = {
        statusCode: 200,
        headers: { "content-type": "image/png" },
        _h: {} as Record<string, (arg?: unknown) => void>,
        on(ev: string, h: (arg?: unknown) => void) { this._h[ev] = h; return this; },
      };
      const req: any = {
        on() { return req; },
        write() {},
        destroy() {},
        end() {
          cb(res);
          res._h.data?.(Buffer.from([1, 2, 3]));
          res._h.end?.();
        },
      };
      return req;
    };
    const nodeFetch = createNodeFetch({ request: fakeRequest as never });
    const res = await nodeFetch("https://cdn.example.com/a.png", { method: "GET", pinnedAddress: "93.184.216.34" } as FetchInitLike);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(seen.host).toBe("cdn.example.com");
    expect(seen.servername).toBe("cdn.example.com");
    // The socket dialed ONLY the vetted public address. A rebound private IP is never reached.
    expect(seen.dialed).toBe("93.184.216.34");
    expect(seen.dialed).not.toBe("10.0.0.5");
  });
});

describe("web materializer pins the connect to the validated public address", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function outDir(): string { const d = mkdtempSync(join(tmpdir(), "oct-pin-")); dirs.push(d); return d; }

  it("threads the vetted address returned by validation into the fetch as pinnedAddress", async () => {
    const captured: Array<FetchInitLike | undefined> = [];
    const fetch: FetchLike = async (_url, init) => { captured.push(init); return pngResponse(); };
    // Validation resolves this host to a single public address.
    const resolve: HostResolver = async () => ["93.184.216.34"];
    const out = await materializeWebAsset({ url: "https://cdn.example.com/a.png", rights: RIGHTS, relPath: "a.png", outDir: outDir(), policy: bothGrants(), fetch, resolve, now: NOW });
    expect(out.record.mime).toBe("image/png");
    expect(captured).toHaveLength(1);
    // The connect is pinned to exactly the address validation approved (no second lookup).
    expect(captured[0]?.pinnedAddress).toBe("93.184.216.34");
  });

  it("pins to an address from the validated set when several are returned", async () => {
    const captured: Array<FetchInitLike | undefined> = [];
    const fetch: FetchLike = async (_url, init) => { captured.push(init); return pngResponse(); };
    const vetted = ["93.184.216.34", "203.0.114.9"];
    const resolve: HostResolver = async () => vetted;
    await materializeWebAsset({ url: "https://cdn.example.com/a.png", rights: RIGHTS, relPath: "a.png", outDir: outDir(), policy: bothGrants(), fetch, resolve, now: NOW });
    expect(vetted).toContain(captured[0]?.pinnedAddress);
  });
});
