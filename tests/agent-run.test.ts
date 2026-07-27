import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRun } from "../src/agent/run.js";
import { createDeterministicProvider } from "../src/agent/providers/deterministic.js";
import { addFeedbackRule, readRunRecords } from "../src/agent/learning.js";
import type { Provider, ProviderRequest, ProviderResult } from "../src/agent/providers/types.js";
import { buildDeterministicPlan } from "../src/agent/plan.js";
import type { AgentBrief } from "../src/agent/brief.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ove-run-"));
});

const AT = new Date("2026-07-27T10:00:00Z");

function brief(over: Partial<AgentBrief> = {}): AgentBrief {
  return {
    format: "octupie-agent-brief/v1",
    objective: "Explain onboarding",
    audience: "founders",
    platform: "reels",
    preset: "neutral-founder-reel",
    desiredDurationSeconds: 8,
    sourceClips: [],
    transcript: { text: "We shipped onboarding in a day." },
    output: { fileName: "output/x.mp4" },
    constraints: [],
    scope: { creator: "shivank" },
    ...over,
  } as AgentBrief;
}

function readJson(p: string): any {
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("agentRun offline end-to-end (no render)", () => {
  it("plans, writes a full audit directory, and records the run", async () => {
    const res = await agentRun({
      brief: brief(),
      provider: createDeterministicProvider(),
      home,
      render: false,
      runId: "run_test1",
      now: AT,
    });

    expect(res.status).toBe("ok");
    expect(res.accepted).toBe(true);
    expect(res.rendered).toBe(false);

    const dir = res.runDir;
    expect(existsSync(join(dir, "brief.sanitized.json"))).toBe(true);
    expect(existsSync(join(dir, "asset-manifest.txt"))).toBe(true);
    expect(existsSync(join(dir, "final-plan.json"))).toBe(true);
    expect(existsSync(join(dir, "result.json"))).toBe(true);

    const result = readJson(join(dir, "result.json"));
    expect(result.status).toBe("ok");
    expect(result.provider).toBe("deterministic");
    expect(result.accepted).toBe(true);

    const finalPlan = readJson(join(dir, "final-plan.json"));
    expect(finalPlan.format).toBe("octupie-edit-plan/v1");

    // Iteration artifacts exist.
    const iterFiles = readdirSync(join(dir, "iterations"));
    expect(iterFiles.length).toBeGreaterThanOrEqual(1);

    // Never copies source media into the audit directory.
    const allFiles = readdirSync(dir);
    expect(allFiles.some((f) => f.endsWith(".mp4"))).toBe(false);

    // Run record appended.
    const records = readRunRecords(home);
    expect(records).toHaveLength(1);
    expect(records[0]!.runId).toBe("run_test1");
  });

  it("includes only applicable scoped rules in the audit", async () => {
    addFeedbackRule(home, { scope: "global", text: "Cut on phrase boundaries", now: AT });
    addFeedbackRule(home, { scope: "creator", creator: "shivank", text: "No stock footage", now: AT });
    addFeedbackRule(home, { scope: "creator", creator: "someone-else", text: "Should not appear", now: AT });

    const res = await agentRun({
      brief: brief(),
      provider: createDeterministicProvider(),
      home,
      render: false,
      runId: "run_rules",
      now: AT,
    });

    const rules = readJson(join(res.runDir, "rules.json"));
    const texts = rules.rules.map((r: any) => r.text);
    expect(texts).toContain("Cut on phrase boundaries");
    expect(texts).toContain("No stock footage");
    expect(texts).not.toContain("Should not appear");
    expect(res.activeRuleIds.length).toBe(2);
  });

  it("redacts secrets from raw model replies in the audit", async () => {
    const built = buildDeterministicPlan(brief());
    const planText = JSON.stringify(built.plan) + "\n\ndebug token sk-ant-api03-SECRETSECRETSECRETSECRET1234";
    const provider: Provider = {
      id: "leaky",
      async generate(req: ProviderRequest): Promise<ProviderResult> {
        if (req.kind === "plan") {
          return {
            ok: true,
            text: planText,
            meta: { apiKey: "sk-proj-SECRETSECRETSECRETSECRET1234567890" },
          };
        }
        return { ok: true, text: JSON.stringify({ approved: true, issues: [] }), meta: {} };
      },
      async diagnose() {
        return { id: "leaky", available: true, authenticated: true, authSource: "test", detail: "" };
      },
    };

    const res = await agentRun({ brief: brief(), provider, home, render: false, runId: "run_leak", now: AT });
    const iterText = readFileSync(join(res.runDir, "iterations", readdirSync(join(res.runDir, "iterations"))[0]!), "utf8");
    expect(iterText).not.toContain("SECRETSECRETSECRETSECRET1234");
    expect(iterText).toMatch(/REDACTED/);
    expect(res.status).toBe("ok");
  });

  it("records a render failure without losing the plan", async () => {
    const res = await agentRun({
      brief: brief(),
      provider: createDeterministicProvider(),
      home,
      render: true,
      runId: "run_render_fail",
      now: AT,
      renderFn: async () => {
        throw new Error("ffmpeg not installed");
      },
    });

    expect(res.status).toBe("render-failed");
    expect(res.rendered).toBe(false);
    expect(existsSync(join(res.runDir, "final-plan.json"))).toBe(true);
    const result = readJson(join(res.runDir, "result.json"));
    expect(result.failure).toMatch(/ffmpeg not installed/);
  });

  it("passes the validated plan to renderFn and records render paths on success", async () => {
    let receivedPlan: any;
    const res = await agentRun({
      brief: brief(),
      provider: createDeterministicProvider(),
      home,
      render: true,
      runId: "run_render_ok",
      now: AT,
      renderFn: async (plan) => {
        receivedPlan = plan;
        return { finalPath: "output/x.mp4", qaReportPath: "output/x.qa.json", pass: true };
      },
    });
    expect(receivedPlan.format).toBe("octupie-edit-plan/v1");
    expect(res.rendered).toBe(true);
    expect(res.status).toBe("ok");
    const result = readJson(join(res.runDir, "result.json"));
    expect(result.render.finalPath).toBe("output/x.mp4");
    expect(result.render.pass).toBe(true);
  });
});
