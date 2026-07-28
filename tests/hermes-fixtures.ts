import type { PermissionPolicy } from "../src/permissions/policy.js";
import { createPolicy } from "../src/permissions/policy.js";
import type { HermesFetch, HermesHttpResponse } from "../src/hermes/client.js";

export const NOW = new Date("2026-07-28T12:00:00.000Z");
export const TOKEN = "unit-test-hermes-token-value";

export function networkPolicy(): PermissionPolicy {
  return createPolicy([{ action: "network", grantedBy: "test", grantedAt: NOW.toISOString(), reason: "test" }]);
}

export function noNetworkPolicy(): PermissionPolicy { return createPolicy([]); }

export const capabilities = {
  object: "hermes.api_server.capabilities",
  platform: "hermes-agent",
  model: "editor",
  auth: { type: "bearer", required: true },
  features: { chat_completions: true, responses_api: true, run_submission: true },
};

export const orchestrationData = {
  summary: "The draft is ready for deterministic QA.",
  recommendedNextStep: "Run render QA and request human approval.",
  orderedActions: ["Validate the plan.", "Render the draft."],
  warnings: ["Do not publish without approval."],
  requiresHumanApproval: true,
};

export function response(body: unknown, opts: { status?: number; redirected?: boolean; truncated?: boolean } = {}): HermesHttpResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status: opts.status ?? 200,
    redirected: opts.redirected ?? false,
    headers: { get: () => "application/json" },
    readBodyCapped: async () => ({ text: opts.truncated ? "" : text, truncated: opts.truncated ?? false }),
  };
}

export function sequenceFetch(items: Array<HermesHttpResponse | Error>, calls: Array<{ url: string; init: Parameters<HermesFetch>[1] }>): HermesFetch {
  return async (url, init) => {
    calls.push({ url, init });
    const item = items.shift();
    if (!item) throw new Error("unexpected fetch");
    if (item instanceof Error) throw item;
    return item;
  };
}
