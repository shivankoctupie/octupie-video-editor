/**
 * Bounded official HTTP adapter for the Hermes API Server (parity phase 6).
 *
 * This is the ONLY path that talks to Hermes, and it talks only to the documented
 * authenticated API surface. Every restriction is enforced here, not by convention:
 *
 *   - a `network` PermissionPolicy grant is required BEFORE any fetch; with no
 *     grant, and with an invalid config, no request is ever made;
 *   - requests carry `Authorization: Bearer <token>`; the token is never placed
 *     in a URL, a query string, an error, or a returned value;
 *   - redirects are refused (`redirect: 'error'` plus a defensive status/redirected
 *     check), the request is bounded by a timeout, and the response body is read
 *     under a hard byte cap;
 *   - `GET /v1/capabilities` must validate as the Hermes API Server before the
 *     connection is trusted; `POST /v1/chat/completions` output is parsed as JSON
 *     and validated as a small DATA-ONLY object. Nothing a provider returns is
 *     ever executed, imported, or evaluated.
 *
 * Standalone offline operation is unaffected: this module is additive and is only
 * reached when an operator explicitly opts in with an endpoint, a token, and a
 * network grant. No private Hermes config, `.env`, `auth.json`, or credential
 * store is ever read.
 */

import { requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import { redactSecrets, truncate } from "../agent/redact.js";
import {
  describeHermesConfig,
  parseChatCompletionEnvelope,
  parseHermesCapabilities,
  parseHermesOrchestrationRequest,
  parseHermesOrchestrationResponse,
  resolveHermesConfig,
  type HermesCapabilitiesValue,
  type HermesConfig,
  type HermesConfigInput,
  type HermesOrchestrationRequestValue,
  type HermesOrchestrationResponseValue,
} from "./schemas.js";

/** Default model used when the caller does not name one for an orchestration. */
export const HERMES_DEFAULT_MODEL = "hermes-agent";

const CAPABILITIES_PATH = "/v1/capabilities";
const CHAT_PATH = "/v1/chat/completions";

/** Cap on an error diagnostic surfaced from a Hermes response. */
const ERROR_DETAIL_CAP = 400;

/** Minimal, injectable request shape. No credentials ever go in the URL. */
export interface HermesRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Minimal, injectable response shape. `readBodyCapped` enforces the byte cap. */
export interface HermesHttpResponse {
  status: number;
  /** True if the transport followed a redirect. A trusted call must be false. */
  redirected: boolean;
  headers: { get(name: string): string | null };
  /** Read the body, stopping once `maxBytes` is exceeded. */
  readBodyCapped(maxBytes: number): Promise<{ text: string; truncated: boolean }>;
}

/** A transport function. The real one wraps global fetch; tests inject a fake. */
export type HermesFetch = (url: string, init: HermesRequestInit) => Promise<HermesHttpResponse>;

export interface HermesDeps {
  fetch?: HermesFetch;
  now?: () => Date;
}

/** The real transport: global fetch, redirects refused, body read under a cap. */
export const nodeHermesFetch: HermesFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    redirect: "error",
    ...(init.signal ? { signal: init.signal } : {}),
  });
  return {
    status: res.status,
    redirected: res.redirected,
    headers: res.headers,
    async readBodyCapped(maxBytes: number) {
      const reader = res.body?.getReader();
      if (!reader) {
        const text = await res.text();
        const bytes = Buffer.byteLength(text, "utf8");
        return { text, truncated: bytes > maxBytes };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;
      // Read incrementally and stop as soon as the cap is exceeded, so a hostile
      // or runaway body never fully buffers in memory.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            truncated = true;
            try {
              await reader.cancel();
            } catch {
              // Best-effort cancel; the cap decision already stands.
            }
            break;
          }
          chunks.push(value);
        }
      }
      return { text: truncated ? "" : Buffer.concat(chunks).toString("utf8"), truncated };
    },
  };
};

/** Bound and redact any Hermes-facing diagnostic so a token can never leak out. */
function safeDetail(input: string, secret?: string): string {
  const withoutExactSecret = secret && secret.length > 0 ? input.split(secret).join("[REDACTED]") : input;
  return truncate(redactSecrets(withoutExactSecret), ERROR_DETAIL_CAP);
}

/**
 * Run one bounded transport call with a timeout. On timeout the controller is
 * aborted and a bounded error is thrown. The token lives only in the headers and
 * never in the thrown message.
 */
