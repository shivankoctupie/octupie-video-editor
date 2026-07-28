/**
 * Bounded review wiring (parity phase 3).
 *
 * Composes the production render, critique, and revision steps into the
 * provider-neutral bounded loop. Each round renders the exact current plan,
 * samples and critiques the exact rendered master through the restricted
 * provider, and, if unapproved, asks a text provider for a complete replacement
 * plan that the loop re-validates before re-rendering. Every step is injectable
 * so the whole review runs offline in tests without rendering or spawning; the
 * production defaults are built lazily so importing this module never loads the
 * renderer. Explicit `network` and `media-upload` grants are required up front.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { createPolicy, requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import type { AgentBrief } from "../agent/brief.js";
import type { ExecFn } from "../agent/exec.js";
import { createClaudeProvider } from "../agent/providers/claude.js";
import { probe } from "../ffmpeg/ffprobe.js";
import type { EditPlan } from "../schema/editPlan.js";
import { critiqueRenderedMaster } from "./critique.js";
import { createClaudeCritiqueProvider, type ClaudeCritiqueConfig } from "./claudeCritique.js";
import {
  runRevisionLoop,
  createClaudeRevisionStep,
  type RenderStep,
  type CritiqueStep,
  type RevisionStep,
  type RevisionLoopResult,
  type RoundRecord,
} from "./revise.js";

/** Committed edit-plan JSON Schema text, so the revision model has the exact contract. */
function editPlanSchemaText(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "..", "..", "schema", "edit-plan.schema.json"), "utf8");
}

function reviewOutputRoot(): string {
  const dir = process.env.OVE_OUTPUT_DIR?.trim() || "output";
  return resolve(process.cwd(), dir);
}

export interface ReviewPlanInput {
  plan: EditPlan;
  maxRounds: number;
  permissionPolicy?: PermissionPolicy;
  /** Output root the masters and frames stay under. Defaults to the output root. */
  outputRoot?: string;
  /** When present, revised plans must use only brief-declared media. */
  brief?: AgentBrief;
  now?: Date;
  config?: Partial<ClaudeCritiqueConfig>;
  runner?: ExecFn;

  // Injectable steps (production defaults built lazily below).
  render?: RenderStep;
  critique?: CritiqueStep;
  revise?: RevisionStep;
  onRound?: (record: RoundRecord) => void;
}

/**
 * Production render step: render the exact plan to a master, then read its real
 * duration with FFprobe. Loads the renderer lazily so this module stays cheap.
 */
function defaultRenderStep(root: string): RenderStep {
  return async (plan) => {
    const { renderPlan } = await import("../pipeline.js");
    const result = await renderPlan(plan, { dir: root });
    const probed = await probe(result.finalPath);
    const durationSeconds = Number(probed.format.duration);
    return {
      master: { path: relative(root, result.finalPath).replace(/\\/g, "/") },
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : plan.duration,
      masterAbsPath: result.finalPath,
    };
  };
}

/**
 * Production critique step: sample and critique the exact rendered master through
 * the restricted provider, writing a per-round critique artifact under the root.
 */
function defaultCritiqueStep(
  root: string,
  policy: PermissionPolicy,
  input: ReviewPlanInput,
): CritiqueStep {
  const provider = createClaudeCritiqueProvider(input.runner ? { runner: input.runner } : {});
  return async (rendered, plan) => {
    if (!rendered.masterAbsPath) throw new Error("Render step did not produce a master path to critique.");
    const res = await critiqueRenderedMaster({
      plan,
      masterPath: rendered.masterAbsPath,
      outputRoot: root,
      permissionPolicy: policy,
      provider,
      ...(input.config ? { config: input.config } : {}),
      ...(input.runner ? { runner: input.runner } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
    return res.critique;
  };
}

/** Production revision step: ask the Claude text provider for a replacement plan. */
function defaultReviseStep(input: ReviewPlanInput): RevisionStep {
  const provider = createClaudeProvider(input.runner ? { exec: input.runner } : {});
  return createClaudeRevisionStep({
    provider,
    schemaText: editPlanSchemaText(),
    ...(input.brief ? { brief: input.brief } : {}),
  });
}

/**
 * Run the bounded review loop. Denies the boundary-crossing actions by default;
 * the loop itself is hard-capped and escalates to a human at the cap or on any
 * invalid proposal (see {@link runRevisionLoop}).
 */
export async function reviewPlan(input: ReviewPlanInput): Promise<RevisionLoopResult> {
  const policy = input.permissionPolicy ?? createPolicy([]);
  requireGrant("network", policy, input.now);
  requireGrant("media-upload", policy, input.now);

  const root = input.outputRoot ? resolve(input.outputRoot) : reviewOutputRoot();
  const render = input.render ?? defaultRenderStep(root);
  const critique = input.critique ?? defaultCritiqueStep(root, policy, input);
  const revise = input.revise ?? defaultReviseStep(input);

  return runRevisionLoop({
    plan: input.plan,
    maxRounds: input.maxRounds,
    render,
    critique,
    revise,
    ...(input.brief ? { brief: input.brief } : {}),
    ...(input.onRound ? { onRound: input.onRound } : {}),
  });
}
