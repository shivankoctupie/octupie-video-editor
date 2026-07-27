import { describe, it, expect } from "vitest";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import { clipById, sceneMedia } from "../src/render/media.js";

function planWith(scenes: unknown[], sourceClips: unknown[]): EditPlan {
  const raw = {
    format: "octupie-edit-plan/v1",
    title: "Media Test",
    preset: "neutral-founder-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 6,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes,
    sourceClips,
    output: { fileName: "output/demo.mp4" },
  };
  const r = parseEditPlan(raw);
  if (!r.ok || !r.plan) throw new Error(r.errors.join("; "));
  return r.plan;
}

describe("scene media mapping", () => {
  it("returns null for a scene with no source clip", () => {
    const plan = planWith([{ id: "s1", type: "hook", start: 0, end: 6, heading: "Hi" }], []);
    expect(sceneMedia(plan, plan.scenes[0]!)).toBeNull();
  });

  it("maps a b-roll path when no source clip is declared", () => {
    const plan = planWith(
      [{ id: "s1", type: "proof", start: 0, end: 6, broll: "proof/demo.mp4", fit: "contain" }],
      [],
    );
    expect(sceneMedia(plan, plan.scenes[0]!)).toEqual({
      path: "proof/demo.mp4",
      startFromFrames: 0,
      mute: true,
      fit: "contain",
    });
  });

  it("maps a scene to its clip path, start frame, mute, and fit", () => {
    const plan = planWith(
      [{ id: "s1", type: "hook", start: 0, end: 6, sourceClipId: "hero", sourceIn: 2, mute: true, fit: "contain" }],
      [{ id: "hero", path: "clips/hero.mp4", in: 0, out: 10 }],
    );
    const m = sceneMedia(plan, plan.scenes[0]!);
    expect(m).toEqual({ path: "clips/hero.mp4", startFromFrames: 60, mute: true, fit: "contain" });
  });

  it("falls back to the clip in-point and cover/unmuted defaults", () => {
    const plan = planWith(
      [{ id: "s1", type: "hook", start: 0, end: 6, sourceClipId: "hero" }],
      [{ id: "hero", path: "clips/hero.mp4", in: 1.5 }],
    );
    const m = sceneMedia(plan, plan.scenes[0]!);
    expect(m).toEqual({ path: "clips/hero.mp4", startFromFrames: 45, mute: false, fit: "cover" });
  });

  it("clipById finds and misses correctly", () => {
    const plan = planWith(
      [{ id: "s1", type: "hook", start: 0, end: 6 }],
      [{ id: "hero", path: "clips/hero.mp4" }],
    );
    expect(clipById(plan, "hero")?.path).toBe("clips/hero.mp4");
    expect(clipById(plan, "nope")).toBeUndefined();
  });
});
