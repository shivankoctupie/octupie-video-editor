import { describe, expect, it } from "vitest";
import { buildClaudeHookArgs, produceHookVariantsWithClaude } from "../src/hooks/claudeHooks.js";
import { deterministicHookVariants, produceHookVariants } from "../src/hooks/produce.js";
import { createPolicy } from "../src/permissions/policy.js";
import type { ExecFn } from "../src/agent/exec.js";
import type { HookVariantRequestValue } from "../src/hooks/schemas.js";
import { basePlan, FIXED_NOW } from "./hooks-fixtures.js";

const request = (): HookVariantRequestValue => ({ objective: "explain customer retention", count: 3, sourcePlan: basePlan() });

function runnerFor(stdout: string, overrides: Partial<Awaited<ReturnType<ExecFn>>> = {}) {
  const calls: Array<{ binary: string; args: readonly string[]; input?: string; maxBuffer?: number }> = [];
  const runner: ExecFn = async (binary, args, opts) => {
    calls.push({ binary, args, ...(opts?.input !== undefined ? { input: opts.input } : {}), ...(opts?.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}) });
    return { code: 0, stdout, stderr: "", timedOut: false, ...overrides };
  };
  return { runner, calls };
}

describe("restricted Claude hook provider", () => {
  it("uses no tools, isolated MCP, no session, and a direct object schema", () => {
    const args = buildClaudeHookArgs("system");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]!);
    expect(schema.type).toBe("object");
  });

  it("passes the bounded prompt on stdin and parses strict structured output", async () => {
    const variants = deterministicHookVariants(request());
    const h = runnerFor(JSON.stringify({ structured_output: { variants } }));
    const out = await produceHookVariantsWithClaude({ request: request(), now: FIXED_NOW, runner: h.runner, config: { binary: "claude-test" } });
    expect(out).toHaveLength(3);
    expect(h.calls[0]!.binary).toBe("claude-test");
    expect(h.calls[0]!.args.join(" ")).not.toContain("explain customer retention");
    expect(h.calls[0]!.input).toContain("explain customer retention");
    expect(h.calls[0]!.maxBuffer).toBeLessThanOrEqual(1024 * 1024);
  });

  it("rejects truncated and schema-invalid output", async () => {
    const truncated = runnerFor("{}", { truncated: true });
    await expect(produceHookVariantsWithClaude({ request: request(), runner: truncated.runner })).rejects.toThrow(/exceeded/);
    const invalid = runnerFor(JSON.stringify({ structured_output: { variants: [{ forged: true }] } }));
    await expect(produceHookVariantsWithClaude({ request: request(), runner: invalid.runner })).rejects.toThrow(/validation/);
  });

  it("denies network before invoking a Claude provider", async () => {
    let calls = 0;
    await expect(produceHookVariants({
      request: request(),
      providerId: "claude",
      permissionPolicy: createPolicy([]),
      now: FIXED_NOW,
      claudeProvider: { id: "spy", produce: async () => { calls++; return []; } },
    })).rejects.toThrow(/network/);
    expect(calls).toBe(0);
  });

  it("fails on provider shortfall unless deterministic fallback is explicit", async () => {
    const provider = { id: "short", produce: async () => deterministicHookVariants(request()).slice(0, 2) };
    const grants = createPolicy([{ action: "network", grantedBy: "test", grantedAt: FIXED_NOW.toISOString() }]);
    await expect(produceHookVariants({ request: request(), providerId: "claude", permissionPolicy: grants, now: FIXED_NOW, claudeProvider: provider })).rejects.toThrow(/exactly 3/);
    const fallback = await produceHookVariants({ request: request(), providerId: "claude", permissionPolicy: grants, now: FIXED_NOW, claudeProvider: provider, allowDeterministicFallback: true });
    expect(fallback.set.provider.id).toBe("deterministic-fallback");
    expect(fallback.set.variants).toHaveLength(3);
  });
});
