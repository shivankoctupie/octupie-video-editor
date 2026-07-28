import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  CRITIQUE_CATEGORIES,
  DRAFT_CRITIQUE_FORMAT,
  modelCritiqueSchema,
  parseModelCritique,
  parseDraftCritique,
  hasBlockers,
  isApproved,
} from "../src/critique/schemas.js";

const goodModel = {
  approved: false,
  notes: [
    {
      atSeconds: 2.1,
      severity: "blocker",
      category: "visual",
      note: "A black frame flashes here.",
      evidenceFrame: { path: "critique_frame_00002.jpg", atSeconds: 2 },
      suggestedPlanChanges: [{ target: "scene-2", change: "shorten the cut so the tail frame is dropped" }],
    },
    {
      atSeconds: 4,
      severity: "suggest",
      category: "captions",
      note: "Caption lags the voice by a beat.",
    },
  ],
  summary: "One blocker: a black frame near 2s.",
  limitations: ["Only 3 frames were sampled."],
};

describe("modelCritiqueSchema", () => {
  it("accepts a well-formed model critique with notes and DATA-only suggestions", () => {
    const r = parseModelCritique(goodModel);
    expect(r.ok).toBe(true);
    expect(r.data!.notes).toHaveLength(2);
    expect(r.data!.notes[0]!.suggestedPlanChanges![0]!.target).toBe("scene-2");
  });

  it("rejects an unknown severity", () => {
    const bad = { ...goodModel, notes: [{ ...goodModel.notes[0], severity: "fatal" }] };
    expect(parseModelCritique(bad).ok).toBe(false);
  });

  it("rejects an unknown category", () => {
    const bad = { ...goodModel, notes: [{ ...goodModel.notes[0], category: "vibes" }] };
    expect(parseModelCritique(bad).ok).toBe(false);
  });

  it("requires at least one honest limitation", () => {
    const bad = { ...goodModel, limitations: [] };
    expect(parseModelCritique(bad).ok).toBe(false);
  });

  it("rejects an empty note string", () => {
    const bad = { ...goodModel, notes: [{ ...goodModel.notes[0], note: "" }] };
    expect(parseModelCritique(bad).ok).toBe(false);
  });

  it("rejects unknown top-level keys (strict) so the model cannot smuggle identity", () => {
    const bad = { ...goodModel, provider: { id: "spoofed", model: "x" } };
    expect(parseModelCritique(bad).ok).toBe(false);
  });

  it("exposes a direct top-level object JSON schema with no $ref for Claude structured output", () => {
    const schema = zodToJsonSchema(modelCritiqueSchema, { $refStrategy: "none" }) as { type?: string; $ref?: string };
    expect(schema.type).toBe("object");
    expect(schema.$ref).toBeUndefined();
    expect(CRITIQUE_CATEGORIES).toContain("visual");
  });
});

function stampedCritique(over: Record<string, unknown> = {}) {
  return {
    format: DRAFT_CRITIQUE_FORMAT,
    master: { path: "neutral-founder-reel.mp4" },
    durationSeconds: 6,
    generatedAt: "2026-07-28T00:00:00.000Z",
    provider: { id: "claude-cli", model: "claude-code-critique" },
    approved: false,
    notes: goodModel.notes,
    summary: goodModel.summary,
    limitations: goodModel.limitations,
    ...over,
  };
}

describe("draftCritiqueSchema timing", () => {
  it("accepts notes and evidence frames within the master duration", () => {
    expect(parseDraftCritique(stampedCritique()).ok).toBe(true);
  });

  it("rejects a note anchored past the real master duration", () => {
    const bad = stampedCritique({
      notes: [{ atSeconds: 99, severity: "info", category: "pacing", note: "late" }],
    });
    const r = parseDraftCritique(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/past .*duration/);
  });

  it("rejects an evidence frame time past the real master duration", () => {
    const bad = stampedCritique({
      notes: [
        { atSeconds: 2, severity: "info", category: "pacing", note: "x", evidenceFrame: { path: "critique_frame_00002.jpg", atSeconds: 99 } },
      ],
    });
    expect(parseDraftCritique(bad).ok).toBe(false);
  });

  it("rejects a non-portable evidence frame reference", () => {
    const bad = stampedCritique({
      notes: [
        { atSeconds: 2, severity: "info", category: "pacing", note: "x", evidenceFrame: { path: "../secret.jpg", atSeconds: 2 } },
      ],
    });
    expect(parseDraftCritique(bad).ok).toBe(false);
  });
});

describe("hasBlockers / isApproved", () => {
  it("detects a blocker note", () => {
    const parsed = parseModelCritique(goodModel);
    expect(parsed.ok).toBe(true);
    expect(hasBlockers(parsed.data!.notes)).toBe(true);
  });
  it("treats an approved critique with a blocker as not truly approved", () => {
    const c = parseDraftCritique(stampedCritique({ approved: true })).data!;
    expect(isApproved(c)).toBe(false);
  });
  it("treats an approved critique with no blockers as approved", () => {
    const c = parseDraftCritique(stampedCritique({
      approved: true,
      notes: [{ atSeconds: 1, severity: "suggest", category: "pacing", note: "tighten" }],
    })).data!;
    expect(isApproved(c)).toBe(true);
  });
});
