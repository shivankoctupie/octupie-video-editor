/**
 * Bounded planner/reviewer loop.
 *
 * Each iteration asks the provider for a plan, extracts JSON robustly, and
 * validates it against the real edit-plan schema. Validation errors go back to
 * the planner as repair instructions. A valid plan is then sent for a separate
 * structured critique; only an approved, valid plan is accepted. The loop is
 * capped, and on exhaustion it returns a deterministic fallback so a run always
 * yields a valid, renderable plan. The model only ever proposes data; nothing
 * it returns is executed.
 */

import type { AgentBrief } from "./brief.js";
import type { Provider } from "./providers/types.js";
import type { RuleLike } from "./prompt.js";
import { buildPlannerMessages, buildCritiqueMessages, parseCritique, type Critique } from "./prompt.js";
import { extractJsonObject } from "./json.js";
import { parseEditPlan, type EditPlan } from "../schema/editPlan.js";
import { buildDeterministicPlan } from "./plan.js";
import { redactSecrets, truncate, MAX_SIZES } from "./redact.js";
import { sha256String } from "../util/hash.js";

export interface PlannerLoopInput {
  brief: AgentBrief;
  provider: Provider;
  manifestText: string;
  transcriptText?: string;
  rules: RuleLike[];
  schemaText: string;
  maxIterations: number;
}

export interface IterationRecord {
  index: number;
  planPrompt: string;
  planPromptHash: string;
  planProviderMeta: Record<string, unknown>;
  rawPlanReply: string;
  planErrors: string[];
  plan?: EditPlan;
  critiquePrompt?: string;
  critiquePromptHash?: string;
  critiqueProviderMeta?: Record<string, unknown>;
  critiqueRaw?: string;
  critique?: Critique;
  accepted: boolean;
  note: string;
}

export interface PlannerLoopResult {
  finalPlan: EditPlan;
  usedFallback: boolean;
  accepted: boolean;
  iterations: IterationRecord[];
  finalCritique?: Critique;
}

