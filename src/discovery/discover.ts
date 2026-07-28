/**
 * Rights-safe asset discovery orchestrator (parity phase 4).
 *
 * Combines the requested sources into one deterministic, rights-cleared result:
 *
 *   1. validate the query (strict, bounded).
 *   2. permission: local is offline and needs no policy. If ANY remote source
 *      (drive or web) is requested, a `network` grant is required and is checked
 *      HERE, before any provider is called; with no grant the whole operation is
 *      denied before a single provider runs. No bytes ever move in discovery.
 *   3. run each requested provider, preserving a provider's failure as a
 *      diagnostic instead of silently turning it into a candidate.
 *   4. filter rights: only `permissive` and `local-owner` candidates survive;
 *      everything else is dropped with a diagnostic.
 *   5. de-duplicate stable refs (source + ref), keeping the higher relevance.
 *   6. sort deterministically by relevance, then source, then ref.
 *   7. truncate to the query's maxResults.
 *
 * Nothing a provider returns is executed. The result is references and rights
 * metadata; a human still clears and supplies any asset before it is used.
 */

import { requireGrant, type PermissionPolicy, createPolicy } from "../permissions/policy.js";
import {
  filterTrustedCandidates,
  parseAssetDiscoveryQuery,
  type AssetCandidateValue,
  type AssetDiscoveryQueryValue,
  type AssetSourceKind,
  type DiscoveryDiagnosticValue,
} from "./schemas.js";
import { discoverLocalAssets, type DiscoveryFs } from "./local.js";
import type { RemoteDiscoveryProvider } from "./providers.js";

export interface DiscoverAssetsInput {
  /** The discovery query. Re-validated here regardless of caller. */
  query: AssetDiscoveryQueryValue;
  /** Grants. Local-only discovery works with no policy; remote requires `network`. */
  permissionPolicy?: PermissionPolicy;
  /** Absolute asset root for local discovery. */
  assetRoot: string;
  now?: Date;

  // Injectable providers/steps (real defaults below).
  localDiscover?: typeof discoverLocalAssets;
  drive?: RemoteDiscoveryProvider;
  web?: RemoteDiscoveryProvider;
  localFs?: DiscoveryFs;
  localMaxDepth?: number;
  localMaxFiles?: number;
}

export interface DiscoverAssetsResult {
  candidates: AssetCandidateValue[];
  diagnostics: DiscoveryDiagnosticValue[];
  sourcesQueried: AssetSourceKind[];
}

const REMOTE_SOURCES: readonly AssetSourceKind[] = ["drive", "web"];

/** Run one rights-safe discovery across the requested sources. */
export async function discoverAssets(input: DiscoverAssetsInput): Promise<DiscoverAssetsResult> {
  const parsed = parseAssetDiscoveryQuery(input.query);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`Invalid discovery query: ${parsed.errors.join("; ")}`);
  }
  const query = parsed.data;
  const sources = uniqueSources(query.sources);
  const now = input.now ?? new Date();
  const policy = input.permissionPolicy ?? createPolicy([]);

  // Permission gate BEFORE any provider call. Remote sources require `network`.
  const wantsRemote = sources.some((s) => REMOTE_SOURCES.includes(s));
  if (wantsRemote) {
    requireGrant("network", policy, now); // throws PermissionDeniedError with no grant.
  }

  const diagnostics: DiscoveryDiagnosticValue[] = [];
  const raw: AssetCandidateValue[] = [];

  for (const source of sources) {
    if (source === "local") {
      const localDiscover = input.localDiscover ?? discoverLocalAssets;
      try {
        const res = localDiscover({
          query,
          root: input.assetRoot,
          now,
          ...(input.localFs ? { fs: input.localFs } : {}),
          ...(input.localMaxDepth !== undefined ? { maxDepth: input.localMaxDepth } : {}),
          ...(input.localMaxFiles !== undefined ? { maxFiles: input.localMaxFiles } : {}),
        });
        raw.push(...res.candidates);
        diagnostics.push(...res.diagnostics);
      } catch (err) {
        diagnostics.push({ source: "local", level: "error", message: `Local discovery failed: ${err instanceof Error ? err.message : String(err)}` });
      }
      continue;
    }

    const provider = source === "drive" ? input.drive : input.web;
    if (!provider) {
      diagnostics.push({ source, level: "info", message: `No ${source} provider is wired; skipping.` });
      continue;
    }
    try {
      const res = await provider.discover({ intent: query.intent, maxResults: query.maxResults, timeoutMs: 20_000 });
      raw.push(...res.candidates);
      diagnostics.push(...res.diagnostics);
    } catch (err) {
      // Preserve provider errors as diagnostics; never fabricate a candidate.
      diagnostics.push({ source, level: "error", message: `${source} provider failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Rights gate: only permissive/local-owner survive.
  const { trusted, diagnostics: rightsDiags } = filterTrustedCandidates(raw);
  diagnostics.push(...rightsDiags);

  // De-duplicate stable refs, keeping the higher-relevance entry.
  const byKey = new Map<string, AssetCandidateValue>();
  for (const c of trusted) {
    const key = `${c.source}\u0000${c.ref}`;
    const existing = byKey.get(key);
    if (!existing || c.relevance > existing.relevance) byKey.set(key, c);
  }
  const deduped = [...byKey.values()];

  // Deterministic order: relevance desc, source asc, ref asc.
  deduped.sort(
    (a, b) =>
      b.relevance - a.relevance ||
      (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
      (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
  );

  return {
    candidates: deduped.slice(0, query.maxResults),
    diagnostics,
    sourcesQueried: sources,
  };
}

function uniqueSources(sources: readonly AssetSourceKind[]): AssetSourceKind[] {
  const seen = new Set<AssetSourceKind>();
  const out: AssetSourceKind[] = [];
  for (const s of sources) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}
