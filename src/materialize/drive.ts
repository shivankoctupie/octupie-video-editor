/**
 * Official Google Drive file downloader (parity phase 9).
 *
 * This talks ONLY to the documented, authenticated Drive v3 media endpoint and
 * never to an arbitrary URL. Every restriction is enforced here, in order:
 *
 *   1. an explicit `network` grant AND an explicit `media-upload` grant are required
 *      before anything else;
 *   2. rights are parsed and MUST be reusable (`reusable: true`); missing or
 *      non-reusable rights fail closed before a byte is requested;
 *   3. the file id is validated against a strict character class, so it can never
 *      shape the URL into another path or host;
 *   4. the access token is read from `process.env` at call time, only into the
 *      Authorization header. It is never placed in the URL, a CLI arg, an error,
 *      a record, or a sidecar. Any transport error text is scrubbed of the token
 *      before it is surfaced;
 *   5. the request is bounded by a timeout, sends no cookies, and uses
 *      `redirect: "manual"`. Because this path is given no DNS resolver, a redirect
 *      target cannot be SSRF-validated, so redirects are refused (fail closed); the
 *      official `alt=media` endpoint returns the bytes directly with 200;
 *   6. the body is read under the byte cap and MIME allowlist, hashed, and written
 *      to a contained, non-overwriting path with two JSON sidecars.
 *
 * All IO is injected (fetch, clock) so tests are offline and deterministic.
 */

import { requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import { assertHttpsUrl } from "../util/ssrf.js";
import type { FetchLike } from "../util/fetchLike.js";
import { APPROVED_MEDIA_MIME, parseRights, type MaterializedAssetValue } from "./schemas.js";
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, fetchWithTimeout, readCappedMediaBody, writeMaterializedAsset } from "./internal.js";

/** Google Drive file ids are URL-safe base64-ish tokens. Anything else is refused. */
const FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;

export interface MaterializeDriveInput {
  fileId: string;
  rights: unknown;
  relPath: string;
  outDir: string;
  policy: PermissionPolicy;
  fetch: FetchLike;
  /** Name of the env var holding the OAuth access token. Read at call time only. */
  accessTokenEnv: string;
  now: Date;
  maxBytes?: number;
  timeoutMs?: number;
  approvedMime?: ReadonlySet<string>;
}

/** Remove any occurrence of the token from a string before it can be surfaced. */
function scrubToken(text: string, token: string): string {
  if (token.length === 0) return text;
  return text.split(token).join("[REDACTED]");
}

export async function materializeDriveFile(input: MaterializeDriveInput): Promise<{ record: MaterializedAssetValue; assetPath: string }> {
  const now = input.now;

  // 1. Permission gates BEFORE anything else. No grant => no fetch.
  requireGrant("network", input.policy, now);
  requireGrant("media-upload", input.policy, now);

  // 2. Rights must be present and reusable. Fail closed before a byte is requested.
  const rights = parseRights(input.rights);
  if (!rights.ok || rights.data === undefined) {
    throw new Error(`Refusing to materialize a Drive file: rights are missing or not reusable (${rights.errors.join("; ")}).`);
  }

  // 3. Strict file id: cannot reshape the URL path or host.
  if (!FILE_ID.test(input.fileId)) {
    throw new Error("Invalid Drive fileId: expected 1 to 256 characters of [A-Za-z0-9_-].");
  }

  // 4. Read the token at call time, only into a local. Never logged, never in the URL.
  const token = process.env[input.accessTokenEnv];
  if (token === undefined || token.length === 0) {
    throw new Error(`Drive access token is not set in the environment variable '${input.accessTokenEnv}'.`);
  }

  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const approvedMime = input.approvedMime ?? APPROVED_MEDIA_MIME;

  // The official Drive v3 media endpoint. The token goes in the header, never here.
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}?alt=media`;
  assertHttpsUrl(url);

  let res;
  try {
    res = await fetchWithTimeout(
      input.fetch,
      url,
      { method: "GET", headers: { authorization: `Bearer ${token}` }, redirect: "manual" },
      timeoutMs,
    );
  } catch (err) {
    // Scrub the token from any transport error text before surfacing it.
    throw new Error(`Drive request failed: ${scrubToken(err instanceof Error ? err.message : String(err), token)}`);
  }

  // 5. No DNS resolver on this path, so a redirect target cannot be SSRF-validated:
  //    refuse redirects and read only a direct 2xx body (fail closed).
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Drive returned a redirect (status ${res.status}); redirects are not followed.`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Drive returned HTTP ${res.status}.`);
  }

  // 6. Bounded body read, hash, and contained atomic write.
  const { bytes, mime } = await readCappedMediaBody(res, maxBytes, approvedMime);
  return writeMaterializedAsset({
    bytes,
    mime,
    method: "drive",
    source: input.fileId,
    rights: rights.data,
    relPath: input.relPath,
    outDir: input.outDir,
    now,
  });
}
