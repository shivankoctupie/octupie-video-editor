import { describe, it, expect, beforeEach } from "vitest";
import { runAgentCli, type AgentCliDeps } from "../src/agent/cli.js";
import { CAPABILITY_IDS } from "../src/capabilities/registry.js";

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
});

function deps(): AgentCliDeps {
  return { log: (s) => out.push(s), errorLog: (s) => err.push(s) };
}

describe("agent capabilities command", () => {
  it("lists all eight parity capabilities as unavailable and exits 0", async () => {
    const code = await runAgentCli(["capabilities"], deps());
    expect(code).toBe(0);
    const text = out.join("\n");
    for (const id of CAPABILITY_IDS) expect(text).toContain(id);
    // Nothing is implemented, so no capability is reported verified or configured.
    expect(text).not.toMatch(/\bverified\b/);
    expect(text).toMatch(/unavailable/);
  });

  it("emits machine-readable JSON with --json that never claims a green gate", async () => {
    const code = await runAgentCli(["capabilities", "--json"], deps());
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.capabilities).toHaveLength(8);
    for (const c of parsed.capabilities) {
      expect(c.status).toBe("unavailable");
      expect(c.claimed).toBe(false);
    }
    // Permission defaults are surfaced and all default-deny.
    expect(parsed.permissions.defaultDeny).toBe(true);
    // Acceptance gates are all pending.
    expect(parsed.acceptance.green).toBe(0);
    expect(parsed.acceptance.pending).toBeGreaterThan(0);
  });
});
