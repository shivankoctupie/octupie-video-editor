import { describe, it, expect } from "vitest";
import { parseAgentBrief, type AgentBrief } from "../src/agent/brief.js";

function baseBrief(): Record<string, unknown> {
  return {
    format: "octupie-agent-brief/v1",
    objective: "Explain why our onboarding is fast, drive signups.",
    audience: "Early-stage founders",
    platform: "instagram-reels",
    creator: "Shivank",
    style: "restrained, plain-spoken",
    preset: "neutral-founder-reel",
    desiredDurationSeconds: 12,
    sourceClips: [{ id: "hero", path: "clips/hero.mp4" }],
    transcript: { text: "We shipped onboarding in a day." },
    output: { fileName: "output/agent-reel.mp4" },
    constraints: ["no b-roll over speaker"],
    hookVariants: 3,
    scope: { creator: "shivank", series: "founder-shorts", project: "octupie-launch" },
  };
}

describe("agent brief v1 schema", () => {
  it("accepts a well-formed brief and applies defaults", () => {
    const r = parseAgentBrief(baseBrief());
    expect(r.ok, r.errors.join("; ")).toBe(true);
    const brief = r.brief as AgentBrief;
    expect(brief.format).toBe("octupie-agent-brief/v1");
    expect(brief.constraints).toEqual(["no b-roll over speaker"]);
    expect(brief.sourceClips[0]!.id).toBe("hero");
  });

  it("defaults sourceClips and constraints to empty arrays", () => {
    const b = baseBrief();
    delete b.sourceClips;
    delete b.constraints;
    const r = parseAgentBrief(b);
    expect(r.ok).toBe(true);
    expect(r.brief!.sourceClips).toEqual([]);
    expect(r.brief!.constraints).toEqual([]);
  });

  it("rejects an unknown format", () => {
    const b = baseBrief();
    b.format = "octupie-agent-brief/v2";
    expect(parseAgentBrief(b).ok).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const b = baseBrief();
    (b as any).sneaky = "value";
    expect(parseAgentBrief(b).ok).toBe(false);
  });

  it("rejects an unsafe source clip path", () => {
    const b = baseBrief();
    (b.sourceClips as any[]) = [{ id: "x", path: "C:/Users/secret.mp4" }];
    expect(parseAgentBrief(b).ok).toBe(false);
    const b2 = baseBrief();
    (b2.sourceClips as any[]) = [{ id: "x", path: "../../escape.mp4" }];
    expect(parseAgentBrief(b2).ok).toBe(false);
  });

  it("rejects an unsafe transcript path", () => {
    const b = baseBrief();
    b.transcript = { path: "../secrets/transcript.txt" };
    expect(parseAgentBrief(b).ok).toBe(false);
  });

  it("rejects an unsafe output file path", () => {
    const b = baseBrief();
    b.output = { fileName: "/etc/passwd" };
    expect(parseAgentBrief(b).ok).toBe(false);
  });

  it("rejects a non-positive duration", () => {
    const b = baseBrief();
    b.desiredDurationSeconds = 0;
    expect(parseAgentBrief(b).ok).toBe(false);
  });

  it("rejects a transcript object with neither text nor path", () => {
    const b = baseBrief();
    b.transcript = {};
    expect(parseAgentBrief(b).ok).toBe(false);
  });

  it("allows omitting the optional transcript, creator, style, and hookVariants", () => {
    const b = baseBrief();
    delete b.transcript;
    delete b.creator;
    delete b.style;
    delete b.hookVariants;
    expect(parseAgentBrief(b).ok).toBe(true);
  });

  it("returns readable path-prefixed errors", () => {
    const b = baseBrief();
    b.objective = "";
    const r = parseAgentBrief(b);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/objective/);
  });
});
