/**
 * Opt-in HTTPS webhook publishing adapter (parity phase 8, additive).
 *
 * Publishing is DISABLED BY DEFAULT. This adapter is reachable only when an operator
 * explicitly configures an endpoint and an allowlist, and only after the outer
 * `publish()` flow has already cleared every gate (approved version, RBAC, live
 * publishing grant, rights, QA, idempotency). It never runs on its own and adds no
 * default network behavior.
 *
 * Every restriction is enforced here, not by convention:
 *
 *   - the endpoint must be an HTTPS URL whose host is on an explicit allowlist;
 *   - SSRF guards run BEFORE a byte is sent: the scheme and any IP literal are gated
 *     by `assertHttpsUrl`, and the hostname is resolved by an injected resolver with
 *     EVERY resolved address required to be public (rebinding-aware). A policy
 *     failure returns a blocked result; it does not throw, and fetch is not called;
 *   - the request is bounded by a timeout and the response body is read under a hard
 *     byte cap; a redirect and any non-2xx are refused;
 *   - a secret, if configured, is read ONLY from process.env at publish time, travels
 *     ONLY in the Authorization header, and is NEVER logged, returned, or placed in
 *     the output data or a blocked reason;
 *   - the output is DATA ONLY and validates against `adapterOutputSchema`.
 *
 * The transport is injected as a `FetchLike` so tests drive it with a stub and never
 * touch the real network or DNS.
 */

import type { FetchLike, FetchResponseLike } from "../util/fetchLike.js";
import { assertHttpsUrl, assertResolvesPublic, SsrfBlockedError, type HostResolver } from "../util/ssrf.js";
import { MAX_ID, type AdapterOutputValue, type PublishRequestValue } from "./schemas.js";
import type { PublishingAdapter } from "./publishing.js";

const DEFAULT_ID = "webhook";
const DEFAULT_TIMEOUT_MS = 10_000;
/** 64 KiB, matching the DATA payload cap in `schemas.ts`. */
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

export interface WebhookPublishingConfig {
  id?: string;
  endpointUrl: string;
  allowedHosts: readonly string[];
  fetch: FetchLike;
  resolve: HostResolver;
  secretEnv?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
}

export interface WebhookAdapterDescription {
  id: string;
  enabled: boolean;
  configured: boolean;
  /** ALWAYS false: no real endpoint is probed, so verification is never claimed. */
  verified: false;
}

/** A data-only blocked result. It never carries a token. */
function blocked(reason: string): AdapterOutputValue {
  return { ok: false, blockedReason: reason, data: {} };
}

/** Configured only when both an endpoint and a non-empty allowlist are present. */
function isConfigured(config: WebhookPublishingConfig): boolean {
  return (
    typeof config.endpointUrl === "string" &&
    config.endpointUrl.trim().length > 0 &&
    Array.isArray(config.allowedHosts) &&
    config.allowedHosts.length > 0
  );
}

/** Return `value` only when it is a non-empty string within the id byte cap, so a
 * provider reference can never exceed what `adapterOutputSchema` accepts. */
function boundedRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length < 1 || value.length > MAX_ID) return undefined;
  return value;
}

/** Pull a bounded providerRef (id, then ref) from a small JSON body, if present. A
 * non-JSON or non-object body simply yields no reference. */
