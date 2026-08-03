/**
 * Runtime-validated schemas for controlled asset MATERIALIZATION (parity phase 9).
 *
 * Materialization is the ONLY path that pulls real bytes onto disk, and it does so
 * only behind an explicit `media-upload` grant, an SSRF-checked transport, and hard
 * byte, type, and time caps. This module is the trust boundary for that path. Two
 * rules are enforced structurally, not by convention:
 *
 *   1. Strict, bounded objects: an unknown field is rejected and every string is
 *      length-capped, so a hostile rights blob can neither smuggle an extra field
 *      nor exhaust memory.
 *   2. Rights before bytes, fail closed: `reusable` is `z.literal(true)`. Any rights
 *      object that omits it, sets it false, or sets it to a non-true value FAILS to
 *      parse, so nothing is ever downloaded on unknown or missing reuse rights.
 *      Public availability is not permission.
 *
 * Nothing here reaches the network, reads an env var, or writes a file; it only
 * proves an artifact is well-formed. The downloaders (`web.ts`, `drive.ts`) own the
 * gates, transport, and atomic writes.
 */

import { z } from "zod";

export const MATERIALIZED_ASSET_FORMAT = "octupie-materialized-asset/v1";

/** Hard caps. */
export const MAX_LICENSE = 200;
export const MAX_ATTRIBUTION = 500;
export const MAX_SOURCE = 2048;
export const MAX_NOTE = 2000;
export const MAX_MIME = 255;
export const MAX_REL_PATH = 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The exact set of media MIME types the downloaders will accept. Anything else is
 * refused before a byte is written. Exported so callers can widen it deliberately
 * (never silently) by passing an explicit `approvedMime` set.
 *
 * `image/svg+xml` is deliberately EXCLUDED. An SVG is an active document: fetched from
 * an attacker-controlled URL and later opened same-origin it can run script and read the
 * session token (stored XSS). Raster images, video, and audio are inert. Locally
 * generated proof-card SVGs use a separate, deterministic path (see
 * `generation/contracts.ts`) and are served only as sandboxed, non-inline attachments.
 */
export const APPROVED_MEDIA_MIME: ReadonlySet<string> = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
]);

/**
 * Required reusable-rights metadata. `reusable` is `z.literal(true)`: a rights blob
 * that omits it, or sets it to `false` (or any non-true value), fails to parse, so
 * materialization fails closed on unknown or missing rights.
 */
export const rightsMetadataSchema = z
  .object({
    license: z.string().trim().min(1, "a license id is required").max(MAX_LICENSE),
    attribution: z.string().max(MAX_ATTRIBUTION),
    reusable: z.literal(true),
    source: z.string().trim().min(1, "a rights source is required").max(MAX_SOURCE),
    note: z.string().max(MAX_NOTE).optional(),
  })
  .strict();
export type RightsMetadataValue = z.infer<typeof rightsMetadataSchema>;

/**
 * The record written beside every materialized asset. `sha256` is computed by the
 * downloader over the real received bytes; a caller never supplies it. It carries
 * no access token and no transient redirect URL, only the stable original source.
 */
export const materializedAssetSchema = z
  .object({
    format: z.literal(MATERIALIZED_ASSET_FORMAT),
    method: z.enum(["web", "drive"]),
    source: z.string().min(1).max(MAX_SOURCE),
    sha256: z.string().regex(SHA256_HEX, "sha256 must be a 64-char lowercase hex digest"),
    bytes: z.number().int().min(0),
    mime: z.string().trim().min(1).max(MAX_MIME),
    rights: rightsMetadataSchema,
    relPath: z.string().min(1).max(MAX_REL_PATH),
    createdAt: z.string().min(1),
  })
  .strict();
export type MaterializedAssetValue = z.infer<typeof materializedAssetSchema>;

// ---------------------------------------------------------------------------
// Parse helpers (mirror the discovery/workflow ParseResult contract).
// ---------------------------------------------------------------------------

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

function parseWith<T>(schema: z.ZodType<T>, json: unknown): ParseResult<T> {
  const r = schema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

/** Parse reusable-rights metadata. Fails closed unless `reusable` is exactly `true`. */
export const parseRights = (json: unknown): ParseResult<RightsMetadataValue> => parseWith(rightsMetadataSchema, json);

export const parseMaterializedAsset = (json: unknown): ParseResult<MaterializedAssetValue> => parseWith(materializedAssetSchema, json);
