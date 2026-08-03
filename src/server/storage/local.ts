/**
 * Local content-addressed storage. Blobs live under `<root>/<tenant>/<project>/media/`
 * in a two-level sharded layout keyed by SHA-256. Materialization renames the temp file
 * into place atomically (with a cross-device copy fallback); if the key already exists
 * the call is a no-op, so identical content is never rewritten and source media is never
 * overwritten. Every key is checked for containment under the root before any IO.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertContainedPath } from "../../util/paths.js";
import { assertSafeSegment, contentKey, type BlobRef, type MaterializeInput, type StorageAdapter, type StorageStatus } from "./adapter.js";

export class LocalStorage implements StorageAdapter {
  readonly id: string;
  readonly kind = "local" as const;
  private readonly root: string;

  constructor(root: string, id = "local") {
    this.root = resolve(root);
    this.id = id;
  }

  describe(): StorageStatus {
    return { id: this.id, kind: this.kind, configured: true, available: true, detail: `Local content-addressed store at ${this.root}` };
  }

  /** Resolve a key to an absolute path, refusing any key that escapes the root. */
  private absOf(key: string): string {
    const abs = resolve(this.root, key);
    assertContainedPath(abs, this.root, "storage key");
    return abs;
  }

  localPath(key: string): string | null {
    try {
      return this.absOf(key);
    } catch {
      return null;
    }
  }

  async materialize(input: MaterializeInput): Promise<BlobRef> {
    assertSafeSegment(input.tenantId, "tenantId");
    assertSafeSegment(input.projectId, "projectId");
    const key = contentKey(input.tenantId, input.projectId, input.sha256, input.ext);
    const dest = this.absOf(key);
    if (existsSync(dest)) {
      const size = statSync(dest).size;
      // Remove the redundant temp file; the canonical copy already exists.
      try {
        unlinkSync(input.tempPath);
      } catch {
        /* the temp file may already be gone; ignore */
      }
      return { key, sha256: input.sha256, size, ...(input.mime ? { mime: input.mime } : {}) };
    }
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(input.tempPath, dest);
    } catch {
      // Cross-device rename is not allowed; copy then remove the source temp file.
      copyFileSync(input.tempPath, dest);
      try {
        unlinkSync(input.tempPath);
      } catch {
        /* ignore */
      }
    }
    const size = statSync(dest).size;
    return { key, sha256: input.sha256, size, ...(input.mime ? { mime: input.mime } : {}) };
  }

  async has(key: string): Promise<boolean> {
    const abs = this.localPath(key);
    return abs !== null && existsSync(abs);
  }

  async read(key: string): Promise<Buffer> {
    const abs = this.absOf(key);
    return readFileSync(abs);
  }
}

export function createLocalStorage(root: string, id = "local"): LocalStorage {
  return new LocalStorage(root, id);
}
