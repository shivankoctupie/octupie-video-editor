import { describe, expect, it } from "vitest";
import { connectHermes, orchestrateHermes, type HermesFetch } from "../src/hermes/client.js";
import { capabilities, networkPolicy, noNetworkPolicy, NOW, orchestrationData, response, sequenceFetch, TOKEN } from "./hermes-fixtures.js";

const config = { surface: "api", baseUrl: "http://127.0.0.1:8642", apiKey: TOKEN, timeoutMs: 50 } as const;
const request = { objective: "Review the opening", workflowStage: "draft-qa", contextText: "A short text-only context." };

describe("official Hermes API adapter", () => {
  it("does not fetch without a network grant", async () => {
    let calls = 0;
    await expect(connectHermes({ config, policy: noNetworkPolicy(), deps: { fetch: async () => { calls++; return response(capabilities); } }, now: NOW })).rejects.toThrow(/Permission denied/);
    expect(calls).toBe(0);
  });

  it("does not fetch with an invalid config", async () => {
    let calls = 0;
    await expect(connectHermes({ config: { ...config, baseUrl: "http://example.com" }, policy: networkPolicy(), deps: { fetch: async () => { calls++; return response(capabilities); } }, now: NOW })).rejects.toThrow(/Invalid Hermes base URL/);
    expect(calls).toBe(0);
  });

  it("connects only after validating the official capabilities response", async () => {
    const calls: Array<{ url: string; init: Parameters<HermesFetch>[1] }> = [];
    const result = await connectHermes({ config, policy: networkPolicy(), deps: { fetch: sequenceFetch([response(capabilities)], calls) }, now: NOW });
    expect(result.officialSurface).toBe(true);
    expect(result.standalonePreserved).toBe(true);
    expect(result.platform).toBe("hermes-agent");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8642/v1/capabilities");
    expect(calls[0]!.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("rejects redirects, oversized bodies, and non-Hermes endpoints", async () => {
    for (const bad of [response(capabilities, { redirected: true }), response(capabilities, { truncated: true }), response({ ...capabilities, platform: "impostor" })]) {
      await expect(connectHermes({ config, policy: networkPolicy(), deps: { fetch: async () => bad }, now: NOW })).rejects.toThrow();
    }
  });

  it("redacts the exact token and bounds transport errors", async () => {
    const fetch: HermesFetch = async () => { throw new Error(`${TOKEN} ${"x".repeat(2000)}`); };
    const outcome = await connectHermes({ config, policy: networkPolicy(), deps: { fetch }, now: NOW }).then(
      () => ({ ok: true as const, message: "" }),
      (e: Error) => ({ ok: false as const, message: e.message }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).not.toContain(TOKEN);
    expect(outcome.message.length).toBeLessThan(500);
  });

  it("times out a stalled transport", async () => {
    const fetch: HermesFetch = async () => await new Promise(() => {});
    await expect(connectHermes({ config: { ...config, timeoutMs: 1 }, policy: networkPolicy(), deps: { fetch }, now: NOW })).rejects.toThrow(/timed out/);
  });

  it("proves capabilities before sending bounded orchestration context", async () => {
    const calls: Array<{ url: string; init: Parameters<HermesFetch>[1] }> = [];
    const envelope = { choices: [{ message: { role: "assistant", content: JSON.stringify(orchestrationData) } }] };
    const result = await orchestrateHermes({ config, request, policy: networkPolicy(), deps: { fetch: sequenceFetch([response(capabilities), response(envelope)], calls) }, now: NOW });
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:8642/v1/capabilities", "http://127.0.0.1:8642/v1/chat/completions"]);
    expect(result.data).toEqual(orchestrationData);
    const payload = JSON.parse(calls[1]!.init.body!);
    expect(payload.stream).toBe(false);
    expect(payload.messages[0].content).toMatch(/do not.*edit files.*run commands.*publish/i);
    expect(payload.messages[1].content).toContain("Return DATA ONLY");
  });

  it("never sends context when the capabilities endpoint is malformed", async () => {
    const calls: Array<{ url: string; init: Parameters<HermesFetch>[1] }> = [];
    await expect(orchestrateHermes({ config, request, policy: networkPolicy(), deps: { fetch: sequenceFetch([response({ ok: true })], calls) }, now: NOW })).rejects.toThrow(/not a Hermes API Server/);
    expect(calls).toHaveLength(1);
  });

  it.each([
    response({ choices: [] }),
    response({ choices: [{ message: { content: "not json" } }] }),
    response({ choices: [{ message: { content: JSON.stringify({ ...orchestrationData, execute: "calc.exe" }) } }] }),
  ])("rejects malformed or executable-looking provider output as data", async (badChat) => {
    await expect(orchestrateHermes({ config, request, policy: networkPolicy(), deps: { fetch: sequenceFetch([response(capabilities), badChat], []) }, now: NOW })).rejects.toThrow();
  });
});
