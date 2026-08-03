import { afterEach, describe, expect, it } from "vitest";
import { parseAdapterOutput, type AdapterOutputValue, type PublishRequestValue } from "../src/workflow/schemas.js";
import type { FetchInitLike, FetchLike, FetchResponseLike } from "../src/util/fetchLike.js";
import type { HostResolver } from "../src/util/ssrf.js";
import {
  createWebhookPublishingAdapter,
  describeWebhookAdapter,
  type WebhookPublishingConfig,
} from "../src/workflow/webhookPublishing.js";

// A distinctive secret so a leak check on the serialized output is unambiguous.
const SECRET_ENV = "OCT_WEBHOOK_TEST_SECRET";
const SECRET = "sk-test-do-not-leak-4c3b2a1";

afterEach(() => {
  delete process.env[SECRET_ENV];
});

/** A minimal, valid publish request. The outer gate flow builds a real one; the
 * adapter only ever sees an already-validated request, so this is enough. */
function makeRequest(overrides: Partial<PublishRequestValue> = {}): PublishRequestValue {
  return {
    format: "octupie-workflow-publish-request/v1",
    versionId: "ver-1",
    projectId: "proj-1",
    adapterId: "webhook",
    requestedBy: "publisher-1",
    role: "publisher",
    rightsConfirmed: true,
    qaPassed: true,
    idempotencyKey: "idem-1",
    requestedAt: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

/** A structural response stub. `arrayBuffer` carries the real bytes so the byte cap
 * and JSON parse run against genuine content. */
function makeResponse(status: number, body?: unknown): FetchResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return {
    status,
    headers: { get: () => null },
    arrayBuffer: async () => buffer,
    text: async () => text,
    json: async () => (body === undefined ? undefined : JSON.parse(text)),
  };
}

interface CapturingFetch {
  fetch: FetchLike;
  calls: Array<{ url: string; init?: FetchInitLike }>;
}

/** An injected fetch that records every (url, init) and returns a fixed response. No
 * real network is ever touched. */
function capturingFetch(response: FetchResponseLike): CapturingFetch {
  const calls: Array<{ url: string; init?: FetchInitLike }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetch, calls };
}

const resolvePublic: HostResolver = async () => ["93.184.216.34"];
const resolvePrivate: HostResolver = async () => ["10.0.0.5"];

function baseConfig(fetch: FetchLike, overrides: Partial<WebhookPublishingConfig> = {}): WebhookPublishingConfig {
  return {
    endpointUrl: "https://hooks.example.com/publish",
    allowedHosts: ["hooks.example.com"],
    fetch,
    resolve: resolvePublic,
    ...overrides,
  };
}

/** Every returned result, blocked or not, must validate as data-only output. */
function expectValidOutput(result: AdapterOutputValue): void {
  expect(parseAdapterOutput(result).ok).toBe(true);
}

