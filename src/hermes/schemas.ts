/**
 * Runtime-validated schemas and safe config for optional Hermes Agent
 * orchestration (parity phase 6).
 *
 * Hermes is reached ONLY through its documented, authenticated API Server:
 *   - GET  /health
 *   - GET  /v1/capabilities   (machine-readable, authenticated)
 *   - POST /v1/chat/completions  (OpenAI-compatible)
 *
 * These schemas are the trust boundary for everything that crosses that surface.
 * Rules enforced structurally, not by convention:
 *
 *   1. The config accepts only `surface: 'api'`. The base URL must be http(s),
 *      carry no embedded credentials and no fragment, and use http only on a
 *      loopback host (https is required everywhere else). The trailing slash is
 *      normalized away. The bearer token is held on a NON-ENUMERABLE property so
 *      `JSON.stringify(config)` and any structured log can never leak it.
 *   2. A capabilities reply must present enough object/platform/auth/features
 *      shape to prove it is the Hermes API Server; anything else is rejected.
 *   3. The orchestration request is small and bounded (objective, workflow stage,
 *      bounded context text, optional artifact references, never raw media bytes).
 *   4. The orchestration response is DATA ONLY (summary, recommendedNextStep,
 *      orderedActions, warnings, requiresHumanApproval) with every count and
 *      string capped. Nothing here is ever executed; it is a proposal a human
 *      still approves.
 *
 * Private Hermes config, .env, auth.json, credentials, and Python internals are
 * NEVER read. The caller supplies the token; the engine only ever sends it as an
 * `Authorization: Bearer` header.
 */

import { z } from "zod";

/** The documented default local endpoint of a Hermes API Server. */
export const HERMES_DEFAULT_BASE_URL = "http://127.0.0.1:8642";

/** The only supported Hermes surface. MCP and plugin surfaces are out of scope here. */
export const HERMES_SURFACE = "api" as const;

/** Bounds on the config, chosen to be safe on a laptop and hostile-input proof. */
export const HERMES_LIMITS = {
  timeoutMsMin: 1,
  timeoutMsMax: 120_000,
  timeoutMsDefault: 15_000,
  maxResponseBytesMin: 1,
  maxResponseBytesMax: 16 * 1024 * 1024,
  maxResponseBytesDefault: 1024 * 1024,
} as const;

/** Bounds on the structured request and the data-only response. */
export const HERMES_TEXT_LIMITS = {
  objective: 2_000,
  workflowStage: 120,
  contextText: 20_000,
  artifactRef: 512,
  maxArtifactRefs: 20,
  summary: 4_000,
  recommendedNextStep: 2_000,
  action: 500,
  maxActions: 20,
  warning: 500,
  maxWarnings: 20,
} as const;

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

// --- Base URL safety -------------------------------------------------------

/** True for hosts that are always local and therefore safe to reach over http. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1") return true;
  // Any 127.0.0.0/8 address is loopback.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

export interface BaseUrlCheck {
  ok: boolean;
  /** Normalized base URL (origin + path, no trailing slash) when ok. */
  normalized?: string;
  error?: string;
}

/**
 * Validate and normalize a Hermes base URL. Rejects embedded credentials, a URL
 * fragment, any non-http(s) scheme, and http to a non-loopback host. Strips a
 * trailing slash so `https://h/` and `https://h` are the same endpoint.
 */
export function checkBaseUrl(raw: string): BaseUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "base URL is not a valid absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "base URL must use http or https" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "base URL must not embed credentials (user:pass@host)" };
  }
  if (url.hash !== "") {
    return { ok: false, error: "base URL must not contain a fragment" };
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return { ok: false, error: "http is allowed only for a loopback host; use https for remote endpoints" };
  }
  if (url.search !== "") {
    return { ok: false, error: "base URL must not contain a query string" };
  }
  // Normalize: origin + optional path prefix, trailing slash removed.
  const path = url.pathname.replace(/\/+$/, "");
  const normalized = `${url.origin}${path}`;
  return { ok: true, normalized };
}

// --- Config ----------------------------------------------------------------

export interface HermesConfigInput {
  surface?: string;
  baseUrl: string;
  model?: string;
  /** Bearer token supplied by the caller. Never read from a private store. */
  apiKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * A validated Hermes API config. `apiKey` is a NON-ENUMERABLE property so it is
 * never serialized by `JSON.stringify` and never appears in a structured log.
 */
export interface HermesConfig {
  readonly surface: typeof HERMES_SURFACE;
  readonly baseUrl: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly apiKey: string;
}

function intInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  }
}

/**
 * Build a validated, frozen Hermes config. Throws on any unsafe input BEFORE any
 * network call is possible. The returned object hides its token: `JSON.stringify`
 * of it omits `apiKey` entirely.
 */
