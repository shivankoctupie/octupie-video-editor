import type { Preset } from "./types.js";

export * from "./types.js";

const OCTUPIE_BRAND = {
  name: "Octupie",
  font: "Geist",
  paper: "#F7F5F0",
  ink: "#111111",
  accent: "#014CE3",
  paper2: "#EDEAE3",
} as const;

/**
 * Octupie product launch: landscape, product-led premium film. May introduce the
 * product immediately. Elegant, controlled motion with zero overshoot.
 */
export const octupieProductLaunch: Preset = {
  id: "octupie-product-launch",
  label: "Octupie Product Launch (16:9)",
  composition: "PremiumProductFilm",
  width: 1920,
  height: 1080,
  fps: 30,
  defaultDurationSeconds: 30,
  brand: { ...OCTUPIE_BRAND },
  safeZones: { top: 96, bottom: 96, left: 120, right: 120 },
  captions: {
    maxWordsPerCard: 5,
    allowExtendedCards: true, // cinematic manifesto hierarchy may exceed three words
    bandY: 920,
    colorOnDark: "#F7F5F0",
    colorOnLight: "#111111",
    emphasis: "#014CE3",
  },
  typography: { hookSize: 92, headingSize: 120, bodySize: 44, captionSize: 40, tracking: -0.02 },
  proofCard: { behavior: "full-screen", coversSpeaker: false },
  motion: {
    easing: [0.22, 1, 0.36, 1],
    durations: { quick: 0.35, standard: 0.5, slow: 0.8 },
    holdMs: 150,
    maxTravelFraction: 0.33,
  },
  audio: { targetLufs: -14, truePeakDb: -1.5, musicByDefault: true },
  editorialStance: "Product-led launch teaser. Every capability shown must be current and verified.",
};

/**
 * LinkedIn landscape reel: black 9:16 canvas with a persistent hook above a
 * landscape media slot. White captions with selective orange emphasis.
 */
export const linkedinLandscapeReel: Preset = {
  id: "linkedin-landscape-reel",
  label: "LinkedIn Landscape Reel (persistent hook)",
  composition: "FounderSocialReel",
  width: 1080,
  height: 1920,
  fps: 30,
  defaultDurationSeconds: 32,
  brand: {
    name: "Founder",
    font: "Arial",
    paper: "#000000",
    ink: "#FFFFFF",
    accent: "#FF6A00",
  },
  safeZones: { top: 250, bottom: 340, left: 48, right: 48 },
  captions: {
    maxWordsPerCard: 3,
    allowExtendedCards: false,
    bandY: 1335,
    colorOnDark: "#FFFFFF",
    colorOnLight: "#111111",
    emphasis: "#FF6A00",
  },
  typography: { hookSize: 68, headingSize: 72, bodySize: 40, captionSize: 56, tracking: 0 },
  proofCard: { behavior: "replace-media", coversSpeaker: false },
  motion: {
    easing: [0.33, 0, 0.2, 1],
    durations: { quick: 0.3, standard: 0.45, slow: 0.7 },
    holdMs: 120,
    maxTravelFraction: 0.4,
  },
  audio: { targetLufs: -16, truePeakDb: -1.5, musicByDefault: false },
  editorialStance: "Persistent-hook landscape series. Hook stays visible; captions in the safe band.",
};

/**
 * YC / Y-series vertical: stricter brand continuity. White and orange Arial,
 * official YC logo only, B-roll must not cover the speaker.
 */
export const ycSeriesVertical: Preset = {
  id: "yc-series-vertical",
  label: "YC Y-Series Vertical",
  composition: "FounderSocialReel",
  width: 1080,
  height: 1920,
  fps: 30,
  defaultDurationSeconds: 34,
  brand: {
    name: "YC Series",
    font: "Arial",
    paper: "#000000",
    ink: "#FFFFFF",
    accent: "#F26522",
  },
  safeZones: { top: 250, bottom: 340, left: 48, right: 48 },
  captions: {
    maxWordsPerCard: 3,
    allowExtendedCards: false,
    bandY: 1360,
    colorOnDark: "#FFFFFF",
    colorOnLight: "#111111",
    emphasis: "#F26522",
  },
  typography: { hookSize: 64, headingSize: 68, bodySize: 38, captionSize: 54, tracking: 0 },
  proofCard: { behavior: "upper-region", coversSpeaker: false },
  motion: {
    easing: [0.4, 0, 0.2, 1],
    durations: { quick: 0.3, standard: 0.45, slow: 0.7 },
    holdMs: 130,
    maxTravelFraction: 0.35,
  },
  audio: { targetLufs: -16, truePeakDb: -1.5, musicByDefault: false },
  editorialStance: "YC continuity. Speaker always visible; proof in the upper region; no auto SFX.",
};

/**
 * Neutral founder reel: restrained default for any founder short. Portable brand
 * tokens, one clear idea per screen. This is the demo and starter default.
 */
export const neutralFounderReel: Preset = {
  id: "neutral-founder-reel",
  label: "Neutral Founder Reel (9:16)",
  composition: "FounderSocialReel",
  width: 1080,
  height: 1920,
  fps: 30,
  defaultDurationSeconds: 12,
  brand: {
    name: "Founder",
    font: "Geist",
    paper: "#0E0E10",
    ink: "#F5F5F5",
    accent: "#014CE3",
    paper2: "#1A1A1E",
  },
  safeZones: { top: 220, bottom: 320, left: 56, right: 56 },
  captions: {
    maxWordsPerCard: 3,
    allowExtendedCards: false,
    bandY: 1320,
    colorOnDark: "#F5F5F5",
    colorOnLight: "#111111",
    emphasis: "#4C8DFF",
  },
  typography: { hookSize: 66, headingSize: 70, bodySize: 40, captionSize: 54, tracking: -0.01 },
  proofCard: { behavior: "replace-media", coversSpeaker: false },
  motion: {
    easing: [0.22, 1, 0.36, 1],
    durations: { quick: 0.3, standard: 0.45, slow: 0.7 },
    holdMs: 130,
    maxTravelFraction: 0.4,
  },
  audio: { targetLufs: -16, truePeakDb: -1.5, musicByDefault: false },
  editorialStance: "Neutral restrained founder reel. Movement supports a spoken beat, never decorates.",
};

export const PRESETS: Record<string, Preset> = {
  [octupieProductLaunch.id]: octupieProductLaunch,
  [linkedinLandscapeReel.id]: linkedinLandscapeReel,
  [ycSeriesVertical.id]: ycSeriesVertical,
  [neutralFounderReel.id]: neutralFounderReel,
};

export function getPreset(id: string): Preset {
  const preset = PRESETS[id];
  if (!preset) {
    throw new Error(
      `Unknown preset '${id}'. Available: ${Object.keys(PRESETS).join(", ")}`,
    );
  }
  return preset;
}

export function listPresets(): Preset[] {
  return Object.values(PRESETS);
}