async function timedFetch(
  fetchFn: HermesFetch,
  url: string,
  init: Omit<HermesRequestInit, "signal">,
  timeoutMs: number,
): Promise<HermesHttpResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Hermes request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchFn(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Refuse any response that redirected or that is not a plain 200. */
function assertDirect200(res: HermesHttpResponse): void {
  if (res.redirected || (res.status >= 300 && res.status < 400)) {
    throw new Error("Hermes response was a redirect; redirects are not followed");
  }
}

// --- connect() -------------------------------------------------------------

export interface HermesConnection {
  officialSurface: true;
  standalonePreserved: true;
  baseUrl: string;
  model?: string;
  platform: HermesCapabilitiesValue["platform"];
  auth: HermesCapabilitiesValue["auth"];
  features: HermesCapabilitiesValue["features"];
  checkedAt: string;
}

export interface ConnectHermesArgs {
  /** Raw config; re-validated here (so an invalid config never reaches fetch). */
  config: HermesConfigInput;
  /** Grants. A `network` grant is required before any request. */
  policy: PermissionPolicy;
  deps?: HermesDeps;
  now?: Date;
}

/**
 * Prove a Hermes API Server is reachable and authenticated by validating
 * `GET /v1/capabilities`. Requires an explicit `network` grant before the fetch.
 * Returns a connection that records `officialSurface: true` and
 * `standalonePreserved: true`. Throws a bounded, token-free error otherwise.
 */
export async function connectHermes(args: ConnectHermesArgs): Promise<HermesConnection> {
  // Config validation happens first: an invalid config throws before any fetch.
  const config = resolveHermesConfig(args.config);
  const now = args.now ?? args.deps?.now?.() ?? new Date();

  // Permission gate BEFORE any network call. No grant => no fetch.
  requireGrant("network", args.policy, now);

  const fetchFn = args.deps?.fetch ?? nodeHermesFetch;
  const url = `${config.baseUrl}${CAPABILITIES_PATH}`;

  let res: HermesHttpResponse;
  try {
    res = await timedFetch(
      fetchFn,
      url,
      { method: "GET", headers: authHeaders(config) },
      config.timeoutMs,
    );
  } catch (err) {
    throw new Error(`Hermes capabilities request failed: ${safeDetail(err instanceof Error ? err.message : String(err), config.apiKey)}`);
  }

  assertDirect200(res);
  if (res.status !== 200) {
    throw new Error(`Hermes capabilities returned HTTP ${res.status}`);
  }

  const body = await res.readBodyCapped(config.maxResponseBytes);
  if (body.truncated) {
    throw new Error(`Hermes capabilities body exceeded the ${config.maxResponseBytes}-byte cap`);
  }

  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    throw new Error("Hermes capabilities body was not valid JSON");
  }

  const parsed = parseHermesCapabilities(json);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`Endpoint is not a Hermes API Server: ${parsed.errors.join("; ")}`);
  }

  return {
    officialSurface: true,
    standalonePreserved: true,
    baseUrl: config.baseUrl,
    ...(config.model !== undefined ? { model: config.model } : {}),
    platform: parsed.data.platform,
    auth: parsed.data.auth,
    features: parsed.data.features,
    checkedAt: now.toISOString(),
  };
}

// --- orchestrate() ---------------------------------------------------------

/** Fixed, safe system prompt. Hermes returns DATA only and never acts. */
const SYSTEM_PROMPT = [
  "You are a read-only planning assistant for a deterministic video editing engine.",
  "You do not have and must not assume any ability to edit files, run commands, render, or publish.",
  "Return DATA ONLY: a single JSON object and nothing else, matching the contract in the user message.",
  "Do not include prose, code fences, or any text outside the JSON object.",
  "Every field is advisory data the engine may or may not use; a human still approves before anything happens.",
].join(" ");

export interface HermesOrchestration {
  officialSurface: true;
  standalonePreserved: true;
  model: string;
  data: HermesOrchestrationResponseValue;
  producedAt: string;
}

export interface OrchestrateHermesArgs {
  config: HermesConfigInput;
  /** Small, structured request; re-validated here. */
  request: unknown;
  policy: PermissionPolicy;
  deps?: HermesDeps;
  now?: Date;
}

