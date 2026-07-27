import { describe, it, expect } from "vitest";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";

function basePlan(): Record<string, unknown> {
  return {
    format: "octupie-edit-plan/v1",
    title: "Test Plan",
    preset: "neutral-founder-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 6,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes: [
      { id: "s1", type: "hook", start: 0, end: 2, heading: "Hook", frameZero: "Hook" },
      { id: "s2", type: "payoff", start: 2, end: 6, heading: "Payoff" },
    ],
    captions: {
      cards: [
        { text: "We built", start: 0, end: 1 },
        { text: "it fast", start: 1, end: 2 },
      ],
    },
    audio: {
      sfx: [{ time: 2, asset: "lock.wav", family: "impact", intensity: "support", role: "settle" }],
    },
    output: { fileName: "output/demo.mp4" },
  };
}

describe("edit-plan schema", () => {
  it("accepts a well-formed plan and applies defaults", () => {
    const r = parseEditPlan(basePlan());
    expect(r.ok).toBe(true);
    const plan = r.plan as EditPlan;
    expect(plan.output.container).toBe("mp4");
    expect(plan.audio.targetLufs).toBe(-16);
  });

  it("rejects negative times", () => {
    const p = basePlan();
    (p.scenes as any[])[0].start = -1;
    expect(parseEditPlan(p).ok).toBe(false);
  });

  it("rejects scenes past the duration", () => {
    const p = basePlan();
    (p.scenes as any[])[1].end = 99;
    const r = parseEditPlan(p);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/past the plan duration/);
  });

  it("rejects overlapping scene intervals", () => {
    const p = basePlan();
    (p.scenes as any[])[1].start = 1; // overlaps s1 which ends at 2
    const r = parseEditPlan(p);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/overlap/);
  });

  it("rejects unknown scene types", () => {
    const p = basePlan();
    (p.scenes as any[])[0].type = "explosion";
    expect(parseEditPlan(p).ok).toBe(false);
  });

  it("rejects caption cards over three words by default", () => {
    const p = basePlan();
    (p.captions as any).cards = [{ text: "one two three four", start: 0, end: 1 }];
    const r = parseEditPlan(p);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/limit is 3/);
  });

  it("allows longer caption cards when the preset extends them", () => {
    const p = basePlan();
    (p.captions as any) = {
      maxWordsPerCard: 6,
      allowExtendedCards: true,
      cards: [{ text: "one two three four five", start: 0, end: 1 }],
    };
    expect(parseEditPlan(p).ok).toBe(true);
  });

  it("rejects unsafe source clip paths", () => {
    const p = basePlan();
    (p as any).sourceClips = [{ id: "c1", path: "C:/Users/user/secret.mp4" }];
    expect(parseEditPlan(p).ok).toBe(false);
    const p2 = basePlan();
    (p2 as any).sourceClips = [{ id: "c2", path: "../../escape.mp4" }];
    expect(parseEditPlan(p2).ok).toBe(false);
  });

  it("rejects invalid SFX stacks inside the plan", () => {
    const p = basePlan();
    (p.audio as any).sfx = [
      { time: 3.0, asset: "whoosh.wav", family: "whoosh", intensity: "support", role: "a" },
      { time: 3.03, asset: "riser.wav", family: "riser", intensity: "hero", role: "b" },
      { time: 3.05, asset: "impact.wav", family: "impact", intensity: "hero", role: "c" },
    ];
    const r = parseEditPlan(p);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/trailer stack/);
  });

  it("rejects the blacklisted asset inside the plan", () => {
    const p = basePlan();
    (p.audio as any).sfx = [
      { time: 3, asset: "impact_ultra_serious_48k_pcm24.wav", family: "impact", intensity: "hero", role: "x" },
    ];
    expect(parseEditPlan(p).ok).toBe(false);
  });

  it("keeps old plans without source-clip scene fields valid", () => {
    expect(parseEditPlan(basePlan()).ok).toBe(true);
  });

  it("accepts scenes with sourceClipId, sourceIn, mute, and fit when the clip exists", () => {
    const p = basePlan();
    (p as any).sourceClips = [{ id: "hero", path: "clips/hero.mp4", in: 0, out: 10 }];
    (p.scenes as any[])[0].sourceClipId = "hero";
    (p.scenes as any[])[0].sourceIn = 1.5;
    (p.scenes as any[])[0].mute = true;
    (p.scenes as any[])[0].fit = "contain";
    const r = parseEditPlan(p);
    expect(r.ok, r.errors.join("; ")).toBe(true);
  });

  it("rejects a scene referencing a missing sourceClipId", () => {
    const p = basePlan();
    (p as any).sourceClips = [{ id: "hero", path: "clips/hero.mp4" }];
    (p.scenes as any[])[0].sourceClipId = "ghost";
    const r = parseEditPlan(p);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unknown source clip|does not exist/i);
  });

  it("rejects duplicate source clip ids", () => {
    const p = basePlan();
    (p as any).sourceClips = [
      { id: "dup", path: "clips/a.mp4" },
      { id: "dup", path: "clips/b.mp4" },
    ];
    expect(parseEditPlan(p).ok).toBe(false);
  });

  it("rejects a negative sourceIn", () => {
    const p = basePlan();
    (p as any).sourceClips = [{ id: "hero", path: "clips/hero.mp4" }];
    (p.scenes as any[])[0].sourceClipId = "hero";
    (p.scenes as any[])[0].sourceIn = -1;
    expect(parseEditPlan(p).ok).toBe(false);
  });

  it("rejects a sourceIn at or past the clip out point", () => {
    const p = basePlan();
    (p as any).sourceClips = [{ id: "hero", path: "clips/hero.mp4", in: 0, out: 2 }];
    (p.scenes as any[])[0].sourceClipId = "hero";
    (p.scenes as any[])[0].sourceIn = 2;
    const r = parseEditPlan(p);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/sourceIn/);
  });

  it("rejects a scene whose playback duration runs past the clip out point", () => {
    const p = basePlan();
    (p as any).sourceClips = [{ id: "hero", path: "clips/hero.mp4", in: 0, out: 2.5 }];
    (p.scenes as any[])[1].sourceClipId = "hero";
    (p.scenes as any[])[1].sourceIn = 1;
    const r = parseEditPlan(p);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/past its out-point/);
  });

  it("rejects an unsafe SFX cue asset path", () => {
    const p = basePlan();
    (p.audio as any).sfx = [
      { time: 2, asset: "../../evil.wav", family: "impact", intensity: "support", role: "x" },
    ];
    expect(parseEditPlan(p).ok).toBe(false);
  });
});
