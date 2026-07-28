import { describe, it, expect } from "vitest";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import type { AgentBrief } from "../src/agent/brief.js";
import {
  runRevisionLoop,
  createClaudeRevisionStep,
  buildRevisionMessages,
  type DraftRenderResult,
  type RevisionLoopInput,
} from "../src/critique/revise.js";
import type { DraftCritiqueValue, CritiqueNoteValue } from "../src/critique/schemas.js";
import type { Provider, ProviderResult } from "../src/agent/providers/types.js";

function makePlan(title = "Neutral Founder Reel", extra: Record<string, unknown> = {}): EditPlan {
  const parsed = parseEditPlan({
    format: "octupie-edit-plan/v1",
    title,
    preset: "neutral-founder-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 6,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes: [{ id: "hook", type: "hook", start: 0, end: 6, heading: "Big claim" }],
    output: { fileName: "neutral-founder-reel.mp4" },
    ...extra,
  });
  if (!parsed.ok || !parsed.plan) throw new Error(parsed.errors.join("; "));
  return parsed.plan;
}

function critique(approved: boolean, notes: CritiqueNoteValue[] = []): DraftCritiqueValue {
  return {
    format: "octupie-draft-critique/v1",
    master: { path: "neutral-founder-reel.mp4" },
    durationSeconds: 6,
    generatedAt: "2026-07-28T00:00:00.000Z",
    provider: { id: "claude-cli", model: "claude-code-critique" },
    approved,
    notes,
    summary: "ok",
    limitations: ["sampled frames only"],
  };
}

const BLOCKER: CritiqueNoteValue = { atSeconds: 2, severity: "blocker", category: "visual", note: "black frame" };
const SUGGEST: CritiqueNoteValue = { atSeconds: 2, severity: "suggest", category: "pacing", note: "tighten" };

const rendered: DraftRenderResult = { master: { path: "neutral-founder-reel.mp4" }, durationSeconds: 6 };

function base(over: Partial<RevisionLoopInput> = {}): RevisionLoopInput {
  return {
    plan: makePlan(),
    maxRounds: 3,
    render: async () => rendered,
    critique: async () => critique(true),
    ...over,
  };
}

