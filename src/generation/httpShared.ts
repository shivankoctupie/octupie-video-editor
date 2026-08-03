/**
 * Shared, internal plumbing for the OpenAI-compatible HTTP generation adapters.
 *
 * Key handling lives here in ONE audited place: a key is read from the process
 * environment only at request time, is never logged, never returned, and never
 * placed in an error (the error names only the variable, never its value). The
 * transport is bounded by an AbortController timeout, and the response body is
 * read under a hard byte cap. This module never bundles or defaults a key.
 */

import type { FetchLike, FetchResponseLike, FetchInitLike } from "../util/fetchLike.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** A token-free description of an HTTP provider. `verified` is always false: the
 * engine never claims a provider is verified without real provider evidence. */
export interface HttpProviderDescription {
  id: string;
  configured: boolean;
  verified: false;
}

/**
 * Read an API key from the environment at call time. Throws a clear error that
 * names only the variable, never its contents, when the key is absent.
 */
export function readApiKey(envName: string): string {
  const raw = process.env[envName];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`No API key available: set the '${envName}' environment variable before calling this provider.`);
  }
  return raw.trim();
}

/** True when a base URL is present AND the named env var currently holds a non-empty key. */
export function isConfigured(baseUrl: string, apiKeyEnv: string): boolean {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) return false;
  const raw = process.env[apiKeyEnv];
  return typeof raw === "string" && raw.trim().length > 0;
}

/** Replace every literal occurrence of the key with a fixed token so it can never ride out inside an error. */
export function stripKey(message: string, key: string): string {
  return key.length > 0 ? message.split(key).join("[REDACTED]") : message;
}

/** The message of an unknown thrown value, as a string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lower-cased media type with any parameters (charset, boundary) removed. */
export function normalizeMime(header: string | null): string {
  if (!header) return "";
  const semicolon = header.indexOf(";");
  const base = semicolon >= 0 ? header.slice(0, semicolon) : header;
  return base.trim().toLowerCase();
}

/**
 * Run one bounded transport call with a hard timeout. On timeout the controller
 * is aborted and a bounded, key-free error is thrown by the caller's wrapper.
 */
export async function timedFetch(
  fetchFn: FetchLike,
  url: string,
  init: FetchInitLike,
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

/**
 * Read the response body as bytes under a hard cap. A declared content-length
 * over the cap is refused before the body is read; the actual length is then
 * re-checked so a lying or missing header cannot smuggle oversized bytes.
 */
export async function readCappedBytes(res: FetchResponseLike, maxBytes: number): Promise<Uint8Array> {
  const declared = res.headers.get("content-length");
  if (declared !== null && declared.trim() !== "") {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`response exceeds the ${maxBytes}-byte cap`);
    }
  }
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`response exceeds the ${maxBytes}-byte cap`);
  }
  return bytes;
}
