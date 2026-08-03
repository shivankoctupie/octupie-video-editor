import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPolicy, PermissionDeniedError, type PermissionPolicy } from "../src/permissions/policy.js";
import { localImageProvider } from "../src/generation/localImage.js";
import { localTtsProvider } from "../src/generation/localTts.js";
import { writeGeneratedAsset } from "../src/generation/provenance.js";
import { createHttpImageProvider } from "../src/generation/httpImage.js";
import { createHttpTtsProvider } from "../src/generation/httpTts.js";
import type { FetchLike, FetchResponseLike, FetchInitLike } from "../src/util/fetchLike.js";

const NOW = new Date("2026-08-01T12:00:00.000Z");

const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function tmpRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "oct-generation-"));
  roots.push(r);
  return r;
}

function networkPolicy(): PermissionPolicy {
  return createPolicy([{ action: "network", grantedBy: "test", grantedAt: NOW.toISOString() }]);
}
function noGrant(): PermissionPolicy {
  return createPolicy([]);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// --- FetchLike stubs (no real network ever) --------------------------------

interface Captured {
  url: string;
  init: FetchInitLike | undefined;
}
function stubResponse(spec: { status?: number; contentType?: string; contentLength?: string; bytes?: Uint8Array }): FetchResponseLike {
  const bytes = spec.bytes ?? new Uint8Array([1, 2, 3]);
  const headers = new Map<string, string>();
  if (spec.contentType !== undefined) headers.set("content-type", spec.contentType);
  if (spec.contentLength !== undefined) headers.set("content-length", spec.contentLength);
  return {
    status: spec.status ?? 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    },
    text: async () => decode(bytes),
    json: async () => JSON.parse(decode(bytes)) as unknown,
  };
}
function capturingFetch(result: FetchResponseLike | Error, calls: Captured[]): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    if (result instanceof Error) throw result;
    return result;
  };
}

// ---------------------------------------------------------------------------
// Local SVG image provider.
// ---------------------------------------------------------------------------

describe("localImageProvider", () => {
  const req = { prompt: "Hello card", width: 320, height: 200, format: "svg" as const };

  it("is deterministic (two calls are byte-identical) and declares svg mime", async () => {
    const a = await localImageProvider.generate(req, noGrant());
    const b = await localImageProvider.generate(req, noGrant());
    expect(Buffer.from(a.bytes)).toEqual(Buffer.from(b.bytes));
    expect(a.mime).toBe("image/svg+xml");
  });

  it("renders the Octupie palette colors", async () => {
    const svg = decode((await localImageProvider.generate(req, noGrant())).bytes);
    expect(svg).toContain("#F7F5F0");
    expect(svg).toContain("#111111");
    expect(svg).toContain("#014CE3");
  });

  it("XML-escapes a prompt containing < & and \"", async () => {
    const svg = decode((await localImageProvider.generate({ ...req, prompt: 'Tom & Jerry <script> "x"' }, noGrant())).bytes);
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&quot;");
    expect(svg).not.toContain("<script>");
  });
});

// ---------------------------------------------------------------------------
// Local silent WAV provider.
// ---------------------------------------------------------------------------

