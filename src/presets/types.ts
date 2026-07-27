/**
 * A preset encodes a locked editorial identity: dimensions, typography, color,
 * safe zones, caption rules, proof-card behavior, motion signature, and audio
 * targets. Presets carry no machine paths; they are portable data.
 */

export type CompositionId = "PremiumProductFilm" | "FounderSocialReel";

export interface BrandTokens {
  name: string;
  font: string;
  paper: string;
  ink: string;
  accent: string;
  paper2?: string;
}

export interface SafeZones {
  /** Insets in pixels from each edge; important text stays inside. */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface CaptionRules {
  maxWordsPerCard: number;
  allowExtendedCards: boolean;
  /** Baseline y for the normal caption band, in canvas pixels. */
  bandY: number;
  /** Choose caption color from the rendered background, not a global preset. */
  colorOnDark: string;
  colorOnLight: string;
  emphasis: string;
}

export interface Typography {
  hookSize: number;
  headingSize: number;
  bodySize: number;
  captionSize: number;
  tracking: number;
}

export type ProofBehavior = "replace-media" | "upper-region" | "full-screen";

export interface ProofCard {
  behavior: ProofBehavior;
  /** In YC-style work, proof must never cover the speaker. */
  coversSpeaker: boolean;
}

export interface MotionSignature {
  /** Signature easing curve for ~80 percent of movement. */
  easing: [number, number, number, number];
  durations: { quick: number; standard: number; slow: number };
  /** Stillness after a beat resolves, milliseconds. */
  holdMs: number;
  /** No object crosses the whole frame on one unbroken interpolation. */
  maxTravelFraction: number;
}

export interface AudioTargets {
  targetLufs: number;
  truePeakDb: number;
  /** Whether the series expects a music bed by default. */
  musicByDefault: boolean;
}

export interface Preset {
  id: string;
  label: string;
  composition: CompositionId;
  width: number;
  height: number;
  fps: number;
  defaultDurationSeconds: number;
  brand: BrandTokens;
  safeZones: SafeZones;
  captions: CaptionRules;
  typography: Typography;
  proofCard: ProofCard;
  motion: MotionSignature;
  audio: AudioTargets;
  /** One-line editorial stance recorded in the render plan. */
  editorialStance: string;
}
