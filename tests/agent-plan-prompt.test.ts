import { describe, it, expect } from "vitest";
import { buildDeterministicPlan } from "../src/agent/plan.js";
import { buildPlannerMessages, buildCritiqueMessages, parseCritique } from "../src/agent/prompt.js";
import type { AgentBrief } from "../src/agent/brief.js";

function brief(over: Partial<AgentBrief> = {}): AgentBrief {
  return {
    format: "octupie-agent-brief/v1",
    objective: "Explain fast onboarding",
    audience: "founders",
    platform: "reels",
    preset: "neutral-founder-reel",
    desiredDurationSeconds: 10,
    sourceClips: [{ id: "hero", path: "clips/hero.mp4" }],
    output: { fileName: "output/agent.mp4" },
    constraints: [],
    ...over,
  } as AgentBrief;
}

describe("buildDeterministicPlan", () => {
  it("builds a valid edit plan from a brief", () => {
    const r = buildDeterministicPlan(brief());
    expect(r.ok, r.errors.join("; ")).toBe(true);
    expect(r.plan!.duration).toBe(10);
    expect(r.plan!.output.fileName).toBe("output/agent.mp4");
    expect(r.plan!.preset).toBe("neutral-founder-reel");
  });

  it("wires the first source clip into the plan", () => {
    const r = buildDeterministicPlan(brief());
    expect(r.ok).toBe(true);
    expect(r.plan!.sourceClips.some((c) => c.id === "hero")).toBe(true);
  });

  it("fails cleanly on an unknown preset", () => {
    const r = buildDeterministicPlan(brief({ preset: "no-such-preset" }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/preset/i);
  });
});

describe("planner and critique prompts", () => {
  const rules = [{ id: "r1", text: "Keep captions to two words" }];
  it("planner prompt includes brief, manifest, transcript, rules, and schema; demands JSON only", () => {
    const msgs = buildPlannerMessages({
      brief: brief(),
      manifestText: "Source clips: hero 8s",
      transcriptText: "spoken words here",
      rules,
      schemaText: '{"type":"object"}',
    });
    expect(msgs.prompt).toMatch(/Explain fast onboarding/);
    expect(msgs.prompt).toMatch(/hero 8s/);
    expect(msgs.prompt).toMatch(/spoken words here/);
    expect(msgs.prompt).toMatch(/Keep captions to two words/);
    expect(msgs.prompt).toMatch(/type.*object/);
    expect(msgs.system + msgs.prompt).toMatch(/json/i);
    // Never instruct or embed raw media.
    expect(msgs.prompt).not.toMatch(/base64|data:video/i);
  });

  it("explicitly forbids inventing undeclared media", () => {
    const msgs = buildPlannerMessages({
      brief: brief({ sourceClips: [] }),
      manifestText: "Source clips: none declared.",
      rules: [],
      schemaText: "{}",
    });
    expect(msgs.prompt).toMatch(/do not invent|undeclared media|only.*declared/i);
  });

  it("feeds prior validation errors back for repair", () => {
    const msgs = buildPlannerMessages({
      brief: brief(),
      manifestText: "",
      rules: [],
      schemaText: "{}",
      priorErrors: ["scenes: overlap between 1s and 2s"],
    });
    expect(msgs.prompt).toMatch(/overlap between 1s and 2s/);
    expect(msgs.prompt).toMatch(/repair|fix|correct/i);
  });

  it("critique prompt asks for a structured verdict against the rubric", () => {
    const msgs = buildCritiqueMessages({
      brief: brief(),
      plan: { format: "octupie-edit-plan/v1" },
      rules,
    });
    expect(msgs.prompt).toMatch(/approved/);
    expect(msgs.system + msgs.prompt).toMatch(/json/i);
  });
});

describe("parseCritique", () => {
  it("accepts a well-formed critique", () => {
    const r = parseCritique({ approved: true, issues: [], notes: "clean" });
    expect(r.ok).toBe(true);
    expect(r.critique!.approved).toBe(true);
  });

  it("defaults issues to an empty array", () => {
    const r = parseCritique({ approved: false });
    expect(r.ok).toBe(true);
    expect(r.critique!.issues).toEqual([]);
  });

  it("rejects a critique missing the verdict", () => {
    const r = parseCritique({ issues: ["x"] });
    expect(r.ok).toBe(false);
  });
});
