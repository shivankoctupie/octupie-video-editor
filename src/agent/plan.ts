/**
 * Deterministic edit-plan builder.
 *
 * This is the agent's safety net. Given a valid brief it produces a valid edit
 * plan with no model in the loop, by scaling a restrained starter plan to the
 * brief's preset and duration and wiring in the first declared source clip. The
 * planner loop uses it as the offline provider's output and as the guaranteed
 * fallback when the model never returns a valid plan. Because it only emits
 * data validated by the edit-plan schema, it can never run anything.
 */

import type { AgentBrief } from "./brief.js";
import { getPreset } from "../presets/index.js";
import { makeStarterPlan } from "../presets/starter.js";
import { parseEditPlan, type EditPlan } from "../schema/editPlan.js";

export interface DeterministicPlanResult {
  ok: boolean;
  plan?: EditPlan;
  errors: string[];
}

export function buildDeterministicPlan(brief: AgentBrief): DeterministicPlanResult {
  let preset;
  try {
    preset = getPreset(brief.preset);
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }

  const starter = makeStarterPlan(preset, {
    title: briefTitle(brief),
    duration: brief.desiredDurationSeconds,
  }) as Record<string, unknown>;

  starter.output = { fileName: brief.output.fileName };

  if (brief.sourceClips.length > 0) {
    starter.sourceClips = brief.sourceClips.map((c) => ({ id: c.id, path: c.path }));
    // Wire the first clip into the first scene as real footage, muted so the
    // deterministic bed stays in control of loudness.
    const scenes = starter.scenes as Array<Record<string, unknown>>;
    const first = scenes[0];
    const firstClip = brief.sourceClips[0]!;
    if (first) {
      first.sourceClipId = firstClip.id;
      first.sourceIn = 0;
      first.mute = true;
      first.fit = "cover";
    }
  }

  const parsed = parseEditPlan(starter);
  if (!parsed.ok || !parsed.plan) {
    return { ok: false, errors: parsed.errors };
  }
  return { ok: true, plan: parsed.plan, errors: [] };
}

function briefTitle(brief: AgentBrief): string {
  const base = brief.objective.trim().replace(/\s+/g, " ");
  return base.length > 80 ? base.slice(0, 77) + "..." : base;
}
