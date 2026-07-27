/**
 * SFX cue gate engine.
 *
 * Deterministic port of the learned sound-design rules. It is the single source
 * of truth for both the standalone cue-sheet validator and the edit-plan schema
 * refinement. It never touches audio; it only reasons about a planned cue list.
 *
 * Gates: role presence, family/intensity validity, blacklist, near-time
 * repetition of the same waveform, dense stacks, the default trailer stack
 * (whoosh + riser + impact), heavy-family-as-texture, and hero-cue spacing.
 */

export const SFX_FAMILIES = [
  "ambience",
  "foley",
  "whoosh",
  "riser",
  "impact",
  "ui",
  "tick",
  "paper",
  "tonal",
  "glitch",
  "other",
] as const;

export type SfxFamily = (typeof SFX_FAMILIES)[number];

export const SFX_INTENSITIES = ["texture", "support", "hero"] as const;
export type SfxIntensity = (typeof SFX_INTENSITIES)[number];

/** Assets the founder has rejected. Derivatives are caught by base-name match. */
export const SFX_BLACKLIST = ["impact_ultra_serious_48k_pcm24.wav"] as const;

export const STACK_WINDOW = 0.12; // seconds; cues inside this collapse into a stack
export const REPEAT_WINDOW = 4.0; // seconds; same waveform reused too soon
export const HERO_WINDOW = 10.0; // seconds; hero cues need contrast between them
export const HEAVY_FAMILIES: readonly SfxFamily[] = ["riser", "impact"];
/** The default trailer stack the founder rejected as a lazy pattern. */
export const TRAILER_STACK: readonly SfxFamily[] = ["whoosh", "riser", "impact"];

export interface RawCue {
  time: number;
  asset: string;
  family?: string;
  intensity?: string;
  role?: string;
  duration?: number;
}

export interface GateResult {
  errors: string[];
  warnings: string[];
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/);
  return parts[parts.length - 1] ?? p;
}

function isBlacklisted(asset: string): boolean {
  const name = baseName(asset).toLowerCase();
  // Match the exact rejected file and obvious renamed/derived variants that
  // keep the recognizable stem.
  const stem = "impact_ultra_serious";
  return SFX_BLACKLIST.some((b) => b.toLowerCase() === name) || name.includes(stem);
}

interface NormalCue {
  index: number;
  time: number;
  asset: string;
  family: string;
  intensity: string;
  role: string;
}

export function validateCues(cues: readonly RawCue[]): GateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalized: NormalCue[] = [];

  cues.forEach((cue, i) => {
    const index = i + 1;
    if (cue === null || typeof cue !== "object") {
      errors.push(`cue ${index}: entry is not an object`);
      return;
    }
    if (typeof cue.time !== "number" || !Number.isFinite(cue.time)) {
      errors.push(`cue ${index}: numeric 'time' is required`);
      return;
    }
    if (cue.time < 0) {
      errors.push(`cue ${index} at ${cue.time.toFixed(3)}s: negative time`);
    }
    const asset = baseName(String(cue.asset ?? ""));
    if (!asset) {
      errors.push(`cue ${index} at ${cue.time.toFixed(3)}s: 'asset' is required`);
    }
    if (isBlacklisted(String(cue.asset ?? ""))) {
      errors.push(
        `cue ${index} at ${cue.time.toFixed(3)}s: blacklisted asset '${asset}'`,
      );
    }
    const role = String(cue.role ?? "").trim();
    if (!role) {
      warnings.push(
        `cue ${index} at ${cue.time.toFixed(3)}s: no distinct editorial role stated`,
      );
    }
    const family = String(cue.family ?? "other").toLowerCase();
    if (!(SFX_FAMILIES as readonly string[]).includes(family)) {
      errors.push(
        `cue ${index} at ${cue.time.toFixed(3)}s: unknown family '${family}'`,
      );
    }
    const intensity = String(cue.intensity ?? "support").toLowerCase();
    if (!(SFX_INTENSITIES as readonly string[]).includes(intensity)) {
      errors.push(
        `cue ${index} at ${cue.time.toFixed(3)}s: invalid intensity '${intensity}'`,
      );
    }
    normalized.push({ index, time: cue.time, asset, family, intensity, role });
  });

  normalized.sort((a, b) => a.time - b.time);

  // Dense-stack and trailer-stack gates.
  for (let left = 0; left < normalized.length; left++) {
    const anchor = normalized[left]!;
    const nearby: NormalCue[] = [anchor];
    for (let right = left + 1; right < normalized.length; right++) {
      const other = normalized[right]!;
      if (other.time - anchor.time > STACK_WINDOW) break;
      nearby.push(other);
    }
    if (nearby.length >= 3) {
      const families = new Set(nearby.map((c) => c.family));
      const labels = nearby.map((c) => `${c.family}:${c.asset}`).join(", ");
      warnings.push(
        `dense stack near ${anchor.time.toFixed(3)}s (${nearby.length} cues): ${labels}. ` +
          `Start with one cue and justify every additional layer.`,
      );
      if (TRAILER_STACK.every((f) => families.has(f))) {
        errors.push(
          `default trailer stack near ${anchor.time.toFixed(3)}s: whoosh + riser + impact. ` +
            `This requires an explicit hero-level narrative justification.`,
        );
      }
    }
  }

  // Repeated-waveform gate.
  const byAsset = new Map<string, number[]>();
  for (const cue of normalized) {
    const key = cue.asset.toLowerCase();
    const list = byAsset.get(key) ?? [];
    list.push(cue.time);
    byAsset.set(key, list);
  }
  for (const [asset, times] of byAsset) {
    for (let i = 1; i < times.length; i++) {
      const earlier = times[i - 1]!;
      const later = times[i]!;
      if (later - earlier < REPEAT_WINDOW) {
        warnings.push(
          `repeated waveform '${asset}' at ${earlier.toFixed(3)}s and ${later.toFixed(3)}s. ` +
            `Use an alternate take, different source region, or fewer cues.`,
        );
      }
    }
  }

  // Hero-spacing gate.
  const heroes = normalized.filter((c) => c.intensity === "hero");
  for (let i = 1; i < heroes.length; i++) {
    const earlier = heroes[i - 1]!;
    const later = heroes[i]!;
    if (later.time - earlier.time < HERO_WINDOW) {
      warnings.push(
        `hero cues only ${(later.time - earlier.time).toFixed(2)}s apart at ` +
          `${earlier.time.toFixed(3)}s and ${later.time.toFixed(3)}s. Preserve contrast.`,
      );
    }
  }

  // Heavy-family-as-texture gate.
  for (const cue of normalized) {
    if (HEAVY_FAMILIES.includes(cue.family as SfxFamily) && cue.intensity === "texture") {
      warnings.push(
        `${cue.family} at ${cue.time.toFixed(3)}s is labeled texture. ` +
          `Confirm the asset is genuinely subtle or choose a lighter family.`,
      );
    }
  }

  return { errors, warnings };
}
