/**
 * Hardened web asset downloader (parity phase 9).
 *
 * This pulls real bytes from an arbitrary http(s) URL, which is the highest-risk
 * operation in the engine, so every restriction is enforced here and in order:
 *
 *   1. an explicit `network` grant AND an explicit `media-upload` grant are required
 *      before anything else; with either missing, nothing is fetched;
 *   2. rights are parsed and MUST be reusable (`reusable: true`); missing or
 *      non-reusable rights fail closed before a byte is requested;
 *   3. the URL must be https, and EVERY hop is re-validated: the scheme is re-checked
 *      and the host is resolved and required to be fully public (DNS-rebinding aware)
 *      before each fetch, so a redirect cannot walk the request onto a private
 *      address;
 *   4. redirects are handled manually and capped; the body is read under a hard byte
 *      cap and its content-type checked against the media allowlist;
 *   5. the bytes are hashed, written to a contained, non-overwriting path, and
 *      described by two JSON sidecars.
 *
 * All IO is injected (fetch, DNS resolver, clock) so tests are offline and
 * deterministic. The record stores the stable ORIGINAL url, never a transient
 * redirect target.
 */

import { requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import { assertHttpsUrl, assertResolvesPublic, type HostResolver } from "../util/ssrf.js";
import type { FetchLike } from "../util/fetchLike.js";
import { APPROVED_MEDIA_MIME, parseRights, type MaterializedAssetValue } from "./schemas.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  readCappedMediaBody,
  writeMaterializedAsset,
} from "./internal.js";

export interface MaterializeWebInput {
  url: string;
  rights: unknown;
  relPath: string;
  outDir: string;
  policy: PermissionPolicy;
  fetch: FetchLike;
  resolve: HostResolver;
  now: Date;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  approvedMime?: ReadonlySet<string>;
}

export async function materializeWebAsset(input: MaterializeWebInput): Promise<{ record: MaterializedAssetValue; assetPath: string }> {
  const now = input.now;

  // 1. Permission gates BEFORE any network or rights work. No grant => no fetch.
  requireGrant("network", input.policy, now);
  requireGrant("media-upload", input.policy, now);

  // 2. Rights must be present and reusable. Fail closed before a byte is requested.
  const rights = parseRights(input.rights);
  if (!rights.ok || rights.data === undefined) {
    throw new Error(`Refusing to materialize a web asset: rights are missing or not reusable (${rights.errors.join("; ")}).`);
  }

  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = input.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const approvedMime = input.approvedMime ?? APPROVED_MEDIA_MIME;

  // 3. Initial https gate before entering the redirect loop.
  assertHttpsUrl(input.url);

  let currentUrl = input.url;
  let redirects = 0;
  for (;;) {
    // Re-validate scheme and host on EVERY hop (redirect-aware SSRF protection), and pin
    // the connect to a validated public address so the transport cannot re-resolve the
    // name to a private one between this check and the socket (DNS-rebinding TOCTOU).
    const parsed = assertHttpsUrl(currentUrl);
    const { addresses } = await assertResolvesPublic(parsed.hostname, input.resolve);
    const pinnedAddress = addresses[0];

    const res = await fetchWithTimeout(
      input.fetch,
      currentUrl,
      { method: "GET", redirect: "manual", ...(pinnedAddress ? { pinnedAddress } : {}) },
      timeoutMs,
    );

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location === null || location.trim().length === 0) {
        throw new Error(`Web asset redirect (status ${res.status}) had no Location header.`);
      }
      if (redirects >= maxRedirects) {
        throw new Error(`Too many redirects (> ${maxRedirects}) while materializing a web asset.`);
      }
      redirects += 1;
      // Resolve a possibly-relative Location against the current URL, then loop to
      // re-validate it at the top before the next fetch.
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      const { bytes, mime } = await readCappedMediaBody(res, maxBytes, approvedMime);
      return writeMaterializedAsset({
        bytes,
        mime,
        method: "web",
        source: input.url,
        rights: rights.data,
        relPath: input.relPath,
        outDir: input.outDir,
        now,
      });
    }

    throw new Error(`Unexpected HTTP ${res.status} while materializing a web asset.`);
  }
}