/** Build the user prompt: the request fields plus a direct top-level JSON contract. */
export function buildOrchestrationUserPrompt(request: HermesOrchestrationRequestValue): string {
  const lines: string[] = [
    `Objective: ${request.objective}`,
    `Workflow stage: ${request.workflowStage}`,
  ];
  if (request.contextText !== undefined && request.contextText.trim().length > 0) {
    lines.push("", "Context:", request.contextText);
  }
  if (request.artifactRefs && request.artifactRefs.length > 0) {
    lines.push("", "Artifact references (identifiers only, not media bytes):");
    for (const ref of request.artifactRefs) lines.push(`- ${ref}`);
  }
  lines.push(
    "",
    "Return exactly one top-level JSON object with these fields and no others:",
    JSON.stringify(
      {
        summary: "string: a short read of the situation",
        recommendedNextStep: "string: the single best next step",
        orderedActions: ["string: ordered, concrete actions (may be empty)"],
        warnings: ["string: risks or blockers (may be empty)"],
        requiresHumanApproval: "boolean: true if a human must approve before acting",
      },
      null,
      2,
    ),
    "",
    "Return DATA ONLY. Do not edit, run, or publish anything.",
  );
  return lines.join("\n");
}

/**
 * Send one bounded orchestration request to `POST /v1/chat/completions` and
 * return validated, DATA-ONLY guidance. Requires a `network` grant before the
 * fetch. The model output is JSON-parsed and schema-validated; it is never
 * executed. Throws a bounded, token-free error on any failure.
 */
export async function orchestrateHermes(args: OrchestrateHermesArgs): Promise<HermesOrchestration> {
  const config = resolveHermesConfig(args.config);
  const parsedReq = parseHermesOrchestrationRequest(args.request);
  if (!parsedReq.ok || !parsedReq.data) {
    throw new Error(`Invalid Hermes orchestration request: ${parsedReq.errors.join("; ")}`);
  }
  const request = parsedReq.data;
  const now = args.now ?? args.deps?.now?.() ?? new Date();

  requireGrant("network", args.policy, now);

  // Prove this endpoint is the documented Hermes API Server before sending any
  // orchestration context. This prevents a merely URL-shaped service from
  // receiving user data.
  await connectHermes({ config: args.config, policy: args.policy, ...(args.deps ? { deps: args.deps } : {}), now });

  const model = config.model ?? HERMES_DEFAULT_MODEL;
  const fetchFn = args.deps?.fetch ?? nodeHermesFetch;
  const url = `${config.baseUrl}${CHAT_PATH}`;
  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildOrchestrationUserPrompt(request) },
    ],
    stream: false,
  };

  let res: HermesHttpResponse;
  try {
    res = await timedFetch(
      fetchFn,
      url,
      { method: "POST", headers: { ...authHeaders(config), "content-type": "application/json" }, body: JSON.stringify(payload) },
      config.timeoutMs,
    );
  } catch (err) {
    throw new Error(`Hermes chat request failed: ${safeDetail(err instanceof Error ? err.message : String(err), config.apiKey)}`);
  }

  assertDirect200(res);
  if (res.status !== 200) {
    throw new Error(`Hermes chat returned HTTP ${res.status}`);
  }

  const body = await res.readBodyCapped(config.maxResponseBytes);
  if (body.truncated) {
    throw new Error(`Hermes chat body exceeded the ${config.maxResponseBytes}-byte cap`);
  }

  let envelopeJson: unknown;
  try {
    envelopeJson = JSON.parse(body.text);
  } catch {
    throw new Error("Hermes chat body was not valid JSON");
  }
  const envelope = parseChatCompletionEnvelope(envelopeJson);
  if (!envelope.ok || !envelope.data) {
    throw new Error(`Malformed chat completion envelope: ${envelope.errors.join("; ")}`);
  }

  const content = envelope.data.choices[0]!.message.content;
  let contentJson: unknown;
  try {
    contentJson = JSON.parse(content);
  } catch {
    throw new Error("Hermes chat content was not a JSON object");
  }

  const dataParsed = parseHermesOrchestrationResponse(contentJson);
  if (!dataParsed.ok || !dataParsed.data) {
    throw new Error(`Hermes orchestration response failed validation: ${dataParsed.errors.join("; ")}`);
  }

  return {
    officialSurface: true,
    standalonePreserved: true,
    model,
    data: dataParsed.data,
    producedAt: now.toISOString(),
  };
}

/** Authorization + Accept headers. The token appears ONLY here, never elsewhere. */
function authHeaders(config: HermesConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.apiKey}`,
    accept: "application/json",
  };
}

/** Re-export for callers that want a token-free view of a config. */
export { describeHermesConfig };