export function resolveHermesConfig(input: HermesConfigInput): HermesConfig {
  const surface = input.surface ?? HERMES_SURFACE;
  if (surface !== HERMES_SURFACE) {
    throw new Error(`Unsupported Hermes surface '${surface}'; only '${HERMES_SURFACE}' is supported`);
  }

  const check = checkBaseUrl(String(input.baseUrl ?? ""));
  if (!check.ok || !check.normalized) {
    throw new Error(`Invalid Hermes base URL: ${check.error}`);
  }

  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (apiKey.length === 0) {
    throw new Error("A Hermes API token is required (Authorization: Bearer)");
  }

  const timeoutMs = input.timeoutMs ?? HERMES_LIMITS.timeoutMsDefault;
  intInRange(timeoutMs, HERMES_LIMITS.timeoutMsMin, HERMES_LIMITS.timeoutMsMax, "timeoutMs");

  const maxResponseBytes = input.maxResponseBytes ?? HERMES_LIMITS.maxResponseBytesDefault;
  intInRange(maxResponseBytes, HERMES_LIMITS.maxResponseBytesMin, HERMES_LIMITS.maxResponseBytesMax, "maxResponseBytes");

  let model: string | undefined;
  if (input.model !== undefined) {
    const m = String(input.model).trim();
    if (m.length === 0) throw new Error("model, when provided, must be non-empty");
    model = m;
  }

  const base: Record<string, unknown> = {
    surface: HERMES_SURFACE,
    baseUrl: check.normalized,
    timeoutMs,
    maxResponseBytes,
  };
  if (model !== undefined) base.model = model;

  Object.defineProperty(base, "apiKey", {
    value: apiKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(base) as unknown as HermesConfig;
}

/** A token-free description of a config, safe to log. */
export function describeHermesConfig(config: HermesConfig): {
  surface: string;
  baseUrl: string;
  model?: string;
  timeoutMs: number;
  maxResponseBytes: number;
} {
  return {
    surface: config.surface,
    baseUrl: config.baseUrl,
    ...(config.model !== undefined ? { model: config.model } : {}),
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
  };
}

// --- Capabilities reply (proves this is the Hermes API Server) --------------

/**
 * A capabilities reply must present object/platform/auth/features shape, and the
 * platform must identify Hermes. Sub-objects allow extra keys (forward compat),
 * but the identity fields are required so a random JSON endpoint is rejected.
 */
export const hermesCapabilitiesSchema = z
  .object({
    object: z.literal("hermes.api_server.capabilities"),
    platform: z.literal("hermes-agent"),
    model: z.string().min(1),
    auth: z
      .object({
        type: z.literal("bearer"),
        required: z.literal(true),
      })
      .passthrough(),
    features: z.union([z.array(z.string().min(1)), z.record(z.boolean())]),
  })
  .passthrough();
export type HermesCapabilitiesValue = z.infer<typeof hermesCapabilitiesSchema>;

export function parseHermesCapabilities(json: unknown): ParseResult<HermesCapabilitiesValue> {
  const r = hermesCapabilitiesSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

// --- Chat completion envelope (OpenAI-compatible) ---------------------------

/**
 * Just enough of the OpenAI-compatible envelope to read the final text at
 * `choices[0].message.content`. Extra fields are allowed and ignored.
 */
export const chatCompletionEnvelopeSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                role: z.string().min(1).optional(),
                content: z.string(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1, "at least one choice is required"),
  })
  .passthrough();
export type ChatCompletionEnvelopeValue = z.infer<typeof chatCompletionEnvelopeSchema>;

export function parseChatCompletionEnvelope(json: unknown): ParseResult<ChatCompletionEnvelopeValue> {
  const r = chatCompletionEnvelopeSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

// --- Orchestration request (small, structured, bounded) ---------------------

export const hermesOrchestrationRequestSchema = z
  .object({
    objective: z.string().trim().min(1, "an objective is required").max(HERMES_TEXT_LIMITS.objective),
    workflowStage: z.string().trim().min(1, "a workflow stage is required").max(HERMES_TEXT_LIMITS.workflowStage),
    contextText: z.string().max(HERMES_TEXT_LIMITS.contextText).optional(),
    artifactRefs: z
      .array(z.string().trim().min(1).max(HERMES_TEXT_LIMITS.artifactRef).refine((s) => !s.includes("\0"), "artifact ref must not contain a null byte"))
      .max(HERMES_TEXT_LIMITS.maxArtifactRefs)
      .optional(),
  })
  .strict();
export type HermesOrchestrationRequestValue = z.infer<typeof hermesOrchestrationRequestSchema>;

export function parseHermesOrchestrationRequest(json: unknown): ParseResult<HermesOrchestrationRequestValue> {
  const r = hermesOrchestrationRequestSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

// --- Orchestration response (DATA ONLY) -------------------------------------

export const hermesOrchestrationResponseSchema = z
  .object({
    summary: z.string().trim().min(1, "a summary is required").max(HERMES_TEXT_LIMITS.summary),
    recommendedNextStep: z.string().trim().min(1, "a recommendedNextStep is required").max(HERMES_TEXT_LIMITS.recommendedNextStep),
    orderedActions: z.array(z.string().trim().min(1).max(HERMES_TEXT_LIMITS.action)).max(HERMES_TEXT_LIMITS.maxActions),
    warnings: z.array(z.string().trim().min(1).max(HERMES_TEXT_LIMITS.warning)).max(HERMES_TEXT_LIMITS.maxWarnings),
    requiresHumanApproval: z.boolean(),
  })
  .strict();
export type HermesOrchestrationResponseValue = z.infer<typeof hermesOrchestrationResponseSchema>;

export function parseHermesOrchestrationResponse(json: unknown): ParseResult<HermesOrchestrationResponseValue> {
  const r = hermesOrchestrationResponseSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}
