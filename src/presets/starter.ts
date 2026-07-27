import type { Preset } from "./types.js";

/**
 * Build a valid starter edit plan from a preset. Used by `init` and `demo`.
 * The result validates against the edit-plan schema: non-overlapping scenes
 * inside the duration and one-to-three-word captions. Starter plans declare no
 * media or SFX binaries, so they render immediately on a clean installation.
 */
export function makeStarterPlan(preset: Preset, opts: { title?: string; duration?: number } = {}): unknown {
  const duration = opts.duration ?? preset.defaultDurationSeconds;
  const title = opts.title ?? `${preset.label} starter`;
  const isLandscape = preset.width >= preset.height;

  // Three restrained beats: hook, proof, payoff, scaled to the duration.
  const a = duration * 0.3;
  const b = duration * 0.7;
  const scenes = [
    {
      id: "hook",
      type: "hook",
      start: 0,
      end: round(a),
      heading: "One clear promise",
      frameZero: "One clear promise",
    },
    {
      id: "proof",
      type: "proof",
      start: round(a),
      end: round(b),
      heading: "Real, specific proof",
      body: "Show the thing that proves the claim.",
    },
    {
      id: "payoff",
      type: "payoff",
      start: round(b),
      end: round(duration),
      heading: preset.brand.name,
      emphasis: preset.brand.name,
    },
  ];

  const cards = [
    { text: "One clear", start: 0, end: round(a * 0.5) },
    { text: "promise", start: round(a * 0.5), end: round(a) },
    { text: "real proof", start: round(a), end: round(b) },
    { text: preset.brand.name, start: round(b), end: round(duration) },
  ];

  // Keep generated starter plans self-contained. Editors add licensed SFX only
  // after placing the files under the configured asset root.
  const sfx: unknown[] = [];

  return {
    format: "octupie-edit-plan/v1",
    title,
    preset: preset.id,
    composition: preset.composition,
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
    duration: round(duration),
    brand: preset.brand,
    scenes,
    captions: {
      maxWordsPerCard: preset.captions.maxWordsPerCard,
      allowExtendedCards: preset.captions.allowExtendedCards,
      cards,
    },
    sourceClips: [],
    audio: {
      targetLufs: preset.audio.targetLufs,
      truePeakDb: preset.audio.truePeakDb,
      sfx,
    },
    output: {
      fileName: isLandscape ? "output/product-film.mp4" : "output/founder-reel.mp4",
    },
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
