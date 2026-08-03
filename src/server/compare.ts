/**
 * Truthful version comparison. The diff reports only real differences derived from the
 * stored records and their plan JSON: identical plan/master by SHA-256, and concrete
 * structural deltas (duration, fps, dimensions, scene set, caption cards). It never
 * invents a difference and never claims two versions match unless their hashes do.
 */

import type { VersionRow } from "./db/repository.js";

interface PlanFacts {
  durationSeconds: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  sceneIds: string[];
  captionCards: number;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Extract the comparable facts from a plan object, tolerating shape variation. */
export function planFacts(plan: unknown): PlanFacts {
  const p = (plan ?? {}) as Record<string, unknown>;
  const scenes = Array.isArray(p.scenes) ? (p.scenes as Array<Record<string, unknown>>) : [];
  const captions = (p.captions ?? {}) as Record<string, unknown>;
  const cards = Array.isArray(captions.cards) ? captions.cards : [];
  return {
    durationSeconds: num(p.durationSeconds) ?? num(p.duration),
    fps: num(p.fps),
    width: num(p.width),
    height: num(p.height),
    sceneIds: scenes.map((s, i) => (typeof s.id === "string" ? s.id : `#${i}`)),
    captionCards: cards.length,
  };
}

export interface VersionComparison {
  a: string;
  b: string;
  planIdentical: boolean;
  masterState: "identical" | "different" | "one-missing" | "none";
  duration: { a: number | null; b: number | null; changed: boolean };
  fpsChanged: boolean;
  dimensionsChanged: boolean;
  scenes: { added: string[]; removed: string[]; countA: number; countB: number };
  captionCards: { a: number; b: number; changed: boolean };
  summary: string;
}

export function compareVersions(a: VersionRow, b: VersionRow, planA: unknown, planB: unknown): VersionComparison {
  const fa = planFacts(planA);
  const fb = planFacts(planB);
  const planIdentical = a.planSha256 === b.planSha256;

  let masterState: VersionComparison["masterState"];
  if (!a.masterSha256 && !b.masterSha256) masterState = "none";
  else if (!a.masterSha256 || !b.masterSha256) masterState = "one-missing";
  else masterState = a.masterSha256 === b.masterSha256 ? "identical" : "different";

  const setA = new Set(fa.sceneIds);
  const setB = new Set(fb.sceneIds);
  const added = fb.sceneIds.filter((id) => !setA.has(id));
  const removed = fa.sceneIds.filter((id) => !setB.has(id));

  const durationChanged = fa.durationSeconds !== fb.durationSeconds;
  const fpsChanged = fa.fps !== fb.fps;
  const dimensionsChanged = fa.width !== fb.width || fa.height !== fb.height;
  const captionChanged = fa.captionCards !== fb.captionCards;

  const parts: string[] = [];
  parts.push(planIdentical ? "Plans are byte-identical." : "Plans differ.");
  if (durationChanged) parts.push(`Duration ${fa.durationSeconds ?? "?"}s to ${fb.durationSeconds ?? "?"}s.`);
  if (added.length) parts.push(`${added.length} scene(s) added.`);
  if (removed.length) parts.push(`${removed.length} scene(s) removed.`);
  if (fpsChanged) parts.push("fps changed.");
  if (dimensionsChanged) parts.push("dimensions changed.");
  if (captionChanged) parts.push(`caption cards ${fa.captionCards} to ${fb.captionCards}.`);
  parts.push(`Master: ${masterState}.`);

  return {
    a: a.id,
    b: b.id,
    planIdentical,
    masterState,
    duration: { a: fa.durationSeconds, b: fb.durationSeconds, changed: durationChanged },
    fpsChanged,
    dimensionsChanged,
    scenes: { added, removed, countA: fa.sceneIds.length, countB: fb.sceneIds.length },
    captionCards: { a: fa.captionCards, b: fb.captionCards, changed: captionChanged },
    summary: parts.join(" "),
  };
}