export async function runPlannerLoop(input: PlannerLoopInput): Promise<PlannerLoopResult> {
  const maxIterations = Math.max(1, Math.min(20, Math.floor(input.maxIterations)));
  const iterations: IterationRecord[] = [];
  let priorErrors: string[] | undefined;
  let lastValidPlan: EditPlan | undefined;

  for (let i = 1; i <= maxIterations; i++) {
    const rec: IterationRecord = {
      index: i,
      planPrompt: "",
      planPromptHash: "",
      planProviderMeta: {},
      rawPlanReply: "",
      planErrors: [],
      accepted: false,
      note: "",
    };

    const planMsgs = buildPlannerMessages({
      brief: input.brief,
      manifestText: input.manifestText,
      ...(input.transcriptText ? { transcriptText: input.transcriptText } : {}),
      rules: input.rules,
      schemaText: input.schemaText,
      ...(priorErrors ? { priorErrors } : {}),
    });
    rec.planPrompt = redactSecrets(`${planMsgs.system}\n\n${planMsgs.prompt}`);
    rec.planPromptHash = sha256String(planMsgs.system + "\n" + planMsgs.prompt);

    const planRes = await input.provider.generate({
      kind: "plan",
      system: planMsgs.system,
      prompt: planMsgs.prompt,
      context: { brief: input.brief },
    });
    rec.planProviderMeta = planRes.meta;
    rec.rawPlanReply = truncate(redactSecrets(planRes.text), MAX_SIZES.modelResponse);

    if (!planRes.ok) {
      const err = redactSecrets(planRes.error ?? "provider returned no plan");
      rec.planErrors = [err];
      rec.note = `provider error: ${err}`;
      priorErrors = [err];
      iterations.push(rec);
      continue;
    }

    const extracted = extractJsonObject(planRes.text);
    if (!extracted.ok) {
      rec.planErrors = [extracted.error ?? "no JSON object in reply"];
      rec.note = "could not extract JSON from the plan reply";
      priorErrors = rec.planErrors;
      iterations.push(rec);
      continue;
    }

    const parsed = parseEditPlan(extracted.value);
    if (!parsed.ok || !parsed.plan) {
      rec.planErrors = parsed.errors;
      rec.note = "plan failed schema validation";
      priorErrors = parsed.errors;
      iterations.push(rec);
      continue;
    }

    const policyErrors = validatePlanMedia(parsed.plan, input.brief);
    if (policyErrors.length > 0) {
      rec.planErrors = policyErrors;
      rec.note = "plan referenced media not declared in the brief";
      priorErrors = policyErrors;
      iterations.push(rec);
      continue;
    }

    rec.plan = parsed.plan;
    lastValidPlan = parsed.plan;

    // Separate structured critique of the valid plan.
    const critMsgs = buildCritiqueMessages({ brief: input.brief, plan: parsed.plan, rules: input.rules });
    rec.critiquePrompt = redactSecrets(`${critMsgs.system}\n\n${critMsgs.prompt}`);
    rec.critiquePromptHash = sha256String(critMsgs.system + "\n" + critMsgs.prompt);
    const critRes = await input.provider.generate({
      kind: "critique",
      system: critMsgs.system,
      prompt: critMsgs.prompt,
      context: { brief: input.brief, plan: parsed.plan },
    });
    rec.critiqueProviderMeta = critRes.meta;
    rec.critiqueRaw = truncate(redactSecrets(critRes.text), MAX_SIZES.modelResponse);

    let critique: Critique | undefined;
    if (critRes.ok) {
      const cext = extractJsonObject(critRes.text);
      if (cext.ok) {
        const pc = parseCritique(cext.value);
        if (pc.ok) critique = pc.critique;
      }
    }
    if (critique) rec.critique = critique;

    if (critique?.approved) {
      rec.accepted = true;
      rec.note = "valid plan approved by reviewer";
      iterations.push(rec);
      return { finalPlan: parsed.plan, usedFallback: false, accepted: true, iterations, finalCritique: critique };
    }

    // Not approved (or no usable critique): feed the reviewer's issues back.
    if (critique && critique.issues.length > 0) {
      priorErrors = critique.issues;
      rec.note = "reviewer rejected; issues fed back";
    } else if (critique) {
      priorErrors = ["reviewer did not approve the plan; strengthen it against the rubric"];
      rec.note = "reviewer rejected without specific issues";
    } else {
      priorErrors = ["reviewer critique was unavailable or malformed; re-verify the plan against the rubric"];
      rec.note = "critique unavailable";
    }
    iterations.push(rec);
  }

  // Exhausted the cap: preserve a deterministic fallback.
  const fallback = buildDeterministicPlan(input.brief);
  if (fallback.ok && fallback.plan) {
    return { finalPlan: fallback.plan, usedFallback: true, accepted: false, iterations };
  }
  if (lastValidPlan) {
    return { finalPlan: lastValidPlan, usedFallback: false, accepted: false, iterations };
  }
  throw new Error(
    `Planner produced no valid plan and the deterministic fallback failed: ${fallback.errors.join("; ")}`,
  );
}

function validatePlanMedia(plan: EditPlan, brief: AgentBrief): string[] {
  const errors: string[] = [];
  const declaredById = new Map(brief.sourceClips.map((clip) => [clip.id, clip.path]));
  const declaredPaths = new Set(brief.sourceClips.map((clip) => clip.path));

  for (const clip of plan.sourceClips) {
    const declaredPath = declaredById.get(clip.id);
    if (declaredPath === undefined) {
      errors.push(`source clip '${clip.id}' is undeclared; only brief-declared media may be used`);
    } else if (declaredPath !== clip.path) {
      errors.push(`source clip '${clip.id}' changed its declared path`);
    }
  }

  for (const scene of plan.scenes) {
    if (scene.broll && !declaredPaths.has(scene.broll)) {
      errors.push(`scene '${scene.id}' uses undeclared B-roll '${scene.broll}'`);
    }
  }

  const externalAudio = [
    plan.audio.dialoguePath,
    plan.audio.music?.path,
    ...plan.audio.sfx.map((cue) => cue.asset),
  ].filter((path): path is string => path !== undefined);
  for (const path of externalAudio) {
    if (!declaredPaths.has(path)) {
      errors.push(`undeclared audio asset '${path}'; all external media must be declared in the brief`);
    }
  }

  return errors;
}