function extractProviderRef(bytes: ArrayBuffer): string | undefined {
  if (bytes.byteLength === 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return undefined;
  const record = json as Record<string, unknown>;
  return boundedRef(record["id"]) ?? boundedRef(record["ref"]);
}

export function createWebhookPublishingAdapter(config: WebhookPublishingConfig): PublishingAdapter {
  const id = config.id ?? DEFAULT_ID;
  const enabled = isConfigured(config);

  return {
    id,
    enabled,
    async publish(request: PublishRequestValue): Promise<AdapterOutputValue> {
      // 1. Disabled unless an endpoint and an allowlist are both configured.
      if (!enabled) {
        return blocked("Webhook adapter is not configured.");
      }

      // 2. Scheme and IP-literal gate. HTTPS is required. A policy failure is a
      //    blocked result, never a thrown error.
      let url: URL;
      try {
        url = assertHttpsUrl(config.endpointUrl);
      } catch (err) {
        if (err instanceof SsrfBlockedError) return blocked(err.message);
        throw err;
      }

      // 3. Host allowlist, case-insensitive exact match. Fetch is not reached on a miss.
      const hostname = url.hostname;
      const hostKey = hostname.toLowerCase();
      const onAllowlist = config.allowedHosts.some((h) => h.trim().toLowerCase() === hostKey);
      if (!onAllowlist) {
        return blocked(`Host '${hostname}' is not on the webhook allowlist.`);
      }

      // 4. Rebinding-aware resolution gate: every resolved address must be public. Keep
      //    the validated address to pin the connect, so the transport cannot re-resolve
      //    the host to a private one between this check and the socket.
      let pinnedAddress: string | undefined;
      try {
        const checked = await assertResolvesPublic(hostname, config.resolve);
        pinnedAddress = checked.addresses[0];
      } catch (err) {
        if (err instanceof SsrfBlockedError) return blocked(err.message);
        throw err;
      }

      // 5. Read the secret ONLY from the environment at publish time. It travels
      //    ONLY in the Authorization header, never in the body, the output, a log,
      //    or a blocked reason.
      const secret = config.secretEnv ? process.env[config.secretEnv] : undefined;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (typeof secret === "string" && secret.length > 0) {
        headers["Authorization"] = `Bearer ${secret}`;
      }
      const body = JSON.stringify({
        versionId: request.versionId,
        projectId: request.projectId,
        adapterId: request.adapterId,
        idempotencyKey: request.idempotencyKey,
        requestedBy: request.requestedBy,
        params: request.params ?? {},
      });

      const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

      // Bound the request with a timeout. Redirects are refused so a webhook cannot
      // bounce the call to an unvetted host.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: FetchResponseLike;
      try {
        response = await config.fetch(url.toString(), {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: controller.signal,
          ...(pinnedAddress ? { pinnedAddress } : {}),
        });
      } catch {
        // A transport error, an abort, or a timeout. Report a bounded, secret-free
        // reason (the secret lived only in the request headers, never in the error).
        return blocked("Webhook request failed before a response was received.");
      } finally {
        clearTimeout(timer);
      }

      // 6. Refuse a redirect and any non-2xx status.
      if (response.status >= 300 && response.status < 400) {
        return blocked(`Webhook endpoint returned a redirect (HTTP ${response.status}); redirects are refused.`);
      }
      if (response.status < 200 || response.status >= 300) {
        return blocked(`Webhook endpoint returned HTTP ${response.status}.`);
      }

      // Read the body under a hard byte cap. The injected response contract exposes
      // no stream, so the cap is enforced on the materialized byte length.
      let bytes: ArrayBuffer;
      try {
        bytes = await response.arrayBuffer();
      } catch {
        return blocked("Webhook response body could not be read.");
      }
      if (bytes.byteLength > maxResponseBytes) {
        return blocked(`Webhook response body exceeded the ${maxResponseBytes}-byte cap.`);
      }

      const providerRef = extractProviderRef(bytes);
      return {
        ok: true,
        ...(providerRef !== undefined ? { providerRef } : {}),
        data: { status: response.status, host: hostname },
      };
    },
  };
}

/** A token-free description of how the adapter is configured. `verified` is ALWAYS
 * false: this never probes a real endpoint, so it must not claim to be verified. */
export function describeWebhookAdapter(config: WebhookPublishingConfig): WebhookAdapterDescription {
  const configured = isConfigured(config);
  return {
    id: config.id ?? DEFAULT_ID,
    enabled: configured,
    configured,
    verified: false,
  };
}
