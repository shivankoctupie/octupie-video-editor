import { describe, it, expect } from "vitest";
import { runPlannerLoop } from "../src/agent/planner.js";
import { buildDeterministicPlan } from "../src/agent/plan.js";
import { createDeterministicProvider } from "../src/agent/providers/deterministic.js";
import type { Provider, ProviderRequest, ProviderResult } from "../src/agent/providers/types.js";
import type { AgentBrief } from "../src/agent/brief.js";

function brief(): AgentBrief {
  return {
    format: "octupie-agent-brief/v1",
    objective: "Explain onboarding",
    audience: "founders",
    platform: "reels",
    preset: "neutral-founder-reel",
    desiredDurationSeconds: 8,
    sourceClips: [],
    output: { fileName: "output/x.mp4" },
    constraints: [],
  } as AgentBrief;
}

function validPlanText(): string {
  const built = buildDeterministicPlan(brief());
  if (!built.ok) throw new Error("fixture plan invalid: " + built.errors.join("; "));
  return JSON.stringify(built.plan);
}

/** Provider that replays scripted plan and critique replies, recording prompts. */
function scriptProvider(planReplies: ProviderResult[], critiqueReplies: ProviderResult[]): {
  provider: Provider;
  prompts: string[];
} {
  const plan = [...planReplies];
  const crit = [...critiqueReplies];
  const prompts: string[] = [];
  const provider: Provider = {
    id: "script",
    async generate(req: ProviderRequest): Promise<ProviderResult> {
      prompts.push(req.prompt);
      const q = req.kind === "plan" ? plan : crit;
      return q.shift() ?? { ok: false, text: "", error: "script exhausted", meta: {} };
    },
    async diagnose() {
      return { id: "script", available: true, authenticated: true, authSource: "test", detail: "" };
    },
  };
  return { provider, prompts };
}

const ok = (text: string): ProviderResult => ({ ok: true, text, meta: {} });
const approve = ok(JSON.stringify({ approved: true, issues: [] }));

function loop(provider: Provider, maxIterations = 4) {
  return runPlannerLoop({
    brief: brief(),
    provider,
    manifestText: "",
    rules: [],
    schemaText: "{}",
    maxIterations,
  });
}

describe("bounded planner/reviewer loop", () => {
  it("recovers from malformed JSON then accepts a valid, approved plan", async () => {
    const { provider } = scriptProvider([ok("not json at all"), ok(validPlanText())], [approve]);
    const r = await loop(provider);
    expect(r.accepted).toBe(true);
    expect(r.usedFallback).toBe(false);
    expect(r.iterations).toHaveLength(2);
    expect(r.iterations[0]!.planErrors.length).toBeGreaterThan(0);
    expect(r.iterations[1]!.planPromptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.iterations[1]!.critiquePromptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.iterations[1]!.planProviderMeta).toEqual({});
    expect(r.iterations[1]!.critiqueProviderMeta).toEqual({});
    expect(r.finalPlan.format).toBe("octupie-edit-plan/v1");
  });

  it("rejects media that was not declared in the brief", async () => {
    const fabricated = JSON.parse(validPlanText());
    fabricated.sourceClips = [{ id: "fabricated", path: "assets/fabricated.mp4" }];
    fabricated.scenes[0] = {
      ...fabricated.scenes[0],
      sourceClipId: "fabricated",
      sourceIn: 0,
      mute: true,
    };
    const { provider } = scriptProvider(
      [ok(JSON.stringify(fabricated)), ok(validPlanText())],
      [approve],
    );
    const r = await loop(provider, 3);
    expect(r.accepted).toBe(true);
    expect(r.iterations).toHaveLength(2);
    expect(r.iterations[0]!.planErrors.join(" ")).toMatch(/undeclared|fabricated/i);
  });

  it("rejects external audio that was not declared in the brief", async () => {
    const fabricated = JSON.parse(validPlanText());
    fabricated.audio.dialoguePath = "assets/fabricated-voice.wav";
    const { provider } = scriptProvider(
      [ok(JSON.stringify(fabricated)), ok(validPlanText())],
      [approve],
    );
    const r = await loop(provider, 3);
    expect(r.accepted).toBe(true);
    expect(r.iterations).toHaveLength(2);
    expect(r.iterations[0]!.planErrors.join(" ")).toMatch(/undeclared.*audio|dialogue/i);
  });

  it("retries after an invalid plan and feeds validation errors back", async () => {
    const invalid = ok(JSON.stringify({ format: "octupie-edit-plan/v1" }));
    const { provider, prompts } = scriptProvider([invalid, ok(validPlanText())], [approve]);
    const r = await loop(provider);
    expect(r.accepted).toBe(true);
    expect(r.iterations[0]!.planErrors.length).toBeGreaterThan(0);
    // The second planner prompt echoes the repair errors.
    expect(prompts.some((p) => /repair|fix|correct/i.test(p))).toBe(true);
  });

  it("loops when the reviewer rejects, then accepts on the approved revision", async () => {
    const { provider, prompts } = scriptProvider(
      [ok(validPlanText()), ok(validPlanText())],
      [ok(JSON.stringify({ approved: false, issues: ["hook is weak"] })), approve],
    );
    const r = await loop(provider);
    expect(r.accepted).toBe(true);
    expect(r.iterations).toHaveLength(2);
    expect(r.iterations[0]!.critique!.approved).toBe(false);
    // The reviewer's issue is fed into the next planner prompt.
    expect(prompts.some((p) => /hook is weak/.test(p))).toBe(true);
  });

  it("falls back deterministically after exhausting iterations on invalid plans", async () => {
    const invalid = ok(JSON.stringify({ format: "octupie-edit-plan/v1" }));
    const { provider } = scriptProvider([invalid, invalid], []);
    const r = await loop(provider, 2);
    expect(r.usedFallback).toBe(true);
    expect(r.accepted).toBe(false);
    expect(r.iterations).toHaveLength(2);
    // A deterministic fallback is always a valid plan.
    expect(r.finalPlan.format).toBe("octupie-edit-plan/v1");
  });

  it("falls back when the provider itself keeps failing (e.g. missing binary)", async () => {
    const fail: ProviderResult = { ok: false, text: "", error: "claude not available", meta: {} };
    const { provider } = scriptProvider([fail, fail, fail], []);
    const r = await loop(provider, 3);
    expect(r.usedFallback).toBe(true);
    expect(r.finalPlan.format).toBe("octupie-edit-plan/v1");
  });

  it("never asks for more than maxIterations plan attempts", async () => {
    const invalid = ok(JSON.stringify({ format: "octupie-edit-plan/v1" }));
    const { provider } = scriptProvider([invalid, invalid, invalid, invalid, invalid], []);
    const r = await loop(provider, 3);
    expect(r.iterations).toHaveLength(3);
  });

  it("accepts on the first iteration with the deterministic provider", async () => {
    const r = await loop(createDeterministicProvider());
    expect(r.accepted).toBe(true);
    expect(r.usedFallback).toBe(false);
    expect(r.iterations).toHaveLength(1);
  });
});