describe("webhook publishing adapter is opt-in and SSRF-guarded", () => {
  it("is disabled and blocks when endpointUrl is empty; fetch is not called", async () => {
    const cap = capturingFetch(makeResponse(200, { id: "abc" }));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch, { endpointUrl: "" }));
    expect(adapter.enabled).toBe(false);
    const result = await adapter.publish(makeRequest());
    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBeDefined();
    expect(cap.calls).toHaveLength(0);
    expectValidOutput(result);
  });

  it("is disabled and blocks when allowedHosts is empty; fetch is not called", async () => {
    const cap = capturingFetch(makeResponse(200, { id: "abc" }));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch, { allowedHosts: [] }));
    expect(adapter.enabled).toBe(false);
    const result = await adapter.publish(makeRequest());
    expect(result.ok).toBe(false);
    expect(cap.calls).toHaveLength(0);
    expectValidOutput(result);
  });

  it("refuses a non-HTTPS endpoint; fetch is not called", async () => {
    const cap = capturingFetch(makeResponse(200, { id: "abc" }));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch, { endpointUrl: "http://hooks.example.com/publish" }));
    expect(adapter.enabled).toBe(true);
    const result = await adapter.publish(makeRequest());
    expect(result.ok).toBe(false);
    expect(cap.calls).toHaveLength(0);
    expectValidOutput(result);
  });

  it("blocks a host that is not on the allowlist; fetch is not called", async () => {
    const cap = capturingFetch(makeResponse(200, { id: "abc" }));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch, { endpointUrl: "https://evil.example.net/publish" }));
    const result = await adapter.publish(makeRequest());
    expect(result.ok).toBe(false);
    expect(cap.calls).toHaveLength(0);
    expectValidOutput(result);
  });

  it("matches the allowlist case-insensitively", async () => {
    const cap = capturingFetch(makeResponse(200, { id: "abc" }));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch, { allowedHosts: ["HOOKS.EXAMPLE.COM"] }));
    const result = await adapter.publish(makeRequest());
    expect(result.ok).toBe(true);
    expect(cap.calls).toHaveLength(1);
    expectValidOutput(result);
  });

  it("blocks when the host resolves to a private address; fetch is not called", async () => {
    const cap = capturingFetch(makeResponse(200, { id: "abc" }));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch, { resolve: resolvePrivate }));
    const result = await adapter.publish(makeRequest());
    expect(result.ok).toBe(false);
    expect(cap.calls).toHaveLength(0);
    expectValidOutput(result);
  });

  it("posts to an allowlisted HTTPS host and returns a bounded providerRef without leaking the secret", async () => {
    process.env[SECRET_ENV] = SECRET;
    const cap = capturingFetch(makeResponse(200, { id: "abc" }));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch, { secretEnv: SECRET_ENV }));
    const result = await adapter.publish(makeRequest());
    expect(result.ok).toBe(true);
    expect(result.providerRef).toBe("abc");
    expect(result.data).toEqual({ status: 200, host: "hooks.example.com" });

    expect(cap.calls).toHaveLength(1);
    const init = cap.calls[0]?.init;
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.headers?.["Content-Type"]).toBe("application/json");
    expect(init?.headers?.["Authorization"]).toBe(`Bearer ${SECRET}`);

    // The outgoing body is data only and carries the request identifiers.
    const sentBody = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
    expect(sentBody).toMatchObject({
      versionId: "ver-1",
      projectId: "proj-1",
      adapterId: "webhook",
      idempotencyKey: "idem-1",
      requestedBy: "publisher-1",
    });

    // The secret is never returned in the adapter output.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expectValidOutput(result);
  });

  it("omits the Authorization header when no secret env is configured and reads providerRef from ref", async () => {
    const cap = capturingFetch(makeResponse(200, { ref: "ref-9" }));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch));
    const result = await adapter.publish(makeRequest());
    expect(result.ok).toBe(true);
    expect(result.providerRef).toBe("ref-9");
    const init = cap.calls[0]?.init;
    expect(init?.headers?.["Authorization"]).toBeUndefined();
    expectValidOutput(result);
  });

  it("blocks on a non-2xx response and does not throw", async () => {
    const cap = capturingFetch(makeResponse(500, { error: "boom" }));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch));
    const result = await adapter.publish(makeRequest());
    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBeDefined();
    expect(cap.calls).toHaveLength(1);
    expectValidOutput(result);
  });

  it("refuses a 3xx redirect response", async () => {
    const cap = capturingFetch(makeResponse(302));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch));
    const result = await adapter.publish(makeRequest());
    expect(result.ok).toBe(false);
    expectValidOutput(result);
  });

  it("blocks a response body that exceeds the byte cap", async () => {
    const cap = capturingFetch(makeResponse(200, { id: "abc", pad: "x".repeat(500) }));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch, { maxResponseBytes: 32 }));
    const result = await adapter.publish(makeRequest());
    expect(result.ok).toBe(false);
    expectValidOutput(result);
  });

  it("honors a custom adapter id", () => {
    const cap = capturingFetch(makeResponse(200, { id: "abc" }));
    const adapter = createWebhookPublishingAdapter(baseConfig(cap.fetch, { id: "octupie-webhook" }));
    expect(adapter.id).toBe("octupie-webhook");
  });

  it("describes the adapter without ever claiming it is verified", () => {
    const cap = capturingFetch(makeResponse(200, { id: "abc" }));
    expect(describeWebhookAdapter(baseConfig(cap.fetch))).toEqual({
      id: "webhook",
      enabled: true,
      configured: true,
      verified: false,
    });
    expect(describeWebhookAdapter(baseConfig(cap.fetch, { allowedHosts: [] }))).toEqual({
      id: "webhook",
      enabled: false,
      configured: false,
      verified: false,
    });
  });
});
