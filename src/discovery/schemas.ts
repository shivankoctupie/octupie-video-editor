/**
 * Runtime-validated schemas for rights-safe asset discovery (parity phase 4).
 *
 * These schemas are the trust boundary for everything the local, Drive, and web
 * discovery providers return. Discovery returns REFERENCES and rights metadata,
 * never unlicensed bytes. Every candidate must carry an explicit license id, its
 * rights status, provenance, and attribution data before the engine will trust
 * it. Two rules are enforced structurally, not by convention:
 *
 *   1. Strict objects: an unknown field is rejected, so a provider can never
 *      smuggle an extra flag past the boundary.
 *   2. Rights before trust: a candidate whose rights status is not
 *      `permissive` or `local-owner` is filtered out of the trusted result set.
 *      Public availability is not reuse permission; only cleared references pass.
 *
 * Nothing here is executed. A candidate is data the planner may consider; a human
 * still signs off, and bytes only ever move through a separate, media-upload
 * gated materialize path, never during discovery.
 */

import { z } from "zod";
import { isSafeRelativePath } from "../util/paths.js";

/** Where a candidate was found. Local is offline; drive and web need a network grant. */
export const ASSET_SOURCE_KINDS = ["local", "drive", "web"] as const;
export type AssetSourceKind = (typeof ASSET_SOURCE_KINDS)[number];

/** Coarse media kind, derived from the reference and confirmed by rights metadata. */
export const MEDIA_KINDS = ["video", "image", "audio", "font", "other"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Provenance mirrors the ledger in `ASSET_POLICY.md`: how the asset came to exist.
 * A filename never establishes provenance; only explicit rights metadata does.
 */
export const PROVENANCE_KINDS = [
  "coded",
  "procedural",
  "model-generated",
  "user-supplied",
  "licensed-source",
] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/**
 * Rights status is the single trust gate. Only `permissive` (a verified
 * permissive license) and `local-owner` (the operator owns the asset) are
 * trusted; `unknown` and `restricted` are always rejected from results.
 */
export const RIGHTS_STATUSES = ["permissive", "local-owner", "unknown", "restricted"] as const;
export type RightsStatus = (typeof RIGHTS_STATUSES)[number];

/** Rights statuses the engine will return in a trusted result set. */
export const TRUSTED_RIGHTS_STATUSES: readonly RightsStatus[] = ["permissive", "local-owner"];

export function isTrustedRightsStatus(status: RightsStatus): boolean {
  return TRUSTED_RIGHTS_STATUSES.includes(status);
}

/** Hard cap on how many candidates a single query may ask for. */
export const MAX_DISCOVERY_RESULTS = 200;

const unitInterval = z.number().min(0).max(1);

/** Only http(s) references are ever accepted for a remote candidate. */
export function isAllowedRemoteUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" || url.protocol === "http:";
}

/**
 * The license block. `id` is required and must be a concrete identifier (a SPDX
 * id, a marketplace license code, or `local-owner`); it is never `unknown` or
 * empty. `url` is optional and, when present, must be an http(s) link. When
 * attribution is required, the attribution text must be supplied.
 */
export const licenseSchema = z
  .object({
    id: z.string().trim().min(1, "a license id is required"),
    url: z.string().refine(isAllowedRemoteUrl, "license url must be an http(s) link").optional(),
    attributionRequired: z.boolean(),
    attributionText: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (l.attributionRequired && (l.attributionText === undefined || l.attributionText.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attributionText is required when attributionRequired is true",
        path: ["attributionText"],
      });
    }
  });
export type LicenseValue = z.infer<typeof licenseSchema>;

/** Validate a candidate `ref` for its source: relative-safe for local, http(s) for remote. */
function refValidForSource(ref: string, source: AssetSourceKind): boolean {
  if (source === "local") return isSafeRelativePath(ref);
  return isAllowedRemoteUrl(ref);
}

/**
 * One discovered candidate. STRICT: any unknown field is rejected. Every trust
 * field is mandatory so a candidate can never reach a plan without stated rights.
 */
