/**
 * Provider-neutral bounded revision loop (parity phase 3).
 *
 * Each round renders the exact current plan, critiques the exact rendered master,
 * and stops when the critique is approved with no outstanding blocker. Otherwise
 * it asks a revision provider for a COMPLETE replacement plan expressed as DATA,
 * parses it with the existing strict edit-plan schema, enforces declared-media
 * and brief constraints where a brief is available, and only then re-renders. The
 * loop is hard-bounded: at the round cap (or with no revision provider, or on any
 * invalid or constraint-violating proposal) it halts and returns
 * `humanEscalation: true` rather than looping unbounded or accepting an invalid
 * plan. Nothing a provider returns is executed; the engine only validates data.
 * Every round is recorded so the caller can persist audit artifacts under a run
 * directory.
 */

import { parseEditPlan, type EditPlan } from "../schema/editPlan.js";
import type { AssetRefValue } from "../analysis/schemas.js";
import type { AgentBrief } from "../agent/brief.js";
import { validatePlanMedia } from "../agent/planner.js";
import { extractJsonObject } from "../agent/json.js";
import type { Provider } from "../agent/providers/types.js";
import { isApproved, type DraftCritiqueValue } from "./schemas.js";

const MIN_ROUNDS = 1;
const MAX_ROUNDS = 10;

/** What one render round produced; carried into the critique step unchanged. */
export interface DraftRenderResult {
  master: AssetRefValue;
  durationSeconds: number;
  /** Absolute path of the rendered master, when a real render produced one. */
  masterAbsPath?: string;
}

export type RenderStep = (plan: EditPlan, round: number) => Promise<DraftRenderResult>;
export type CritiqueStep = (rendered: DraftRenderResult, plan: EditPlan, round: number) => Promise<DraftCritiqueValue>;
/** Returns a replacement plan as DATA (an object) or as raw model text. */
export type RevisionStep = (plan: EditPlan, critique: DraftCritiqueValue, round: number) => Promise<unknown>;

export interface RoundRecord {
  round: number;
  plan: EditPlan;
  rendered: DraftRenderResult;
  critique: DraftCritiqueValue;
  approved: boolean;
  blockers: number;
  revisionAccepted?: boolean;
  revisionErrors?: string[];
  note: string;
}

export interface RevisionLoopInput {
  plan: EditPlan;
  maxRounds: number;
  render: RenderStep;
  critique: CritiqueStep;
  /** Absent means no revision is attempted; the first unapproved round escalates. */
  revise?: RevisionStep;
  /** When present, revised plans must use only brief-declared media. */
  brief?: AgentBrief;
  /** Called once per round with its full record, for audit persistence. */
  onRound?: (record: RoundRecord) => void;
}

export interface RevisionLoopResult {
  approved: boolean;
  humanEscalation: boolean;
  rounds: number;
  finalPlan: EditPlan;
  finalCritique: DraftCritiqueValue;
  reason: string;
  history: RoundRecord[];
}

function countBlockers(critique: DraftCritiqueValue): number {
  return critique.notes.filter((n) => n.severity === "blocker").length;
}

