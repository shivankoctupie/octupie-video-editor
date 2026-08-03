import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AuthRegistry, sha256Hex } from "../src/server/auth.js";
import { resolveUploadType, streamToTempFile, UploadError } from "../src/server/upload.js";

const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "oct-upload-"));
  roots.push(d);
  return d;
}

describe("AuthRegistry", () => {
  const users = [
    { id: "u1", tenantId: "t1", username: "ed", role: "editor" as const, token: "editor-token-abcdef1234567890" },
    { id: "u2", tenantId: "t1", username: "ap", role: "approver" as const, token: "approver-token-abcdefghijklmnop" },
  ];

  it("authenticates a valid bearer token to its principal", () => {
    const reg = new AuthRegistry(users);
    const p = reg.authenticate("editor-token-abcdef1234567890");
    expect(p?.userId).toBe("u1");
    expect(p?.role).toBe("editor");
    expect(p?.tenantId).toBe("t1");
  });

  it("rejects a wrong, empty, or undefined token without throwing", () => {
    const reg = new AuthRegistry(users);
    expect(reg.authenticate("nope-nope-nope-nope-nope-nope")).toBeNull();
    expect(reg.authenticate("")).toBeNull();
    expect(reg.authenticate(undefined)).toBeNull();
  });

  it("refuses to build with a weak or duplicate token", () => {
    expect(() => new AuthRegistry([{ id: "u", tenantId: "t", username: "x", role: "viewer", token: "short" }])).toThrow();
    expect(
      () =>
        new AuthRegistry([
          { id: "a", tenantId: "t", username: "a", role: "viewer", token: "same-token-abcdef1234567890" },
          { id: "b", tenantId: "t", username: "b", role: "editor", token: "same-token-abcdef1234567890" },
        ]),
    ).toThrow();
  });

  it("does not expose raw tokens on its principals", () => {
    const reg = new AuthRegistry(users);
    const serialized = JSON.stringify(reg.principals());
    expect(serialized).not.toContain("editor-token");
    expect(sha256Hex("editor-token-abcdef1234567890")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("resolveUploadType", () => {
  it("accepts an allowlisted media type and returns its extension", () => {
    expect(resolveUploadType("video/mp4", "clip.mp4")).toEqual({ mime: "video/mp4", ext: ".mp4" });
    expect(resolveUploadType("image/png", "still.png").ext).toBe(".png");
  });
  it("rejects a disallowed type", () => {
    expect(() => resolveUploadType("application/x-msdownload", "evil.exe")).toThrow(UploadError);
    expect(() => resolveUploadType("text/html", "x.html")).toThrow(UploadError);
  });
  it("rejects a filename with a path separator or traversal", () => {
    expect(() => resolveUploadType("video/mp4", "../escape.mp4")).toThrow(UploadError);
    expect(() => resolveUploadType("video/mp4", "a/b.mp4")).toThrow(UploadError);
    expect(() => resolveUploadType("video/mp4", "x\0.mp4")).toThrow(UploadError);
  });
});

describe("streamToTempFile", () => {
  it("streams to a temp file, hashes the bytes, and reports the size", async () => {
    const dir = tmp();
    const bytes = Buffer.from("some streamed media payload");
    const out = await streamToTempFile(Readable.from([bytes]), { tempDir: dir, maxBytes: 1024 });
    expect(existsSync(out.tempPath)).toBe(true);
    expect(out.size).toBe(bytes.length);
    expect(out.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(out.tempPath)).toEqual(bytes);
  });

  it("aborts and cleans up when the byte cap is exceeded", async () => {
    const dir = tmp();
    const big = Buffer.alloc(4096, 7);
    await expect(streamToTempFile(Readable.from([big]), { tempDir: dir, maxBytes: 1024 })).rejects.toThrow(UploadError);
    // No leftover temp file remains.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