describe("localTtsProvider", () => {
  it("produces a valid, silent PCM16 mono WAV with the correct byte length", async () => {
    const out = await localTtsProvider.synthesize({ text: "hi", format: "wav" }, noGrant());
    expect(out.mime).toBe("audio/wav");
    const b = Buffer.from(out.bytes);
    expect(b.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(b.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(b.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(b.subarray(36, 40).toString("ascii")).toBe("data");
    expect(b.readUInt16LE(20)).toBe(1); // PCM
    expect(b.readUInt16LE(22)).toBe(1); // mono
    expect(b.readUInt16LE(34)).toBe(16); // 16-bit
    expect(b.readUInt32LE(24)).toBe(24000); // default sample rate
    // duration (default 1.0) * sampleRate * 2 bytes + 44-byte header
    expect(b.byteLength).toBe(1.0 * 24000 * 2 + 44);
    // silent: every data byte is zero
    expect(b.subarray(44).every((x) => x === 0)).toBe(true);
  });

  it("is deterministic", async () => {
    const a = await localTtsProvider.synthesize({ text: "hi", format: "wav" }, noGrant());
    const b = await localTtsProvider.synthesize({ text: "hi", format: "wav" }, noGrant());
    expect(Buffer.from(a.bytes)).toEqual(Buffer.from(b.bytes));
  });

  it("honors an explicit sampleRate and duration in the byte length", async () => {
    const out = await localTtsProvider.synthesize({ text: "hi", format: "wav", sampleRate: 8000, durationSec: 0.5 }, noGrant());
    expect(Buffer.from(out.bytes).byteLength).toBe(Math.round(0.5 * 8000) * 2 + 44);
  });
});

// ---------------------------------------------------------------------------
// Provenance store.
// ---------------------------------------------------------------------------

describe("writeGeneratedAsset", () => {
  const base = {
    mime: "image/svg+xml",
    kind: "image" as const,
    provider: "local-svg",
    requestSummary: "svg 10x10 proof card",
    label: "AI-generated proof card (synthetic, not a photograph)",
    now: NOW,
  };

  it("writes the asset and provenance sidecar with a matching sha256 and synthetic label", async () => {
    const outDir = tmpRoot();
    const bytes = new TextEncoder().encode("<svg/>");
    const r = writeGeneratedAsset({ ...base, outDir, relPath: "card.svg", bytes });
    expect(existsSync(r.assetPath)).toBe(true);
    expect(existsSync(r.sidecarPath)).toBe(true);
    expect(readFileSync(r.assetPath)).toEqual(Buffer.from(bytes));
    const sidecar = JSON.parse(readFileSync(r.sidecarPath, "utf8")) as Record<string, unknown>;
    expect(sidecar.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(sidecar.synthetic).toBe(true);
    expect(typeof sidecar.label).toBe("string");
    expect((sidecar.label as string).length).toBeGreaterThan(0);
    expect(r.record.synthetic).toBe(true);
    expect(r.record.bytes).toBe(bytes.byteLength);
  });

  it("refuses to overwrite an existing asset (second call throws)", () => {
    const outDir = tmpRoot();
    const args = { ...base, outDir, relPath: "once.svg", bytes: new TextEncoder().encode("x") };
    writeGeneratedAsset(args);
    expect(() => writeGeneratedAsset(args)).toThrow(/overwrite/i);
  });

  it("refuses an unsafe relPath", () => {
    const outDir = tmpRoot();
    expect(() => writeGeneratedAsset({ ...base, outDir, relPath: "../escape.svg", bytes: new Uint8Array([1]) })).toThrow();
  });

  it("refuses a mime that is not approved for the kind", () => {
    const outDir = tmpRoot();
    expect(() => writeGeneratedAsset({ ...base, outDir, relPath: "a.bin", mime: "application/octet-stream", bytes: new Uint8Array([1]) })).toThrow(/mime/i);
    // An audio mime on an image kind is also refused.
    expect(() => writeGeneratedAsset({ ...base, outDir, relPath: "b.wav", mime: "audio/wav", bytes: new Uint8Array([1]) })).toThrow(/mime/i);
  });
});

// ---------------------------------------------------------------------------
// HTTP image adapter (injected FetchLike, no real network).
// ---------------------------------------------------------------------------

describe("createHttpImageProvider", () => {
  const ENV = `OCT_TEST_IMG_KEY_${process.pid}`;
  const req = { prompt: "a cat", width: 256, height: 256, format: "png" as const };
  const baseConfig = (fetch: FetchLike) => ({ baseUrl: "https://api.example.com/v1/images", model: "img-model", apiKeyEnv: ENV, fetch });
  afterEach(() => {
    delete process.env[ENV];
  });

  it("throws PermissionDeniedError without a network grant and makes no request", async () => {
    process.env[ENV] = "sk-secret-123";
    const calls: Captured[] = [];
    const p = createHttpImageProvider(baseConfig(capturingFetch(stubResponse({ contentType: "image/png" }), calls)));
    await expect(p.generate(req, noGrant())).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(calls).toHaveLength(0);
  });

  it("returns bytes and sends the Bearer auth header when granted", async () => {
    process.env[ENV] = "sk-secret-123";
    const calls: Captured[] = [];
    const payload = new Uint8Array([137, 80, 78, 71]);
    const p = createHttpImageProvider(baseConfig(capturingFetch(stubResponse({ contentType: "image/png", bytes: payload }), calls)));
    const out = await p.generate(req, networkPolicy());
    expect(out.mime).toBe("image/png");
    expect(Buffer.from(out.bytes)).toEqual(Buffer.from(payload));
    expect(calls[0]!.init!.headers!.authorization).toBe("Bearer sk-secret-123");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ model: "img-model", prompt: "a cat", size: "256x256" });
  });

  it("never leaks the key in a thrown error or in describe() when the server returns 401", async () => {
    const secret = "super-secret-key-xyz";
    process.env[ENV] = secret;
    const p = createHttpImageProvider(baseConfig(capturingFetch(stubResponse({ status: 401, contentType: "application/json" }), [])));
    const err = await p.generate(req, networkPolicy()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(secret);
    expect(JSON.stringify(p.describe())).not.toContain(secret);
  });

  it("refuses an http base URL via the https gate", async () => {
    process.env[ENV] = "k";
    const p = createHttpImageProvider({ baseUrl: "http://api.example.com/v1/images", model: "m", apiKeyEnv: ENV, fetch: capturingFetch(stubResponse({ contentType: "image/png" }), []) });
    await expect(p.generate(req, networkPolicy())).rejects.toThrow();
  });

  it("throws when the response exceeds maxBytes", async () => {
    process.env[ENV] = "k";
    const p = createHttpImageProvider({ ...baseConfig(capturingFetch(stubResponse({ contentType: "image/png", bytes: new Uint8Array(100) }), [])), maxBytes: 10 });
    await expect(p.generate(req, networkPolicy())).rejects.toThrow(/cap/i);
  });

  it("rejects an unapproved content-type", async () => {
    process.env[ENV] = "k";
    const p = createHttpImageProvider(baseConfig(capturingFetch(stubResponse({ contentType: "text/html", bytes: new Uint8Array([1]) }), [])));
    await expect(p.generate(req, networkPolicy())).rejects.toThrow(/content-type/i);
  });

  it("describe() reports configured only when the env key is set, and verified is always false", () => {
    const p = createHttpImageProvider(baseConfig(capturingFetch(stubResponse({}), [])));
    delete process.env[ENV];
    expect(p.describe()).toEqual({ id: "http-image", configured: false, verified: false });
    process.env[ENV] = "k";
    expect(p.describe()).toEqual({ id: "http-image", configured: true, verified: false });
  });
});

// ---------------------------------------------------------------------------
// HTTP TTS adapter (injected FetchLike, no real network).
// ---------------------------------------------------------------------------

describe("createHttpTtsProvider", () => {
  const ENV = `OCT_TEST_TTS_KEY_${process.pid}`;
  const req = { text: "hello world", voice: "alloy", format: "wav" as const };
  const baseConfig = (fetch: FetchLike) => ({ baseUrl: "https://api.example.com/v1/audio/speech", model: "tts-model", apiKeyEnv: ENV, fetch });
  afterEach(() => {
    delete process.env[ENV];
  });

  it("throws PermissionDeniedError without a network grant and makes no request", async () => {
    process.env[ENV] = "tts-secret";
    const calls: Captured[] = [];
    const p = createHttpTtsProvider(baseConfig(capturingFetch(stubResponse({ contentType: "audio/wav" }), calls)));
    await expect(p.synthesize(req, noGrant())).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(calls).toHaveLength(0);
  });

  it("sends the Bearer header and an OpenAI-speech body, returning audio bytes", async () => {
    process.env[ENV] = "tts-secret";
    const calls: Captured[] = [];
    const audio = new Uint8Array([82, 73, 70, 70]);
    const p = createHttpTtsProvider(baseConfig(capturingFetch(stubResponse({ contentType: "audio/wav", bytes: audio }), calls)));
    const out = await p.synthesize(req, networkPolicy());
    expect(out.mime).toBe("audio/wav");
    expect(Buffer.from(out.bytes)).toEqual(Buffer.from(audio));
    expect(calls[0]!.init!.headers!.authorization).toBe("Bearer tts-secret");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ model: "tts-model", input: "hello world", voice: "alloy" });
  });

  it("enforces https and validates an approved audio mime", async () => {
    process.env[ENV] = "k";
    const httpP = createHttpTtsProvider({ baseUrl: "http://api.example.com/x", model: "m", apiKeyEnv: ENV, fetch: capturingFetch(stubResponse({ contentType: "audio/wav" }), []) });
    await expect(httpP.synthesize(req, networkPolicy())).rejects.toThrow();
    const wrongMime = createHttpTtsProvider(baseConfig(capturingFetch(stubResponse({ contentType: "image/png", bytes: new Uint8Array([1]) }), [])));
    await expect(wrongMime.synthesize(req, networkPolicy())).rejects.toThrow(/content-type/i);
  });

  it("does not leak the key on a 401 and always reports verified:false", async () => {
    const secret = "tts-secret-abc";
    process.env[ENV] = secret;
    const p = createHttpTtsProvider(baseConfig(capturingFetch(stubResponse({ status: 401, contentType: "application/json" }), [])));
    const err = await p.synthesize(req, networkPolicy()).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(secret);
    expect(p.describe().verified).toBe(false);
    expect(p.describe().configured).toBe(true);
    delete process.env[ENV];
    expect(p.describe().configured).toBe(false);
  });
});