export async function runRevisionLoop(input: RevisionLoopInput): Promise<RevisionLoopResult> {
  const maxRounds = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, Math.floor(input.maxRounds || 0)));
  const history: RoundRecord[] = [];
  let plan = input.plan;

  const finish = (
    rec: RoundRecord,
    approved: boolean,
    humanEscalation: boolean,
  ): RevisionLoopResult => {
    history.push(rec);
    input.onRound?.(rec);
    return {
      approved,
      humanEscalation,
      rounds: rec.round,
      finalPlan: plan,
      finalCritique: rec.critique,
      reason: rec.note,
      history,
    };
  };

  for (let round = 1; round <= maxRounds; round++) {
    const rendered = await input.render(plan, round);
    const critique = await input.critique(rendered, plan, round);
    const blockers = countBlockers(critique);
    const approved = isApproved(critique);
    const rec: RoundRecord = { round, plan, rendered, critique, approved, blockers, note: "" };

    if (approved) {
      rec.note = "approved with no blockers";
      return finish(rec, true, false);
    }

    if (round === maxRounds) {
      rec.note = `reached the round cap (${maxRounds}) without approval; escalating to a human`;
      return finish(rec, false, true);
    }

    if (!input.revise) {
      rec.note = "unapproved and no revision provider configured; escalating to a human";
      return finish(rec, false, true);
    }

    // Ask for a replacement plan as DATA. Parse strictly; never accept an invalid plan.
    const proposal = await input.revise(plan, critique, round);
    let candidate: unknown = proposal;
    if (typeof proposal === "string") {
      const ex = extractJsonObject(proposal);
      if (!ex.ok) {
        rec.revisionAccepted = false;
        rec.revisionErrors = [ex.error ?? "no JSON object in revision reply"];
        rec.note = "revised plan text held no JSON object; escalating to a human";
        return finish(rec, false, true);
      }
      candidate = ex.value;
    }

    const parsed = parseEditPlan(candidate);
    if (!parsed.ok || !parsed.plan) {
      rec.revisionAccepted = false;
      rec.revisionErrors = parsed.errors;
      rec.note = "revised plan failed schema validation; escalating to a human";
      return finish(rec, false, true);
    }

    if (input.brief) {
      const mediaErrors = validatePlanMedia(parsed.plan, input.brief);
      if (mediaErrors.length > 0) {
        rec.revisionAccepted = false;
        rec.revisionErrors = mediaErrors;
        rec.note = "revised plan referenced undeclared media; escalating to a human";
        return finish(rec, false, true);
      }
    }

    rec.revisionAccepted = true;
    rec.note = "revised plan validated; re-rendering next round";
    history.push(rec);
    input.onRound?.(rec);
    plan = parsed.plan;
  }

  // Unreachable: the round-cap branch always returns. Kept for exhaustiveness.
  throw new Error("Revision loop exited without a result.");
}

// --- Claude-backed revision step ---------------------------------------------

export interface RevisionMessages {
  system: string;
  prompt: string;
}

export interface BuildRevisionMessagesInput {
  plan: EditPlan;
  critique: DraftCritiqueValue;
  /** The committed edit-plan JSON Schema text, so the model has the exact contract. */
  schemaText: string;
  brief?: AgentBrief;
}

const REVISION_SYSTEM = [
  "You revise a video edit plan after a critique of the ACTUALLY RENDERED master.",
  "Return ONE complete, corrected edit plan as a single JSON object, nothing else.",
  "It must satisfy the edit-plan JSON Schema exactly and fix every blocker note.",
  "Use ONLY media already declared; never invent source clips, B-roll, audio, or SFX.",
  "You return DATA ONLY. The engine re-validates and re-renders; nothing you write is executed.",
].join(" ");

/** Build the repair prompt: the critique, the current plan, and the schema. */
export function buildRevisionMessages(input: BuildRevisionMessagesInput): RevisionMessages {
  const noteLines = input.critique.notes
    .map((n) => `- [${n.severity}] ${n.category} @ ${n.atSeconds}s: ${n.note}`)
    .join("\n");
  const prompt = [
    `Critique summary: ${input.critique.summary}`,
    ``,
    `Critique notes:`,
    noteLines || "(none)",
    ``,
    `Current edit plan (fix the blockers; keep everything else that works):`,
    JSON.stringify(input.plan),
    ``,
    `Edit-plan JSON Schema the corrected plan must satisfy:`,
    input.schemaText,
    ``,
    `Return one corrected edit plan JSON object only.`,
  ].join("\n");
  return { system: REVISION_SYSTEM, prompt };
}

export interface ClaudeRevisionStepOptions {
  provider: Provider;
  schemaText: string;
  brief?: AgentBrief;
}

/**
 * A revision step backed by any text provider (e.g. the restricted Claude CLI).
 * It asks for a replacement plan and returns the raw reply text; the loop parses
 * and validates it, so the provider's output is never trusted or executed here.
 */
export function createClaudeRevisionStep(opts: ClaudeRevisionStepOptions): RevisionStep {
  return async (plan, critique) => {
    const msgs = buildRevisionMessages({
      plan,
      critique,
      schemaText: opts.schemaText,
      ...(opts.brief ? { brief: opts.brief } : {}),
    });
    const res = await opts.provider.generate({
      kind: "plan",
      system: msgs.system,
      prompt: msgs.prompt,
      context: { brief: opts.brief ?? ({ sourceClips: [] } as unknown as AgentBrief), plan },
    });
    if (!res.ok) throw new Error(res.error ?? "revision provider returned no plan");
    return res.text;
  };
}
