/**
 * Storage adapter contract. A blob is content-addressed: its key is derived from the
 * SHA-256 of its bytes and is scoped under a tenant/project prefix, so identical bytes
 * dedupe and a stored object is immutable. Materialization always moves an already
 * hashed TEMP file into storage; the original source media is never touched or
 * overwritten. Two adapters ship: a local filesystem store (verified, offline) and an
 * S3-compatible contract adapter (config only, no credentials required at startup).
 */

export interface BlobRef {
  /** The content-addressed key, e.g. `t1/p1/media/ab/cd/<sha>.mp4`. */
  key: string;
  sha256: string;
  size: number;
  mime?: string;
}

export interface MaterializeInput {
  tenantId: string;
  projectId: string;
  /** Path to an already-hashed temporary file to move into storage. */
  tempPath: string;
  sha256: string;
  mime?: string;
  /** File extension including the leading dot (e.g. ".mp4"). */
  ext?: string;
}

export interface StorageStatus {
  id: string;
  kind: "local" | "s3";
  /** Enough configuration is present to attempt IO. */
  configured: boolean;
  /** IO has a real backing (a local dir, or an injected client). Never claims a remote
   * provider is verified without a real client. */
  available: boolean;
  detail: string;
}

export interface StorageAdapter {
  readonly id: string;
  readonly kind: "local" | "s3";
  describe(): StorageStatus;
  materialize(input: MaterializeInput): Promise<BlobRef>;
  has(key: string): Promise<boolean>;
  read(key: string): Promise<Buffer>;
  /** A filesystem path for local adapters, or null for remote adapters. */
  localPath(key: string): string | null;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Reject a tenant/project id that is not a single safe path segment. */
export function assertSafeSegment(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 96 || !SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Build the content-addressed key for a blob under its tenant/project prefix. */
export function contentKey(tenantId: string, projectId: string, sha256: string, ext = ""): string {
  assertSafeSegment(tenantId, "tenantId");
  assertSafeSegment(projectId, "projectId");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("sha256 must be a 64-char lowercase hex digest");
  const safeExt = ext && /^\.[A-Za-z0-9]{1,12}$/.test(ext) ? ext : "";
  return `${tenantId}/${projectId}/media/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}${safeExt}`;
}
