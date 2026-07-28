import { describe, expect, it } from "vitest";
import {
  checkBaseUrl,
  describeHermesConfig,
  parseChatCompletionEnvelope,
  parseHermesCapabilities,
  parseHermesOrchestrationRequest,
  parseHermesOrchestrationResponse,
  resolveHermesConfig,
} from "../src/hermes/schemas.js";
import { capabilities, orchestrationData, TOKEN } from "./hermes-fixtures.js";

describe("Hermes API schemas and config", () => {
  it("accepts documented loopback HTTP including its port", () => {
    expect(checkBaseUrl("http://127.0.0.1:8642/")).toEqual({ ok: true, normalized: "http://127.0.0.1:8642" });
    expect(checkBaseUrl("http://localhost:8642/prefix/").ok).toBe(true);
    expect(checkBaseUrl("http://[::1]:8642").ok).toBe(true);
  });

  it("requires HTTPS for remote hosts", () => {
    expect(checkBaseUrl("http://example.com:8642").ok).toBe(false);
    expect(checkBaseUrl("https://example.com/hermes/")).toEqual({ ok: true, normalized: "https://example.com/hermes" });
  });

  it.each(["file:///tmp/x", "https://u:p@example.com", "https://example.com/#x", "https://example.com/?token=x"])("rejects unsafe URL %s", (url) => {
    expect(checkBaseUrl(url).ok).toBe(false);
  });

  it("supports only the official API surface and hides the token from serialization", () => {
    expect(() => resolveHermesConfig({ surface: "plugin", baseUrl: "https://example.com", apiKey: TOKEN })).toThrow(/only 'api'/);
    const config = resolveHermesConfig({ surface: "api", baseUrl: "http://127.0.0.1:8642", apiKey: TOKEN });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(describeHermesConfig(config)).not.toHaveProperty("apiKey");
  });

  it("accepts only the documented Hermes capabilities identity", () => {
    expect(parseHermesCapabilities(capabilities).ok).toBe(true);
    expect(parseHermesCapabilities({ ...capabilities, object: "capabilities" }).ok).toBe(false);
    expect(parseHermesCapabilities({ ...capabilities, platform: "other-agent" }).ok).toBe(false);
    expect(parseHermesCapabilities({ ...capabilities, auth: { type: "none", required: false } }).ok).toBe(false);
  });

  it("bounds orchestration request fields and forbids extras", () => {
    expect(parseHermesOrchestrationRequest({ objective: "QA", workflowStage: "review" }).ok).toBe(true);
    expect(parseHermesOrchestrationRequest({ objective: "QA", workflowStage: "review", rawMedia: "bytes" }).ok).toBe(false);
    expect(parseHermesOrchestrationRequest({ objective: "x".repeat(2001), workflowStage: "review" }).ok).toBe(false);
  });

  it("validates strict data-only orchestration output", () => {
    expect(parseHermesOrchestrationResponse(orchestrationData).ok).toBe(true);
    expect(parseHermesOrchestrationResponse({ ...orchestrationData, command: "rm -rf /" }).ok).toBe(false);
    expect(parseHermesOrchestrationResponse({ ...orchestrationData, orderedActions: Array(21).fill("x") }).ok).toBe(false);
  });

  it("validates the OpenAI-compatible final-text envelope", () => {
    expect(parseChatCompletionEnvelope({ choices: [{ message: { role: "assistant", content: "{}" } }] }).ok).toBe(true);
    expect(parseChatCompletionEnvelope({ choices: [] }).ok).toBe(false);
    expect(parseChatCompletionEnvelope({ choices: [{ message: { content: 3 } }] }).ok).toBe(false);
  });
});
