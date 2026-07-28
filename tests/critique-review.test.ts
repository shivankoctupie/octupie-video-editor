import { describe, it, expect } from "vitest";
import { createPolicy } from "../src/permissions/policy.js";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import { reviewPlan, type ReviewPlanInput } from "../src/critique/review.js";
import type { DraftCritiqueValue, CritiqueNoteValue } from "../src/critique/schemas.js";
import type { DraftRenderResult } from "../src/critique/revise.js";

const PERMISSIONS = createPolicy([
  { action: "network", grantedBy: "test", grantedAt: "2026-07-28T00:00:00.000Z" },
  { action: "media-upload", grantedBy: "test", grantedAt: "2026-07-28T00:00:00.000Z" },
]);

function makePlan(title = "Neutral Founder Reel"): EditPlan {
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

const rendered: DraftRenderResult = { master: { path: "neutral-founder-reel.mp4" }, durationSeconds: 6, masterAbsPath: "x.mp4" };
const BLOCKER: CritiqueNoteValue = { atSeconds: 2, severity: "blocker", category: "visual", note: "black frame" };

function base(over: Partial<ReviewPlanInput> = {}): ReviewPlanInput {
  return {
    plan: makePlan(),
    maxRounds: 3,
    permissionPolicy: PERMISSIONS,
    render: async () => rendered,
    critique: async () => critique(true),
    revise: async () => makePlan("Revised"),
    ...over,
  };
}

describe("reviewPlan", () => {
  it("denies network by default before rendering", async () => {
    let rendered = false;
    await expect(
      reviewPlan(base({ permissionPolicy: undefined, render: async () => { rendered = true; return { master: { path: "m.mp4" }, durationSeconds: 6 }; } })),
    ).rejects.toThrow(/Permission denied for 'network'/);
    expect(rendered).toBe(false);
  });

  it("requires a separate media-upload grant", async () => {
    const networkOnly = createPolicy([{ action: "network", grantedBy: "t", grantedAt: "2026-07-28T00:00:00.000Z" }]);
    await expect(reviewPlan(base({ permissionPolicy: networkOnly }))).rejects.toThrow(/Permission denied for 'media-upload'/);
  });

  it("runs the bounded loop with injected steps and records an audit artifact per round", async () => {
    const rounds: number[] = [];
    let round = 0;
    const res = await reviewPlan(base({
      maxRounds: 3,
      critique: async () => { round++; return round === 1 ? critique(false, [BLOCKER]) : critique(true); },
      revise: async () => makePlan("Revised-B"),
      onRound: (r) => rounds.push(r.round),
    }));
    expect(res.approved).toBe(true);
    expect(res.finalPlan.title).toBe("Revised-B");
    expect(rounds).toEqual([1, 2]);
  });
});
