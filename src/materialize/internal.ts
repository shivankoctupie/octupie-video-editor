/**
 * Shared, deterministic byte-handling internals for the two downloaders.
 *
 * This module is PRIVATE to `src/materialize/` (not re-exported by `index.ts`). It
 * owns the parts that must behave identically for the web and Drive paths: a
 * timeout-bounded fetch, a capped media-body read that enforces the MIME allowlist
 * and the byte cap, and a contained, no-overwrite, atomic write of the asset bytes
 * plus the two JSON sidecars. Nothing here reaches the network on its own or reads
 * an env var; it operates on values the caller already gated.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicWrite } from "../agent/audit.js";
import { assertContainedPath, assertSafeRelativePath } from "../util/paths.js";
import type { FetchInitLike, FetchLike, FetchResponseLike } from "../util/fetchLike.js";
import {
  MATERIALIZED_ASSET_FORMAT,
  parseMaterializedAsset,
  type MaterializedAssetValue,
  type RightsMetadataValue,
} from "./schemas.js";

/** 50 MiB. The default hard cap on bytes any single materialization may pull. */
export const DEFAULT_MAX_BYTES = 52_428_800;
/** Default per-request time budget. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Default cap on redirect hops for the web path. */
export const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Run one fetch bounded by a timeout. On timeout the AbortController is aborted and
 * a bounded error is thrown; the injected fetch receives the abort signal so a real
 * transport tears the socket down. The timer is always cleared.
 */
export async function fetchWithTimeout(
  fetchFn: FetchLike,
  url: string,
  init: Omit<FetchInitLike, "signal">,
  timeoutMs: number,
): Promise<FetchResponseLike> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchFn(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Extract the bare, lowercased media type from a Content-Type header value. */
export function bareMime(contentType: string | null): string {
  if (contentType === null) return "";
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Read a 2xx response body under a hard byte cap and the MIME allowlist. Rejects
 * an unapproved content-type first, then a declared Content-Length over the cap,
 * then reads the body and rejects if the actual byte length exceeds the cap. The
 * injected response only exposes `arrayBuffer()`, so the body is buffered once and
 * measured; the cap still holds, and callers pass a small cap in tests.
 */
export async function readCappedMediaBody(
  res: FetchResponseLike,
  maxBytes: number,
  approvedMime: ReadonlySet<string>,
): Promise<{ bytes: Buffer; mime: string }> {
  const mime = bareMime(res.headers.get("content-type"));
  if (!approvedMime.has(mime)) {
    throw new Error(`Refused content-type ${JSON.stringify(mime || "(none)")}: not an approved media type.`);
  }
  const declared = res.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`Declared length ${n} exceeds the ${maxBytes}-byte cap.`);
    }
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Body of ${bytes.byteLength} bytes exceeds the ${maxBytes}-byte cap.`);
  }
  return { bytes, mime };
}

export interface WriteMaterializedInput {
  bytes: Buffer;
  mime: string;
  method: "web" | "drive";
  /** Stable original source: the request URL (web) or the file id (drive). Never a token. */
  source: string;
  rights: RightsMetadataValue;
  relPath: string;
  outDir: string;
  now: Date;
}

/**
 * Hash, validate, and write the asset atomically. The relative path is proven safe
 * and contained under `outDir`; an existing asset or sidecar is never overwritten.
 * Bytes are written temp-then-rename; the rights and record sidecars go through the
 * shared atomic text writer. Returns the validated record and the absolute path.
 */
export function writeMaterializedAsset(input: WriteMaterializedInput): { record: MaterializedAssetValue; assetPath: string } {
  const safeRel = assertSafeRelativePath(input.relPath, "relPath");
  const root = resolve(input.outDir);
  const assetPath = assertContainedPath(resolve(root, safeRel), root, "asset path");
  const rightsPath = `${assetPath}.rights.json`;
  const recordPath = `${assetPath}.materialized.json`;

  for (const p of [assetPath, rightsPath, recordPath]) {
    if (existsSync(p)) {
      throw new Error(`Refusing to overwrite an existing file: ${JSON.stringify(p)}`);
    }
  }

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const candidate = {
    format: MATERIALIZED_ASSET_FORMAT,
    method: input.method,
    source: input.source,
    sha256,
    bytes: input.bytes.byteLength,
    mime: input.mime,
    rights: input.rights,
    relPath: safeRel,
    createdAt: input.now.toISOString(),
  };
  const parsed = parseMaterializedAsset(candidate);
  if (!parsed.ok || parsed.data === undefined) {
    throw new Error(`Internal: materialized record failed validation: ${parsed.errors.join("; ")}`);
  }
  const record = parsed.data;

  mkdirSync(dirname(assetPath), { recursive: true });
  const tmp = `${assetPath}.${process.pid}.tmp`;
  writeFileSync(tmp, input.bytes);
  renameSync(tmp, assetPath);

  atomicWrite(rightsPath, `${JSON.stringify(record.rights, null, 2)}\n`);
  atomicWrite(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  return { record, assetPath };
}