export const assetCandidateSchema = z
  .object({
    source: z.enum(ASSET_SOURCE_KINDS),
    /** For local: a portable relative path. For remote: an http(s) reference, not bytes. */
    ref: z.string().min(1),
    title: z.string().min(1),
    relevance: unitInterval,
    mediaKind: z.enum(MEDIA_KINDS),
    /** Why this asset matches the intent or claim, in plain language. Never empty. */
    intentMatch: z.string().min(1, "a candidate must state how it matches the intent"),
    provenance: z.enum(PROVENANCE_KINDS),
    license: licenseSchema,
    rightsStatus: z.enum(RIGHTS_STATUSES),
    /** ISO-8601 retrieval timestamp, stamped by the engine, not the provider. */
    retrievedAt: z.string().min(1),
    /** True only when the bytes already live on local disk; remote refs are never local. */
    bytesLocal: z.boolean(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (!refValidForSource(c.ref, c.source)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          c.source === "local"
            ? "a local candidate ref must be a portable relative path (no drive letter, absolute root, or '..')"
            : "a remote candidate ref must be an http(s) reference",
        path: ["ref"],
      });
    }
    if (c.source !== "local" && c.bytesLocal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a remote candidate can never report bytesLocal true; discovery returns references only",
        path: ["bytesLocal"],
      });
    }
  });
export type AssetCandidateValue = z.infer<typeof assetCandidateSchema>;

/** A discovery query. STRICT and bounded: sources must be non-empty and maxResults capped. */
export const assetDiscoveryQuerySchema = z
  .object({
    intent: z.string().min(1, "an intent is required"),
    sources: z.array(z.enum(ASSET_SOURCE_KINDS)).min(1, "at least one source is required"),
    maxResults: z.number().int().min(1).max(MAX_DISCOVERY_RESULTS),
  })
  .strict();
export type AssetDiscoveryQueryValue = z.infer<typeof assetDiscoveryQuerySchema>;

/** A non-fatal provider observation, preserved instead of being turned into a candidate. */
export const DISCOVERY_DIAGNOSTIC_LEVELS = ["info", "warn", "error"] as const;
export type DiscoveryDiagnosticLevel = (typeof DISCOVERY_DIAGNOSTIC_LEVELS)[number];

export const discoveryDiagnosticSchema = z
  .object({
    source: z.enum(ASSET_SOURCE_KINDS),
    level: z.enum(DISCOVERY_DIAGNOSTIC_LEVELS),
    message: z.string().min(1),
  })
  .strict();
export type DiscoveryDiagnosticValue = z.infer<typeof discoveryDiagnosticSchema>;

/**
 * Rights sidecar shape for a local asset. A local asset is only trusted when a
 * validated sidecar states its rights. The engine never infers a permissive
 * license from a filename, so a missing or invalid sidecar means "no rights".
 */
export const rightsSidecarSchema = z
  .object({
    licenseId: z.string().trim().min(1),
    licenseUrl: z.string().refine(isAllowedRemoteUrl, "license url must be an http(s) link").optional(),
    attributionRequired: z.boolean(),
    attributionText: z.string().min(1).optional(),
    rightsStatus: z.enum(RIGHTS_STATUSES),
    provenance: z.enum(PROVENANCE_KINDS),
    /** Optional human title; the filename is used when absent. */
    title: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.attributionRequired && (s.attributionText === undefined || s.attributionText.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attributionText is required when attributionRequired is true",
        path: ["attributionText"],
      });
    }
  });
export type RightsSidecarValue = z.infer<typeof rightsSidecarSchema>;

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

export function parseAssetDiscoveryQuery(json: unknown): ParseResult<AssetDiscoveryQueryValue> {
  const r = assetDiscoveryQuerySchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

export function parseAssetCandidate(json: unknown): ParseResult<AssetCandidateValue> {
  const r = assetCandidateSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

export function parseRightsSidecar(json: unknown): ParseResult<RightsSidecarValue> {
  const r = rightsSidecarSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

/**
 * Keep only candidates whose rights status is trusted (`permissive` or
 * `local-owner`) and whose license id is concrete. Rejected candidates are
 * reported as diagnostics, never silently dropped and never returned. This is
 * the single rights gate every result passes through before return.
 */
export function filterTrustedCandidates(
  candidates: readonly AssetCandidateValue[],
): { trusted: AssetCandidateValue[]; diagnostics: DiscoveryDiagnosticValue[] } {
  const trusted: AssetCandidateValue[] = [];
  const diagnostics: DiscoveryDiagnosticValue[] = [];
  for (const c of candidates) {
    const licenseUnknown = c.license.id.trim().toLowerCase() === "unknown";
    if (!isTrustedRightsStatus(c.rightsStatus) || licenseUnknown) {
      diagnostics.push({
        source: c.source,
        level: "warn",
        message: `Dropped '${c.title}' (${c.ref}): rights status '${c.rightsStatus}', license '${c.license.id}' is not cleared for reuse.`,
      });
      continue;
    }
    trusted.push(c);
  }
  return { trusted, diagnostics };
}
