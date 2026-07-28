import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";

/**
 * A self-contained, valid source plan for hook-variant tests: a hook opening,
 * a proof scene that references a declared source clip, a payoff scene with
 * b-roll, two caption cards, one SFX cue, and music. Rich enough to prove that
 * the deterministic producer preserves body scenes, media, and audio, and that
 * the invented-media guard has real references to compare against.
 */
export function basePlanObject(): Record<string, unknown> {
  return {
    format: "octupie-edit-plan/v1",
    title: "Base plan",
    preset: "founder-social-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 30,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes: [
      { id: "hook", type: "hook", start: 0, end: 6, heading: "Original opening line", frameZero: "Original opening line" },
      { id: "proof", type: "proof", start: 6, end: 20, heading: "Real proof", body: "Show the thing.", sourceClipId: "clip1", sourceIn: 0 },
      { id: "payoff", type: "payoff", start: 20, end: 30, heading: "Octupie", emphasis: "Octupie", broll: "broll/end.mp4" },
    ],
    captions: {
      maxWordsPerCard: 3,
      allowExtendedCards: false,
      cards: [
        { text: "one two", start: 0, end: 6 },
        { text: "real proof", start: 6, end: 20 },
      ],
    },
    sourceClips: [{ id: "clip1", path: "source/clip1.mp4", in: 0, out: 20 }],
    audio: {
      targetLufs: -16,
      truePeakDb: -1.5,
      music: { path: "music/bed.mp3", license: "cc0", sourceUrl: "https://example.com/bed" },
      sfx: [{ time: 6, asset: "sfx/whoosh.wav", family: "whoosh", intensity: "support", role: "transition" }],
    },
    output: { fileName: "output/reel.mp4" },
  };
}

export function basePlan(): EditPlan {
  const parsed = parseEditPlan(basePlanObject());
  if (!parsed.ok || !parsed.plan) throw new Error(`fixture invalid: ${parsed.errors.join("; ")}`);
  return parsed.plan;
}

export const FIXED_NOW = new Date("2026-07-28T00:00:00.000Z");
