import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAgentCli } from "../src/agent/cli.js";
import { produceHookVariants } from "../src/hooks/produce.js";
import { basePlan, FIXED_NOW } from "./hooks-fixtures.js";

function tempPlan(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ove-hooks-cli-"));
  const path = join(dir, "plan.json");
  writeFileSync(path, JSON.stringify(basePlan()), "utf8");
  return { dir, path };
}

describe("agent hook-variants", () => {
  it("produces exactly three real plan files offline", async () => {
    const t = tempPlan();
    const out = resolve("output", "__hooks_cli_test__");
    rmSync(out, { recursive: true, force: true });
    const logs: string[] = [];
    try {
      const code = await runAgentCli(["hook-variants", t.path, "--objective", "customer retention", "--count", "3", "--out", out, "--json"], { log: (s) => logs.push(s), now: FIXED_NOW });
      expect(code).toBe(0);
      const result = JSON.parse(logs[0]!);
      expect(result.set.variants).toHaveLength(3);
      expect(result.planPaths).toHaveLength(3);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("denies Claude before orchestration without network consent", async () => {
    const t = tempPlan();
    let calls = 0;
    try {
      const code = await runAgentCli(["hook-variants", t.path, "--objective", "x", "--count", "2", "--provider", "claude"], {
        produceHookVariants: async (input) => { calls++; return produceHookVariants({ ...input, providerId: "deterministic" }); },
        errorLog: () => {},
      });
      expect(code).toBe(2);
      expect(calls).toBe(0);
    } finally { rmSync(t.dir, { recursive: true, force: true }); }
  });

  it("rejects invalid counts and providers", async () => {
    const t = tempPlan();
    try {
      expect(await runAgentCli(["hook-variants", t.path, "--objective", "x", "--count", "11"], { errorLog: () => {} })).toBe(2);
      expect(await runAgentCli(["hook-variants", t.path, "--objective", "x", "--count", "2", "--provider", "other"], { errorLog: () => {} })).toBe(2);
    } finally { rmSync(t.dir, { recursive: true, force: true }); }
  });
});
