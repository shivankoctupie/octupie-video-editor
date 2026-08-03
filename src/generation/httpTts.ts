/**
 * Optional OpenAI-compatible HTTP text-to-speech provider.
 *
 * This adapter mirrors the HTTP image adapter and carries the same guarantees: a
 * `network` grant is required before any request, the base URL passes the https
 * gate, the key is read from the environment at request time and sent only as an
 * `Authorization: Bearer` header (never logged, returned, or placed in an error),
 * the transport is bounded by a timeout, the response body is read under a hard
 * byte cap, and the content-type must be an approved audio mime. `describe()`
 * reports configuration but NEVER claims the provider is verified. It is additive:
 * standalone offline behavior is unaffected.
 */

import { requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import { assertHttpsUrl } from "../util/ssrf.js";
import type { FetchLike, FetchResponseLike } from "../util/fetchLike.js";
import { APPROVED_AUDIO_MIME, type GenerateOutput, type TtsProvider } from "./contracts.js";
import { parseTtsRequest, type TtsRequest } from "./schemas.js";
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

export interface HttpTtsConfig {
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
 * Build an OpenAI-audio-speech-compatible HTTP text-to-speech provider. No key is
 * bundled or read at construction time; the environment is consulted only when
 * `synthesize` runs.
 */
export function createHttpTtsProvider(config: HttpTtsConfig): TtsProvider & { describe(): HttpProviderDescription } {
  const id = config.id ?? "http-tts";
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    id,

    async synthesize(req: TtsRequest, policy: PermissionPolicy): Promise<GenerateOutput> {
      const parsed = parseTtsRequest(req);
      if (!parsed.ok || !parsed.data) {
        throw new Error(`Invalid tts request: ${parsed.errors.join("; ")}`);
      }
      const value = parsed.data;

      // Permission gate BEFORE any network work. No grant => no request.
      requireGrant("network", policy);

      // Reject an http or private/reserved endpoint before a byte is sent.
      const url = assertHttpsUrl(config.baseUrl);

      // Read the key only now, at request time.
      const key = readApiKey(config.apiKeyEnv);

      const payload: Record<string, unknown> = { model: config.model, input: value.text };
      if (value.voice !== undefined) payload.voice = value.voice;
      const body = JSON.stringify(payload);

      let res: FetchResponseLike;
      try {
        res = await timedFetch(
          config.fetch,
          url.toString(),
          {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "audio/*, application/json" },
            body,
            redirect: "error",
          },
          timeoutMs,
        );
      } catch (err) {
        throw new Error(`TTS provider '${id}' request failed: ${stripKey(errorMessage(err), key)}`);
      }

      if (res.status < 200 || res.status >= 300) {
        throw new Error(`TTS provider '${id}' returned HTTP ${res.status}.`);
      }

      const contentType = normalizeMime(res.headers.get("content-type"));
      if (!APPROVED_AUDIO_MIME.has(contentType)) {
        throw new Error(`TTS provider '${id}' returned an unapproved content-type '${contentType}'.`);
      }

      const bytes = await readCappedBytes(res, maxBytes);
      return { bytes, mime: contentType, model: config.model };
    },

    describe(): HttpProviderDescription {
      return { id, configured: isConfigured(config.baseUrl, config.apiKeyEnv), verified: false };
    },
  };
}
