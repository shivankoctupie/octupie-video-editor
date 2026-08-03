import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeWebAsset } from "../src/materialize/web.js";
import { materializeDriveFile } from "../src/materialize/drive.js";
import { APPROVED_MEDIA_MIME } from "../src/materialize/schemas.js";
import { createPolicy, PermissionDeniedError, type PermissionGrant, type PermissionPolicy } from "../src/permissions/policy.js";
import { SsrfBlockedError, type HostResolver } from "../src/util/ssrf.js";
import type { FetchLike, FetchResponseLike } from "../src/util/fetchLike.js";

const NOW = new Date("2026-08-01T10:00:00.000Z");

const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** A fresh, isolated destination directory per test. */
function outDir(): string {
  const root = mkdtempSync(join(tmpdir(), "oct-materialize-"));
  roots.push(root);
  return root;
}

const grant = (action: PermissionGrant["action"]): PermissionGrant => ({ action, grantedBy: "operator", grantedAt: NOW.toISOString() });
const bothGrants = (): PermissionPolicy => createPolicy([grant("network"), grant("media-upload")]);

/** Valid, reusable rights the downloader accepts. */
const RIGHTS = { license: "CC0-1.0", attribution: "Test Author", reusable: true as const, source: "https://example.com/img.png" };

/** Injected resolver: every host maps to a single public address (offline, deterministic). */
const publicResolve: HostResolver = async () => ["93.184.216.34"];

/** A small, valid PNG-signature byte payload. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer as ArrayBuffer;
}

/** Build a canned response with case-insensitive headers. */
function res(opts: { status: number; headers?: Record<string, string>; body?: Uint8Array }): FetchResponseLike {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) lower[k.toLowerCase()] = v;
  const body = opts.body ?? new Uint8Array();
  return {
    status: opts.status,
    headers: {
      get(name: string): string | null {
        const v = lower[name.toLowerCase()];
        return v === undefined ? null : v;
      },
    },
    arrayBuffer: async () => toArrayBuffer(body),
    text: async () => Buffer.from(body).toString("utf8"),
    json: async () => JSON.parse(Buffer.from(body).toString("utf8")),
  };
}

const okPng = (): FetchResponseLike => res({ status: 200, headers: { "content-type": "image/png" }, body: PNG });