describe("runRevisionLoop", () => {
  it("stops and approves when the critique is approved with no blockers", async () => {
    const res = await runRevisionLoop(base({ critique: async () => critique(true, [SUGGEST]) }));
    expect(res.approved).toBe(true);
    expect(res.humanEscalation).toBe(false);
    expect(res.rounds).toBe(1);
  });

  it("never treats an approved flag with an outstanding blocker as approval", async () => {
    let renders = 0;
    const res = await runRevisionLoop(base({
      render: async (plan) => { renders++; return rendered; },
      critique: async () => critique(true, [BLOCKER]),
      // no revise provider -> should escalate rather than accept
    }));
    expect(res.approved).toBe(false);
    expect(res.humanEscalation).toBe(true);
    expect(renders).toBe(1);
  });

  it("escalates to a human at the round cap instead of looping unbounded", async () => {
    let renders = 0;
    const res = await runRevisionLoop(base({
      maxRounds: 3,
      render: async () => { renders++; return rendered; },
      critique: async () => critique(false, [BLOCKER]),
      revise: async () => makePlan("Revised"),
    }));
    expect(res.approved).toBe(false);
    expect(res.humanEscalation).toBe(true);
    expect(res.rounds).toBe(3);
    expect(renders).toBe(3);
  });

  it("re-renders the exact revised plan on the next round", async () => {
    const seenTitles: string[] = [];
    let round = 0;
    const res = await runRevisionLoop(base({
      maxRounds: 2,
      render: async (plan) => { seenTitles.push(plan.title); return rendered; },
      critique: async () => { round++; return round === 1 ? critique(false, [BLOCKER]) : critique(true); },
      revise: async () => makePlan("Revised-B"),
    }));
    expect(seenTitles).toEqual(["Neutral Founder Reel", "Revised-B"]);
    expect(res.approved).toBe(true);
    expect(res.finalPlan.title).toBe("Revised-B");
  });

  it("rejects an invalid revised plan and escalates, never accepting it or re-rendering it", async () => {
    let renders = 0;
    const res = await runRevisionLoop(base({
      maxRounds: 3,
      render: async () => { renders++; return rendered; },
      critique: async () => critique(false, [BLOCKER]),
      revise: async () => ({ format: "octupie-edit-plan/v1", title: "broken" }), // missing required fields
    }));
    expect(res.approved).toBe(false);
    expect(res.humanEscalation).toBe(true);
    expect(renders).toBe(1); // did not re-render the invalid plan
    const last = res.history[res.history.length - 1]!;
    expect(last.revisionAccepted).toBe(false);
    expect(last.revisionErrors!.length).toBeGreaterThan(0);
  });

  it("rejects a revised plan that references undeclared media when a brief is supplied", async () => {
    const brief = { sourceClips: [] } as unknown as AgentBrief;
    const res = await runRevisionLoop(base({
      maxRounds: 3,
      brief,
      critique: async () => critique(false, [BLOCKER]),
      revise: async () =>
        makePlan("Sneaky", {
          scenes: [{ id: "hook", type: "hook", start: 0, end: 6, heading: "x", broll: "undeclared.mp4" }],
        }),
    }));
    expect(res.humanEscalation).toBe(true);
    const last = res.history[res.history.length - 1]!;
    expect(last.revisionErrors!.join(" ")).toMatch(/undeclared/);
  });

  it("parses a revised plan delivered as raw model text", async () => {
    let round = 0;
    const planText = "Here is the fix:\n```json\n" + JSON.stringify(makePlan("From-Text")) + "\n```";
    const res = await runRevisionLoop(base({
      maxRounds: 2,
      critique: async () => { round++; return round === 1 ? critique(false, [BLOCKER]) : critique(true); },
      revise: async () => planText,
    }));
    expect(res.approved).toBe(true);
    expect(res.finalPlan.title).toBe("From-Text");
  });

  it("clamps maxRounds to at least one and preserves an audit record per round", async () => {
    const rounds: number[] = [];
    const res = await runRevisionLoop(base({
      maxRounds: 0,
      critique: async () => critique(false, [BLOCKER]),
      onRound: (r) => rounds.push(r.round),
    }));
    expect(res.rounds).toBe(1);
    expect(rounds).toEqual([1]);
    expect(res.history).toHaveLength(1);
    expect(res.history[0]!.blockers).toBe(1);
  });
});

describe("createClaudeRevisionStep", () => {
  const okProvider = (text: string): Provider => ({
    id: "claude-cli",
    generate: async (): Promise<ProviderResult> => ({ ok: true, text, meta: {} }),
    diagnose: async () => ({ id: "claude-cli", available: true, authenticated: "unknown", authSource: "test", detail: "" }),
  });

  it("builds a repair prompt that cites the critique and returns the provider text", async () => {
    const msgs = buildRevisionMessages({ plan: makePlan(), critique: critique(false, [BLOCKER]), schemaText: '{"type":"object"}' });
    expect(msgs.prompt).toContain("black frame");
    expect(msgs.prompt).toContain("octupie-edit-plan/v1");
    const step = createClaudeRevisionStep({ provider: okProvider("REPLACEMENT PLAN"), schemaText: '{"type":"object"}' });
    const out = await step(makePlan(), critique(false, [BLOCKER]), 1);
    expect(out).toBe("REPLACEMENT PLAN");
  });

  it("throws when the revision provider returns no plan", async () => {
    const failing: Provider = {
      id: "claude-cli",
      generate: async () => ({ ok: false, text: "", error: "claude down", meta: {} }),
      diagnose: async () => ({ id: "claude-cli", available: false, authenticated: false, authSource: "test", detail: "" }),
    };
    const step = createClaudeRevisionStep({ provider: failing, schemaText: "{}" });
    await expect(step(makePlan(), critique(false, [BLOCKER]), 1)).rejects.toThrow(/claude down|no plan/);
  });
});
