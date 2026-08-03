/**
 * Optional OpenAI-compatible HTTP image provider.
 *
 * This adapter is additive: standalone offline behavior is unaffected, and it is
 * only reached when an operator supplies a base URL, a key environment variable,
 * a transport, and a `network` grant. Every restriction is enforced here:
 *
 *   - a `network` PermissionPolicy grant is required BEFORE any request;
 *   - the base URL must pass the https gate (no http, no private or reserved host);
 *   - the key is read from the environment at request time, sent only as an
 *     `Authorization: Bearer` header, and never logged, returned, or placed in an
 *     error;
 *   - the transport is bounded by a timeout, the response body is read under a
 *     hard byte cap, and the content-type must be an approved image mime;
 *   - `describe()` reports whether it is configured but NEVER claims it is
 *     verified.
 */

import { requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import { assertHttpsUrl } from "../util/ssrf.js";
import type { FetchLike, FetchResponseLike } from "../util/fetchLike.js";
import { APPROVED_IMAGE_MIME, type GenerateOutput, type ImageProvider } from "./contracts.js";
import { parseImageRequest, type ImageRequest } from "./schemas.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  isConfigured,
  normalizeMime,
  readApiKey,
  readCappedBytes,
  stripKey,
  timedFetch,
  type HttpProviderDescription,
} from "./httpShared.js";

export interface HttpImageConfig {
  id?: string;
  baseUrl: string;
  model: string;
  /** Name of the environment variable that holds the key (read at request time). */
  apiKeyEnv: string;
  fetch: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Build an OpenAI-images-compatible HTTP image provider. No key is bundled or
 * read at construction time; the environment is consulted only when `generate`
 * runs.
 */
export function createHttpImageProvider(config: HttpImageConfig): ImageProvider & { describe(): HttpProviderDescription } {
  const id = config.id ?? "http-image";
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    id,

    async generate(req: ImageRequest, policy: PermissionPolicy): Promise<GenerateOutput> {
      const parsed = parseImageRequest(req);
      if (!parsed.ok || !parsed.data) {
        throw new Error(`Invalid image request: ${parsed.errors.join("; ")}`);
      }
      const value = parsed.data;

      // Permission gate BEFORE any network work. No grant => no request.
      requireGrant("network", policy);

      // Reject an http or private/reserved endpoint before a byte is sent.
      const url = assertHttpsUrl(config.baseUrl);

      // Read the key only now, at request time.
      const key = readApiKey(config.apiKeyEnv);

      const body = JSON.stringify({ model: config.model, prompt: value.prompt, size: `${value.width}x${value.height}` });

      let res: FetchResponseLike;
      try {
        res = await timedFetch(
          config.fetch,
          url.toString(),
          {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, image/*" },
            body,
            redirect: "error",
          },
          timeoutMs,
        );
      } catch (err) {
        throw new Error(`Image provider '${id}' request failed: ${stripKey(errorMessage(err), key)}`);
      }

      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Image provider '${id}' returned HTTP ${res.status}.`);
      }

      const contentType = normalizeMime(res.headers.get("content-type"));
      if (!APPROVED_IMAGE_MIME.has(contentType)) {
        throw new Error(`Image provider '${id}' returned an unapproved content-type '${contentType}'.`);
      }

      const bytes = await readCappedBytes(res, maxBytes);
      return { bytes, mime: contentType, model: config.model };
    },

    describe(): HttpProviderDescription {
      return { id, configured: isConfigured(config.baseUrl, config.apiKeyEnv), verified: false };
    },
  };
}
