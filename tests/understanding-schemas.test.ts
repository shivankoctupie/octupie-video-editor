import { describe, it, expect } from "vitest";
import {
  FINDING_KINDS,
  parseModelUnderstanding,
  parseSemanticUnderstanding,
  SEMANTIC_UNDERSTANDING_FORMAT,
} from "../src/understanding/schemas.js";

const goodFinding = {
  kind: "hook-moment" as const,
  startSeconds: 0,
  endSeconds: 1.2,
  confidence: 0.8,
  rationale: "Speaker opens with a bold claim on camera.",
  evidenceFrames: [{ path: "frame_00001.jpg", atSeconds: 0.5 }],
};

const goodModel = {
  findings: [goodFinding],
  segments: [{ startSeconds: 0, endSeconds: 2, description: "intro", salience: 0.7, tags: ["intro"] }],
  summary: "A short founder intro.",
  limitations: ["Only 3 frames were sampled; fast motion may be missed."],
};

function fullArtifact(over: Record<string, unknown> = {}) {
  return {
    format: SEMANTIC_UNDERSTANDING_FORMAT,
    clip: { path: "source/clip.mov" },
    durationSeconds: 6,
    generatedAt: "2026-07-28T00:00:00.000Z",
    provider: { id: "claude-cli", model: "claude-code-vision" },
    findings: [goodFinding],
    segments: goodModel.segments,
    summary: "ok",
    limitations: ["sampled frames only"],
    ...over,
  };
}

describe("finding kinds", () => {
  it("covers the seven explicit semantic kinds", () => {
    expect([...FINDING_KINDS].sort()).toEqual(
      ["broll-relevance", "crew-prompt", "facial-expression", "hook-moment", "product-proof", "visual-glitch", "weak-take"].sort(),
    );
  });
});

describe("modelUnderstandingSchema", () => {
  it("accepts a well-formed model reply", () => {
    const r = parseModelUnderstanding(goodModel);
    expect(r.ok).toBe(true);
  });

  it("requires at least one evidence frame per finding", () => {
    const r = parseModelUnderstanding({ ...goodModel, findings: [{ ...goodFinding, evidenceFrames: [] }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/evidence frame/);
  });

  it("requires a non-empty rationale", () => {
    const r = parseModelUnderstanding({ ...goodModel, findings: [{ ...goodFinding, rationale: "" }] });
    expect(r.ok).toBe(false);
  });

  it("requires at least one stated limitation (honesty gate)", () => {
    const r = parseModelUnderstanding({ ...goodModel, limitations: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/limitation/);
  });

  it("rejects an unknown finding kind", () => {
    const r = parseModelUnderstanding({ ...goodModel, findings: [{ ...goodFinding, kind: "vibes" }] });
    expect(r.ok).toBe(false);
  });

  it("rejects a finding whose end precedes its start", () => {
    const r = parseModelUnderstanding({ ...goodModel, findings: [{ ...goodFinding, startSeconds: 3, endSeconds: 1 }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/endSeconds/);
  });

  it("rejects an absolute or escaping evidence frame path", () => {
    const r = parseModelUnderstanding({
      ...goodModel,
      findings: [{ ...goodFinding, evidenceFrames: [{ path: "../secret.jpg", atSeconds: 0 }] }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an out-of-range confidence", () => {
    const r = parseModelUnderstanding({ ...goodModel, findings: [{ ...goodFinding, confidence: 1.5 }] });
    expect(r.ok).toBe(false);
  });
});

describe("semanticUnderstandingSchema timing bounds", () => {
  it("accepts an artifact whose findings lie within the clip", () => {
    const r = parseSemanticUnderstanding(fullArtifact());
    expect(r.ok).toBe(true);
  });

  it("rejects a finding that ends past the clip duration", () => {
    const r = parseSemanticUnderstanding(
      fullArtifact({ findings: [{ ...goodFinding, startSeconds: 5, endSeconds: 99 }] }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/past clip duration/);
  });

  it("rejects a segment that ends past the clip duration", () => {
    const r = parseSemanticUnderstanding(
      fullArtifact({ segments: [{ startSeconds: 0, endSeconds: 50, description: "x", salience: 0.1, tags: [] }] }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/past clip duration/);
  });

  it("rejects an evidence frame timestamp past the clip duration", () => {
    const r = parseSemanticUnderstanding(
      fullArtifact({ findings: [{ ...goodFinding, evidenceFrames: [{ path: "frame_00001.jpg", atSeconds: 900 }] }] }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/past clip duration/);
  });

  it("rejects a spoofed format literal", () => {
    const r = parseSemanticUnderstanding(fullArtifact({ format: "something-else" }));
    expect(r.ok).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const r = parseSemanticUnderstanding(fullArtifact({ extra: true }));
    expect(r.ok).toBe(false);
  });
});
