import { describe, it, expect } from "vitest";
import { redactSecrets, truncate, enforceMaxSize, MAX_SIZES } from "../src/agent/redact.js";

describe("redactSecrets", () => {
  it("redacts Anthropic-style keys", () => {
    const out = redactSecrets("token sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234567890 end");
    expect(out).not.toMatch(/sk-ant-api03-AAAABBBB/);
    expect(out).toMatch(/\[REDACTED\]/);
  });

  it("redacts OpenAI-style keys", () => {
    const out = redactSecrets("key=sk-proj-abcdEFGH1234567890abcdEFGH1234567890abcd");
    expect(out).not.toMatch(/abcdEFGH1234567890abcdEFGH/);
    expect(out).toMatch(/\[REDACTED\]/);
  });

  it("redacts AWS access key ids", () => {
    const out = redactSecrets("aws AKIAIOSFODNN7EXAMPLE here");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts Bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abc.def.ghijklmnopqrstuvwxyz012345");
    expect(out).toMatch(/Bearer \[REDACTED\]/);
    expect(out).not.toMatch(/ghijklmnopqrstuvwxyz/);
  });

  it("redacts KEY=secret assignments for common secret env names", () => {
    const out = redactSecrets("ANTHROPIC_API_KEY=supersecretvalue1234567890");
    expect(out).not.toContain("supersecretvalue1234567890");
    expect(out).toMatch(/ANTHROPIC_API_KEY=\[REDACTED\]/);
  });

  it("leaves ordinary text untouched", () => {
    const text = "The founder wants a 12 second reel about onboarding.";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("truncate", () => {
  it("clamps long text and marks truncation", () => {
    const out = truncate("x".repeat(100), 10);
    expect(out.length).toBeLessThan(100);
    expect(out).toMatch(/truncated/i);
  });

  it("returns short text unchanged", () => {
    expect(truncate("hi", 100)).toBe("hi");
  });
});

describe("enforceMaxSize", () => {
  it("throws when input exceeds the limit", () => {
    expect(() => enforceMaxSize("x".repeat(20), 10, "brief")).toThrow(/brief.*too large/i);
  });

  it("passes when within the limit", () => {
    expect(() => enforceMaxSize("ok", 10, "brief")).not.toThrow();
  });

  it("exposes concrete max size constants", () => {
    expect(MAX_SIZES.brief).toBeGreaterThan(0);
    expect(MAX_SIZES.transcript).toBeGreaterThan(0);
    expect(MAX_SIZES.rule).toBeGreaterThan(0);
    expect(MAX_SIZES.modelResponse).toBeGreaterThan(0);
  });
});
