/**
 * S3-compatible contract/config adapter.
 *
 * This adapter validates configuration and computes the exact object keys it WOULD use,
 * but performs no network IO and reads no credentials at startup. Without an injected
 * client it reports `available: false` and refuses IO, so the product never pretends a
 * remote provider is verified when it is not. When a caller injects a real S3-like
 * client (its own credential handling, kept out of this module), the adapter becomes
 * available. Credentials are only ever read by the injected client at request time; the
 * env var NAMES are recorded, the values never are, and no secret appears in `describe`.
 */

import { readFileSync } from "node:fs";
import { assertSafeSegment, contentKey, type BlobRef, type MaterializeInput, type StorageAdapter, type StorageStatus } from "./adapter.js";

export interface S3Config {
  bucket?: string;
  region?: string;
  /** Optional key prefix inside the bucket, e.g. "prod/media". */
  prefix?: string;
  /** Optional S3-compatible endpoint (MinIO, R2, etc.). */
  endpoint?: string;
  /** The NAME of the env var holding the access key id. The value is never read here. */
  accessKeyIdEnv?: string;
  /** The NAME of the env var holding the secret. The value is never read here. */
  secretAccessKeyEnv?: string;
}

/** The minimal client an operator injects to enable real IO. Its implementation owns all
 * credential handling; this module never sees a secret. */
export interface S3Client {
  putObject(key: string, body: Uint8Array, mime?: string): Promise<void>;
  headObject(key: string): Promise<boolean>;
  getObject(key: string): Promise<Buffer>;
}

export class S3Storage implements StorageAdapter {
  readonly id: string;
  readonly kind = "s3" as const;
  private readonly config: S3Config;
  private readonly client: S3Client | null;

  constructor(config: S3Config, client: S3Client | null = null, id = "s3") {
    this.config = { ...config };
    this.client = client;
    this.id = id;
  }

  private get configured(): boolean {
    return Boolean(this.config.bucket && this.config.region);
  }

  describe(): StorageStatus {
    const available = this.configured && this.client !== null;
    const detail = this.client
      ? `S3 adapter with an injected client (bucket ${this.config.bucket ?? "?"}, region ${this.config.region ?? "?"}).`
      : this.configured
        ? "S3 adapter is configured but has no injected client; IO is unavailable and unverified."
        : "S3 adapter is not configured (bucket and region are required).";
    return { id: this.id, kind: this.kind, configured: this.configured, available, detail };
  }

  /** The full object key including the optional bucket prefix. */
  objectKeyFor(key: string): string {
    const prefix = this.config.prefix ? this.config.prefix.replace(/^\/+|\/+$/g, "") : "";
    return prefix ? `${prefix}/${key}` : key;
  }

  private requireClient(): S3Client {
    if (!this.configured) throw new Error("S3 adapter is not configured; set bucket and region.");
    if (!this.client) throw new Error("S3 adapter has no client; IO is not available (configured but unverified).");
    return this.client;
  }

  localPath(): string | null {
    return null;
  }

  async materialize(input: MaterializeInput): Promise<BlobRef> {
    const client = this.requireClient();
    assertSafeSegment(input.tenantId, "tenantId");
    assertSafeSegment(input.projectId, "projectId");
    const key = contentKey(input.tenantId, input.projectId, input.sha256, input.ext);
    const body = readFileSync(input.tempPath);
    if (!(await client.headObject(this.objectKeyFor(key)))) {
      await client.putObject(this.objectKeyFor(key), body, input.mime);
    }
    return { key, sha256: input.sha256, size: body.length, ...(input.mime ? { mime: input.mime } : {}) };
  }

  async has(key: string): Promise<boolean> {
    const client = this.requireClient();
    return client.headObject(this.objectKeyFor(key));
  }

  async read(key: string): Promise<Buffer> {
    const client = this.requireClient();
    return client.getObject(this.objectKeyFor(key));
  }
}

export function createS3Storage(config: S3Config, client: S3Client | null = null, id = "s3"): S3Storage {
  return new S3Storage(config, client, id);
}
