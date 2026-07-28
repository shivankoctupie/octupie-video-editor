import { describe, expect, it } from "vitest";
import { runAgentCli } from "../src/agent/cli.js";
import type { HermesConnection, HermesOrchestration } from "../src/hermes/client.js";
import { NOW, orchestrationData, TOKEN } from "./hermes-fixtures.js";

const connection: HermesConnection = {
  officialSurface: true,
  standalonePreserved: true,
  baseUrl: "http://127.0.0.1:8642",
  platform: "hermes-agent",
  auth: { type: "bearer", required: true },
  features: { chat_completions: true },
  checkedAt: NOW.toISOString(),
};
const orchestration: HermesOrchestration = {
  officialSurface: true,
  standalonePreserved: true,
  model: "hermes-agent",
  data: orchestrationData,
  producedAt: NOW.toISOString(),
};

function io() {
  const logs: string[] = [], errors: string[] = [];
  return { logs, errors, log: (s: string) => logs.push(s), errorLog: (s: string) => errors.push(s) };
}

describe("Hermes CLI", () => {
  it("blocks before the adapter without explicit network consent", async () => {
    let calls = 0;
    const out = io();
    const code = await runAgentCli(["hermes-check", "--endpoint", "http://127.0.0.1:8642"], { ...out, env: { OCTUPIE_HERMES_API_KEY: TOKEN }, hermesConnect: async () => { calls++; return connection; } });
    expect(code).toBe(2);
    expect(calls).toBe(0);
  });

  it("blocks before the adapter without the dedicated token env", async () => {
    let calls = 0;
    const out = io();
    const code = await runAgentCli(["hermes-check", "--endpoint", "http://127.0.0.1:8642", "--allow-network"], { ...out, env: {}, hermesConnect: async () => { calls++; return connection; } });
    expect(code).toBe(2);
    expect(calls).toBe(0);
    expect(out.errors.join(" ")).not.toContain(TOKEN);
  });

  it("rejects tokens passed on argv", async () => {
    const out = io();
    const code = await runAgentCli(["hermes-check", "--endpoint", "http://127.0.0.1:8642", "--allow-network", "--token", TOKEN], { ...out, env: { OCTUPIE_HERMES_API_KEY: TOKEN } });
    expect(code).toBe(2);
    expect([...out.logs, ...out.errors].join(" ")).not.toContain(TOKEN);
  });

  it("connects with an environment token but never prints it", async () => {
    const out = io();
    let received = "";
    const code = await runAgentCli(["hermes-check", "--endpoint", "http://127.0.0.1:8642", "--allow-network", "--json"], {
      ...out, env: { OCTUPIE_HERMES_API_KEY: TOKEN }, now: NOW,
      hermesConnect: async (args) => { received = args.config.apiKey; return connection; },
    });
    expect(code).toBe(0);
    expect(received).toBe(TOKEN);
    expect([...out.logs, ...out.errors].join(" ")).not.toContain(TOKEN);
  });

  it("orchestrates data only through the injected official adapter", async () => {
    const out = io();
    let calls = 0;
    const code = await runAgentCli(["hermes-orchestrate", "--endpoint", "http://127.0.0.1:8642", "--objective", "Review opening", "--stage", "qa", "--allow-network", "--json"], {
      ...out, env: { OCTUPIE_HERMES_API_KEY: TOKEN }, now: NOW,
      hermesOrchestrate: async (args) => { calls++; expect(args.request).toMatchObject({ objective: "Review opening", workflowStage: "qa" }); return orchestration; },
    });
    expect(code).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.parse(out.logs[0]!).data).toEqual(orchestrationData);
    expect(out.logs.join(" ")).not.toContain(TOKEN);
  });
});
