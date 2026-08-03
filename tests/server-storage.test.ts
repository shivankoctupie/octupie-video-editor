import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalStorage } from "../src/server/storage/local.js";
import { createS3Storage } from "../src/server/storage/s3.js";

const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), "oct-storage-"));
  roots.push(root);
  return root;
}
function writeTemp(dir: string, name: string, bytes: Buffer): { path: string; sha: string } {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  return { path, sha };
}

describe("local content-addressed storage", () => {
  it("materializes a temp file into a tenant/project content-addressed path", async () => {
    const root = tmp();
    const work = tmp();
    const store = createLocalStorage(root);
    const bytes = Buffer.from("hello media bytes");
    const { path, sha } = writeTemp(work, "upload.tmp", bytes);
    const ref = await store.materialize({ tenantId: "t1", projectId: "p1", tempPath: path, sha256: sha, mime: "video/mp4", ext: ".mp4" });
    expect(ref.sha256).toBe(sha);
    expect(ref.size).toBe(bytes.length);
    expect(ref.key).toContain("t1/p1/media/");
    expect(ref.key).toContain(sha);
    const lp = store.localPath(ref.key)!;
    expect(existsSync(lp)).toBe(true);
    expect(readFileSync(lp)).toEqual(bytes);
    expect(await store.has(ref.key)).toBe(true);
    expect(await store.read(ref.key)).toEqual(bytes);
  });

  it("is idempotent for identical content and never overwrites", async () => {
    const root = tmp();
    const work = tmp();
    const store = createLocalStorage(root);
    const bytes = Buffer.from("same bytes");
    const a = writeTemp(work, "a.tmp", bytes);
    const b = writeTemp(work, "b.tmp", bytes);
    const r1 = await store.materialize({ tenantId: "t1", projectId: "p1", tempPath: a.path, sha256: a.sha, ext: ".bin" });
    const r2 = await store.materialize({ tenantId: "t1", projectId: "p1", tempPath: b.path, sha256: b.sha, ext: ".bin" });
    expect(r1.key).toBe(r2.key);
  });

  it("rejects unsafe tenant/project ids and traversal keys", async () => {
    const root = tmp();
    const work = tmp();
    const store = createLocalStorage(root);
    const { path, sha } = writeTemp(work, "x.tmp", Buffer.from("x"));
    await expect(store.materialize({ tenantId: "../evil", projectId: "p1", tempPath: path, sha256: sha })).rejects.toThrow();
    await expect(store.read("../../etc/passwd")).rejects.toThrow();
    expect(store.localPath("../../etc/passwd")).toBeNull();
  });

  it("describes itself as an available local adapter", () => {
    const d = createLocalStorage(tmp()).describe();
    expect(d.kind).toBe("local");
    expect(d.available).toBe(true);
    expect(d.configured).toBe(true);
  });
});

describe("s3 contract/config storage adapter", () => {
  it("never reads credentials at construction and reports configured but unavailable without a client", () => {
    // Point at an unset env var name; construction must not throw or read it.
    const store = createS3Storage({ bucket: "octupie-media", region: "us-east-1", prefix: "prod", accessKeyIdEnv: "OVE_TEST_UNSET_KEY", secretAccessKeyEnv: "OVE_TEST_UNSET_SECRET" });
    const d = store.describe();
    expect(d.kind).toBe("s3");
    expect(d.configured).toBe(true);
    expect(d.available).toBe(false);
    expect(d.detail).not.toContain("OVE_TEST_UNSET");
  });

  it("computes an object key with the prefix and refuses IO without a client", async () => {
    const store = createS3Storage({ bucket: "b", region: "r", prefix: "media" });
    expect(store.objectKeyFor("t1/p1/media/ab/cd/deadbeef.mp4")).toBe("media/t1/p1/media/ab/cd/deadbeef.mp4");
    await expect(store.read("t1/p1/media/ab/cd/deadbeef.mp4")).rejects.toThrow(/not available|no client|unavailable/i);
  });

  it("uses an injected S3-like client when one is provided and never exposes secrets", async () => {
    const puts: Array<{ key: string; size: number }> = [];
    const store = createS3Storage(
      { bucket: "b", region: "r", prefix: "media" },
      {
        async putObject(key: string, body: Uint8Array) {
          puts.push({ key, size: body.length });
        },
        async headObject() {
          return false;
        },
        async getObject() {
          return Buffer.from("remote-bytes");
        },
      },
    );
    const work = tmp();
    const { path, sha } = writeTemp(work, "u.tmp", Buffer.from("remote-bytes"));
    const ref = await store.materialize({ tenantId: "t1", projectId: "p1", tempPath: path, sha256: sha, ext: ".bin" });
    expect(ref.key).toContain("t1/p1/media/");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toContain("media/t1/p1/media/");
    expect(store.describe().available).toBe(true);
  });
});
