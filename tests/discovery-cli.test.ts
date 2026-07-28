import { describe, expect, it } from "vitest";
import { runAgentCli } from "../src/agent/cli.js";
import type { DiscoverAssetsInput, DiscoverAssetsResult } from "../src/discovery/discover.js";

function harness(result?: DiscoverAssetsResult) {
  const logs: string[] = [];
  const errors: string[] = [];
  const calls: DiscoverAssetsInput[] = [];
  const discoverAssets = async (input: DiscoverAssetsInput): Promise<DiscoverAssetsResult> => {
    calls.push(input);
    return result ?? { candidates: [], diagnostics: [], sourcesQueried: input.query.sources };
  };
  return { logs, errors, calls, discoverAssets };
}

describe("agent discover-assets", () => {
  it("runs local discovery offline with a bounded query", async () => {
    const h = harness();
    const code = await runAgentCli(
      ["discover-assets", "--intent", "team workshop", "--source", "local", "--asset-root", "assets", "--max-results", "7", "--json"],
      { discoverAssets: h.discoverAssets, log: (s) => h.logs.push(s), errorLog: (s) => h.errors.push(s), now: new Date("2026-07-28T00:00:00.000Z") },
    );
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.query).toMatchObject({ intent: "team workshop", sources: ["local"], maxResults: 7 });
    expect(h.calls[0]!.permissionPolicy!.grants).toHaveLength(0);
    expect(JSON.parse(h.logs[0]!)).toMatchObject({ candidates: [], sourcesQueried: ["local"] });
  });

  it("denies remote discovery before provider invocation without explicit network consent", async () => {
    const h = harness();
    const code = await runAgentCli(
      ["discover-assets", "--intent", "launch", "--source", "local,drive"],
      { discoverAssets: h.discoverAssets, log: (s) => h.logs.push(s), errorLog: (s) => h.errors.push(s) },
    );
    expect(code).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.errors.join(" ")).toMatch(/allow-network/);
  });

  it("passes a network grant for explicitly approved remote reference discovery", async () => {
    const h = harness();
    const code = await runAgentCli(
      ["discover-assets", "--intent", "launch", "--source", "drive,web", "--allow-network"],
      { discoverAssets: h.discoverAssets, log: (s) => h.logs.push(s), errorLog: (s) => h.errors.push(s), now: new Date("2026-07-28T00:00:00.000Z") },
    );
    expect(code).toBe(0);
    expect(h.calls[0]!.permissionPolicy!.grants.map((g) => g.action)).toEqual(["network"]);
  });

  it("rejects unknown sources and unbounded result counts", async () => {
    const h = harness();
    expect(await runAgentCli(["discover-assets", "--intent", "x", "--source", "stock"], { discoverAssets: h.discoverAssets, errorLog: (s) => h.errors.push(s) })).toBe(2);
    expect(await runAgentCli(["discover-assets", "--intent", "x", "--max-results", "999"], { discoverAssets: h.discoverAssets, errorLog: (s) => h.errors.push(s) })).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});
