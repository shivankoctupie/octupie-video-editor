/**
 * Optional Drive and web reference providers for asset discovery (parity phase 4).
 *
 * These providers return REFERENCES and rights metadata only. They never scrape
 * and never download during discovery. The rules are enforced structurally:
 *
 *   - a network grant is required before invocation; the orchestrator checks it
 *     before it ever calls a remote provider, so `discover` is only reached with
 *     the grant already held;
 *   - byte transfer is a SEPARATE method (`materialize`) behind its own explicit
 *     `media-upload` grant and an injected transport; with no transport it
 *     refuses, so nothing can move bytes through the discovery path;
 *   - adapters are injectable and data-only: bounded result counts, http(s)-only
 *     reference validation, a timeout and output cap on any process, and JSON
 *     parsing with no execution of anything a provider returns;
 *   - no Hermes or private credential store is read here; a concrete Drive
 *     adapter runs an operator-supplied binary through the existing bounded,
 *     argument-array, shell:false runner, and its auth is external to the engine.
 *
 * Absent a configured adapter, a provider is truthfully "not configured": it
 * returns a diagnostic and zero candidates. It is never a fake that invents
 * results.
 */

import { execProcess, type ExecFn } from "../agent/exec.js";
import { requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import type { PermissionAction } from "../permissions/policy.js";
import {
  isAllowedRemoteUrl,
  parseAssetCandidate,
  type AssetCandidateValue,
  type AssetSourceKind,
  type DiscoveryDiagnosticValue,
  type MediaKind,
  type ProvenanceKind,
  type RightsStatus,
} from "./schemas.js";

/** A raw, untrusted row an adapter returns. The engine stamps identity and validates it. */
export interface RemoteReferenceRow {
  /** An http(s) reference. Anything else is rejected. */
  ref: string;
  title: string;
  mediaKind?: MediaKind;
  relevance?: number;
  intentMatch?: string;
  provenance?: ProvenanceKind;
  license?: { id: string; url?: string; attributionRequired: boolean; attributionText?: string };
  rightsStatus?: RightsStatus;
}

export interface RemoteAdapterContext {
  intent: string;
  maxResults: number;
  timeoutMs: number;
}

export interface RemoteAdapterResult {
  rows: RemoteReferenceRow[];
  diagnostics?: Array<{ level: DiscoveryDiagnosticValue["level"]; message: string }>;
}

/** A data-only reference source. It returns rows; it never transfers bytes. */
export type RemoteDiscoveryAdapter = (ctx: RemoteAdapterContext) => Promise<RemoteAdapterResult>;

/** The distinct, media-upload gated byte-transfer surface. Never called in discovery. */
export type MediaTransport = (candidate: AssetCandidateValue) => Promise<{ localRef: string }>;

export interface RemoteDiscoveryProvider {
  readonly kind: AssetSourceKind;
  readonly requiresPermissions: readonly PermissionAction[];
  readonly configured: boolean;
  discover(ctx: RemoteAdapterContext): Promise<{ candidates: AssetCandidateValue[]; diagnostics: DiscoveryDiagnosticValue[] }>;
  /**
   * Pull the actual bytes for a candidate. Requires a held `media-upload` grant
   * and a configured transport. This is the ONLY place bytes move, and it is
   * never reached by discovery.
   */
  materialize(candidate: AssetCandidateValue, policy: PermissionPolicy, now?: Date): Promise<{ localRef: string }>;
}

export interface RemoteProviderOptions {
  /** Data-only reference adapter. Absent means "not configured": zero candidates. */
  adapter?: RemoteDiscoveryAdapter;
  /** Byte transport for materialize. Absent means materialize refuses even with a grant. */
  transport?: MediaTransport;
  /** Timeout handed to the adapter. */
  timeoutMs?: number;
  /** Hard cap on rows accepted from the adapter, independent of query maxResults. */
  hardMaxResults?: number;
  now?: Date;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_HARD_MAX = 50;

/**
 * Build a remote reference provider (Drive or web). The kind sets the candidate
 * source; the behavior is identical because both return references only.
 */
export function createRemoteReferenceProvider(
  kind: "drive" | "web",
  opts: RemoteProviderOptions = {},
): RemoteDiscoveryProvider {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hardMax = opts.hardMaxResults ?? DEFAULT_HARD_MAX;
  const configured = opts.adapter !== undefined;

  return {
    kind,
    requiresPermissions: ["network"],
    configured,

    async discover(ctx: RemoteAdapterContext) {
      const diagnostics: DiscoveryDiagnosticValue[] = [];
      const candidates: AssetCandidateValue[] = [];
      if (!opts.adapter) {
        diagnostics.push({
          source: kind,
          level: "info",
          message: `${kind} discovery is not configured; supply an official ${kind} adapter (external auth) to enable it.`,
        });
        return { candidates, diagnostics };
      }

      const cap = Math.min(ctx.maxResults, hardMax);
      let result: RemoteAdapterResult;
      try {
        result = await opts.adapter({ intent: ctx.intent, maxResults: cap, timeoutMs });
      } catch (err) {
        diagnostics.push({ source: kind, level: "error", message: `${kind} adapter error: ${err instanceof Error ? err.message : String(err)}` });
        return { candidates, diagnostics };
      }
      for (const d of result.diagnostics ?? []) diagnostics.push({ source: kind, level: d.level, message: d.message });

      const retrievedAt = (opts.now ?? new Date()).toISOString();
      for (const row of result.rows.slice(0, cap)) {
        if (!isAllowedRemoteUrl(row.ref)) {
          diagnostics.push({ source: kind, level: "warn", message: `Dropped a ${kind} row with a non-http(s) reference: ${JSON.stringify(row.ref)}.` });
          continue;
        }
        const license = row.license ?? { id: "unknown", attributionRequired: false };
        const draft = {
          source: kind,
          ref: row.ref,
          title: row.title,
          relevance: clampUnit(row.relevance ?? 0.5),
          mediaKind: row.mediaKind ?? "other",
          intentMatch: row.intentMatch ?? `provider ${kind} matched intent`,
          provenance: (row.provenance ?? "licensed-source") as ProvenanceKind,
          license,
          rightsStatus: (row.rightsStatus ?? "unknown") as RightsStatus,
          retrievedAt,
          bytesLocal: false,
        };
        const parsed = parseAssetCandidate(draft);
        if (!parsed.ok || !parsed.data) {
          diagnostics.push({ source: kind, level: "warn", message: `Dropped an invalid ${kind} candidate: ${parsed.errors.join("; ")}.` });
          continue;
        }
        candidates.push(parsed.data);
      }
      return { candidates, diagnostics };
    },

    async materialize(candidate: AssetCandidateValue, policy: PermissionPolicy, now?: Date) {
      // Distinct, explicit byte-transfer path. Deny by default.
      requireGrant("media-upload", policy, now);
      if (!opts.transport) {
        throw new Error(`${kind} materialize requires a configured media transport; none is set. Discovery never transfers bytes.`);
      }
      return opts.transport(candidate);
    },
  };
}

/** Drive provider. Truthfully "not configured" until an official adapter is supplied. */
export function createDriveProvider(opts: RemoteProviderOptions = {}): RemoteDiscoveryProvider {
  return createRemoteReferenceProvider("drive", opts);
}

/** Web reference provider. Truthfully "not configured" until an adapter is supplied. */
export function createWebReferenceProvider(opts: RemoteProviderOptions = {}): RemoteDiscoveryProvider {
  return createRemoteReferenceProvider("web", opts);
}

function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export interface ExecJsonAdapterOptions {
  /** Operator-supplied binary (e.g. an official `gws`/`gcloud` build). Auth is external. */
  binary: string;
  /** Build the exact argument array for an intent. Argument arrays only; never a shell string. */
  buildArgs: (intent: string, maxResults: number) => string[];
  /** Map validated JSON stdout to raw rows. Data-only; nothing is executed. */
  parseRows: (json: unknown) => RemoteReferenceRow[];
  runner?: ExecFn;
  maxBuffer?: number;
  cwd?: string;
}

/**
 * A concrete, data-only adapter that runs an operator-supplied official CLI
 * through the existing bounded, argument-array, shell:false runner and parses
 * JSON from its stdout. This is the mechanism a real Google Drive integration
 * uses: the operator authenticates the CLI externally (the engine reads no
 * credential store), and every call is bounded by timeout and output cap. It
 * transfers no media; it only reads references.
 */
export function createExecJsonAdapter(opts: ExecJsonAdapterOptions): RemoteDiscoveryAdapter {
  const runner = opts.runner ?? execProcess;
  return async (ctx: RemoteAdapterContext): Promise<RemoteAdapterResult> => {
    const args = opts.buildArgs(ctx.intent, ctx.maxResults);
    if (!Array.isArray(args)) throw new TypeError("buildArgs must return an argument array");
    const res = await runner(opts.binary, args, {
      timeoutMs: ctx.timeoutMs,
      ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    if (res.spawnError) throw new Error(`Adapter binary not runnable: ${res.spawnError}`);
    if (res.timedOut) throw new Error("Adapter timed out.");
    if (res.code !== 0) throw new Error(`Adapter exited ${res.code}: ${res.stderr.slice(0, 200)}`);
    let json: unknown;
    try {
      json = JSON.parse(res.stdout);
    } catch (err) {
      throw new Error(`Adapter output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { rows: opts.parseRows(json) };
  };
}