describe("materializeWebAsset", () => {
  it("happy path: writes bytes + rights + record sidecars with a matching sha256", async () => {
    const dir = outDir();
    const fetch: FetchLike = async () => okPng();
    const out = await materializeWebAsset({
      url: "https://example.com/img.png",
      rights: RIGHTS,
      relPath: "img.png",
      outDir: dir,
      policy: bothGrants(),
      fetch,
      resolve: publicResolve,
      now: NOW,
    });

    expect(out.record.method).toBe("web");
    expect(out.record.source).toBe("https://example.com/img.png");
    expect(out.record.mime).toBe("image/png");
    expect(out.record.bytes).toBe(PNG.byteLength);
    expect(out.record.relPath).toBe("img.png");
    expect(out.record.rights.reusable).toBe(true);

    const expectedSha = createHash("sha256").update(Buffer.from(PNG)).digest("hex");
    expect(out.record.sha256).toBe(expectedSha);

    const written = readFileSync(out.assetPath);
    expect(written.equals(Buffer.from(PNG))).toBe(true);

    expect(existsSync(`${out.assetPath}.rights.json`)).toBe(true);
    expect(existsSync(`${out.assetPath}.materialized.json`)).toBe(true);
    const rightsJson = JSON.parse(readFileSync(`${out.assetPath}.rights.json`, "utf8"));
    expect(rightsJson.reusable).toBe(true);
    expect(rightsJson.license).toBe("CC0-1.0");
    const recordJson = JSON.parse(readFileSync(`${out.assetPath}.materialized.json`, "utf8"));
    expect(recordJson.sha256).toBe(expectedSha);
    expect(recordJson.format).toBe("octupie-materialized-asset/v1");
  });

  it("APPROVED_MEDIA_MIME contains inert media types and not text/html or active SVG", () => {
    for (const m of ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime", "audio/wav", "audio/mpeg", "audio/mp4", "audio/aac"]) {
      expect(APPROVED_MEDIA_MIME.has(m)).toBe(true);
    }
    expect(APPROVED_MEDIA_MIME.has("text/html")).toBe(false);
    // SVG is an active document and is refused for remote materialization (stored XSS).
    expect(APPROVED_MEDIA_MIME.has("image/svg+xml")).toBe(false);
  });

  it("without a network grant -> PermissionDeniedError, fetch not called", async () => {
    const dir = outDir();
    let called = false;
    const fetch: FetchLike = async () => {
      called = true;
      return okPng();
    };
    const policy = createPolicy([grant("media-upload")]);
    await expect(
      materializeWebAsset({ url: "https://example.com/img.png", rights: RIGHTS, relPath: "a.png", outDir: dir, policy, fetch, resolve: publicResolve, now: NOW }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(called).toBe(false);
  });

  it("without a media-upload grant -> PermissionDeniedError, fetch not called", async () => {
    const dir = outDir();
    let called = false;
    const fetch: FetchLike = async () => {
      called = true;
      return okPng();
    };
    const policy = createPolicy([grant("network")]);
    await expect(
      materializeWebAsset({ url: "https://example.com/img.png", rights: RIGHTS, relPath: "a.png", outDir: dir, policy, fetch, resolve: publicResolve, now: NOW }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(called).toBe(false);
  });

  it("http:// url -> SsrfBlockedError", async () => {
    const dir = outDir();
    const fetch: FetchLike = async () => okPng();
    await expect(
      materializeWebAsset({ url: "http://example.com/img.png", rights: RIGHTS, relPath: "a.png", outDir: dir, policy: bothGrants(), fetch, resolve: publicResolve, now: NOW }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("host resolving to a private address -> SsrfBlockedError, fetch not called", async () => {
    const dir = outDir();
    let called = false;
    const fetch: FetchLike = async () => {
      called = true;
      return okPng();
    };
    const resolvePrivate: HostResolver = async () => ["10.0.0.5"];
    await expect(
      materializeWebAsset({ url: "https://rebind.example/img.png", rights: RIGHTS, relPath: "a.png", outDir: dir, policy: bothGrants(), fetch, resolve: resolvePrivate, now: NOW }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(called).toBe(false);
  });

  it("missing rights ({}) fails closed before any fetch", async () => {
    const dir = outDir();
    let called = false;
    const fetch: FetchLike = async () => {
      called = true;
      return okPng();
    };
    await expect(
      materializeWebAsset({ url: "https://example.com/img.png", rights: {}, relPath: "a.png", outDir: dir, policy: bothGrants(), fetch, resolve: publicResolve, now: NOW }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("reusable:false fails closed before any fetch", async () => {
    const dir = outDir();
    let called = false;
    const fetch: FetchLike = async () => {
      called = true;
      return okPng();
    };
    const rights = { license: "CC0-1.0", attribution: "", reusable: false, source: "https://example.com/img.png" };
    await expect(
      materializeWebAsset({ url: "https://example.com/img.png", rights, relPath: "a.png", outDir: dir, policy: bothGrants(), fetch, resolve: publicResolve, now: NOW }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("disallowed content-type (text/html) -> rejects", async () => {
    const dir = outDir();
    const fetch: FetchLike = async () => res({ status: 200, headers: { "content-type": "text/html" }, body: new Uint8Array([1, 2, 3]) });
    await expect(
      materializeWebAsset({ url: "https://example.com/x", rights: RIGHTS, relPath: "a.png", outDir: dir, policy: bothGrants(), fetch, resolve: publicResolve, now: NOW }),
    ).rejects.toThrow();
    expect(existsSync(join(dir, "a.png"))).toBe(false);
  });

  it("body over maxBytes -> rejects, nothing written", async () => {
    const dir = outDir();
    const fetch: FetchLike = async () => res({ status: 200, headers: { "content-type": "image/png" }, body: new Uint8Array(20) });
    await expect(
      materializeWebAsset({ url: "https://example.com/x", rights: RIGHTS, relPath: "a.png", outDir: dir, policy: bothGrants(), fetch, resolve: publicResolve, now: NOW, maxBytes: 10 }),
    ).rejects.toThrow();
    expect(existsSync(join(dir, "a.png"))).toBe(false);
  });

  it("redirect to a private host is blocked, nothing written", async () => {
    const dir = outDir();
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      return res({ status: 302, headers: { location: "http://10.0.0.5/x" } });
    };
    await expect(
      materializeWebAsset({ url: "https://example.com/img.png", rights: RIGHTS, relPath: "a.png", outDir: dir, policy: bothGrants(), fetch, resolve: publicResolve, now: NOW }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(calls).toBe(1);
    expect(existsSync(join(dir, "a.png"))).toBe(false);
  });

  it("refuses to overwrite an existing destination file", async () => {
    const dir = outDir();
    writeFileSync(join(dir, "a.png"), "existing");
    const fetch: FetchLike = async () => okPng();
    await expect(
      materializeWebAsset({ url: "https://example.com/x", rights: RIGHTS, relPath: "a.png", outDir: dir, policy: bothGrants(), fetch, resolve: publicResolve, now: NOW }),
    ).rejects.toThrow(/overwrite/i);
    expect(readFileSync(join(dir, "a.png"), "utf8")).toBe("existing");
  });

  it("refuses an unsafe relPath ('../x.png')", async () => {
    const dir = outDir();
    const fetch: FetchLike = async () => okPng();
    await expect(
      materializeWebAsset({ url: "https://example.com/x", rights: RIGHTS, relPath: "../x.png", outDir: dir, policy: bothGrants(), fetch, resolve: publicResolve, now: NOW }),
    ).rejects.toThrow();
  });
});

describe("materializeDriveFile", () => {
  const DRIVE_ENV = "TEST_DRIVE_TOKEN";

  it("happy path: official url + bearer header; token never lands in record or sidecars", async () => {
    const dir = outDir();
    const token = "tok-secret-abc123XYZ";
    process.env[DRIVE_ENV] = token;
    try {
      let capturedUrl = "";
      let capturedAuth: string | null = null;
      const fetch: FetchLike = async (url, init) => {
        capturedUrl = url;
        capturedAuth = init?.headers?.authorization ?? null;
        return okPng();
      };
      const out = await materializeDriveFile({
        fileId: "1AbC_dEf-123",
        rights: RIGHTS,
        relPath: "drive/a.png",
        outDir: dir,
        policy: bothGrants(),
        fetch,
        accessTokenEnv: DRIVE_ENV,
        now: NOW,
      });

      expect(capturedUrl).toBe("https://www.googleapis.com/drive/v3/files/1AbC_dEf-123?alt=media");
      expect(capturedAuth).toBe(`Bearer ${token}`);
      expect(out.record.method).toBe("drive");
      expect(out.record.source).toBe("1AbC_dEf-123");

      expect(JSON.stringify(out.record)).not.toContain(token);
      const recordRaw = readFileSync(`${out.assetPath}.materialized.json`, "utf8");
      const rightsRaw = readFileSync(`${out.assetPath}.rights.json`, "utf8");
      expect(recordRaw).not.toContain(token);
      expect(rightsRaw).not.toContain(token);
      expect(readFileSync(out.assetPath).equals(Buffer.from(PNG))).toBe(true);
    } finally {
      delete process.env[DRIVE_ENV];
    }
  });

  it("without a token in the env -> throws, message carries no token value", async () => {
    const dir = outDir();
    delete process.env[DRIVE_ENV];
    const fetch: FetchLike = async () => okPng();
    let message = "";
    try {
      await materializeDriveFile({ fileId: "abc", rights: RIGHTS, relPath: "a.png", outDir: dir, policy: bothGrants(), fetch, accessTokenEnv: DRIVE_ENV, now: NOW });
      throw new Error("should have thrown");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/token/i);
    expect(message).not.toContain("Bearer ");
  });

  it("bad fileId ('../evil') -> rejects, fetch not called", async () => {
    const dir = outDir();
    process.env[DRIVE_ENV] = "tok-x";
    try {
      let called = false;
      const fetch: FetchLike = async () => {
        called = true;
        return okPng();
      };
      await expect(
        materializeDriveFile({ fileId: "../evil", rights: RIGHTS, relPath: "a.png", outDir: dir, policy: bothGrants(), fetch, accessTokenEnv: DRIVE_ENV, now: NOW }),
      ).rejects.toThrow();
      expect(called).toBe(false);
    } finally {
      delete process.env[DRIVE_ENV];
    }
  });

  it("without grants -> PermissionDeniedError", async () => {
    const dir = outDir();
    process.env[DRIVE_ENV] = "tok-x";
    try {
      const fetch: FetchLike = async () => okPng();
      await expect(
        materializeDriveFile({ fileId: "abc", rights: RIGHTS, relPath: "a.png", outDir: dir, policy: createPolicy([]), fetch, accessTokenEnv: DRIVE_ENV, now: NOW }),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    } finally {
      delete process.env[DRIVE_ENV];
    }
  });

  it("missing rights fails closed", async () => {
    const dir = outDir();
    process.env[DRIVE_ENV] = "tok-x";
    try {
      const fetch: FetchLike = async () => okPng();
      await expect(
        materializeDriveFile({ fileId: "abc", rights: { reusable: false }, relPath: "a.png", outDir: dir, policy: bothGrants(), fetch, accessTokenEnv: DRIVE_ENV, now: NOW }),
      ).rejects.toThrow();
    } finally {
      delete process.env[DRIVE_ENV];
    }
  });
});
