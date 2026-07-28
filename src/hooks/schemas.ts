/**
 * Runtime-validated schemas for complete hook-variant production (parity phase 5).
 *
 * A hook-variant request asks for exactly N distinct opening variants, and each
 * variant must be renderer-ready DATA, not prose. These schemas are the trust
 * boundary. Two rules are enforced structurally, not by convention:
 *
 *   1. Strict objects: an unknown field is rejected, so a provider can never
 *      smuggle an extra flag (or a forged identity) past the boundary.
 *   2. Bounded everything: strings, arrays, and the requested count are capped so
 *      a hostile or runaway response cannot exhaust memory or over-produce.
 *
 * The identity fields on a set (format, generatedAt, provider, source-plan hash,
 * count) are stamped by the engine, never by a provider. A provider returns only
 * interpretation data (`modelHookVariantSchema`); the engine assembles the final,
 * identity-stamped `hookVariantSetSchema`. Each variant carries either a COMPLETE
 * replacement edit plan or a strictly typed opening fragment that the engine
 * deterministically merges and then re-validates against the edit-plan schema.
 */

import { z } from "zod";
import { editPlanSchema, type EditPlan } from "../schema/editPlan.js";

/**
 * The opening scene id: first `hook`, else first `intro`, else the earliest
 * scene. Shared so the prompt, the deterministic producer, and the opening-only
 * guard all agree on which scene is "the opening".
 */
export function selectHookSceneId(plan: EditPlan): string {
  const byType = (t: EditPlan["scenes"][number]["type"]) => plan.scenes.find((s) => s.type === t);
  const hook = byType("hook") ?? byType("intro");
  if (hook) return hook.id;
  let earliest = plan.scenes[0]!;
  for (const s of plan.scenes) if (s.start < earliest.start) earliest = s;
  return earliest.id;
}

export const HOOK_VARIANT_SET_FORMAT = "octupie-hook-variant-set/v1";

/** Hard cap on how many variants a single request may ask for. */
export const MAX_HOOK_COUNT = 10;

/**
 * Safe opening strategies. Each rewrites only the opening line; none invents
 * media or source ranges. There are at least `MAX_HOOK_COUNT` of them so any
 * bounded request can be filled with a distinct strategy per variant.
 */
export const HOOK_STRATEGIES = [
  "direct-question",
  "bold-claim",
  "curiosity-gap",
  "stat-callout",
  "direct-address",
  "contrarian",
  "story-open",
  "pattern-interrupt",
  "problem-first",
  "outcome-first",
] as const;
export type HookStrategy = (typeof HOOK_STRATEGIES)[number];

// Bounded string budgets.
const MAX_OBJECTIVE = 2000;
const MAX_HOOK_TEXT = 400;
const MAX_RATIONALE = 1200;
const MAX_STYLE = 200;
const MAX_CAPTION = 200;
const MAX_TRANSCRIPT = 512 * 1024;
const MAX_WORD_TIMINGS = 20000;
const MAX_SOURCE_RANGES = 200;
const MAX_LIST = 50;

const unitInterval = z.number().min(0).max(1);
const nonNeg = z.number().finite().min(0, "must not be negative");
const bounded = (max: number) => z.string().min(1).max(max);

/** One word with its timing, as an optional planning aid. Never invents media. */
export const wordTimingSchema = z
  .object({
    text: bounded(200),
    startSeconds: nonNeg,
    endSeconds: z.number().finite(),
  })
  .strict()
  .refine((w) => w.endSeconds >= w.startSeconds, { message: "word end must be at or after start", path: ["endSeconds"] });
export type WordTimingValue = z.infer<typeof wordTimingSchema>;

/** An operator-approved source range the opening may draw from. Purely advisory data. */
export const approvedSourceRangeSchema = z
  .object({
    clipId: bounded(200),
    startSeconds: nonNeg,
    endSeconds: z.number().finite(),
  })
  .strict()
  .refine((r) => r.endSeconds > r.startSeconds, { message: "range end must be after start", path: ["endSeconds"] });
export type ApprovedSourceRangeValue = z.infer<typeof approvedSourceRangeSchema>;

/**
 * Style constraints for the opening. `allowBodyChanges` is the only switch that
 * lets a variant touch anything beyond the opening scene; it defaults to false,
 * so by default a variant changes only the opening.
 */
export const hookStyleConstraintsSchema = z
  .object({
    tone: bounded(MAX_STYLE).optional(),
    maxWords: z.number().int().min(1).max(40).optional(),
    allowBodyChanges: z.boolean().optional(),
    bannedPhrases: z.array(bounded(MAX_STYLE)).max(MAX_LIST).optional(),
    requiredKeywords: z.array(bounded(MAX_STYLE)).max(MAX_LIST).optional(),
  })
  .strict();
export type HookStyleConstraintsValue = z.infer<typeof hookStyleConstraintsSchema>;

/**
 * A hook-variant request. STRICT and bounded. The count is hard-bounded 1..10.
 * The source plan is the exact base every variant is derived from; it is
 * re-validated here against the full edit-plan schema.
 */
export const hookVariantRequestSchema = z
  .object({
    objective: z.string().trim().min(1, "an objective is required").max(MAX_OBJECTIVE),
    count: z.number().int().min(1, "count must be at least 1").max(MAX_HOOK_COUNT, `count must be at most ${MAX_HOOK_COUNT}`),
    sourcePlan: editPlanSchema,
    transcriptText: z.string().max(MAX_TRANSCRIPT).optional(),
    wordTimings: z.array(wordTimingSchema).max(MAX_WORD_TIMINGS).optional(),
    approvedSourceRanges: z.array(approvedSourceRangeSchema).max(MAX_SOURCE_RANGES).optional(),
    style: hookStyleConstraintsSchema.optional(),
  })
  .strict();
export type HookVariantRequestValue = z.infer<typeof hookVariantRequestSchema>;

/**
 * A strictly typed opening fragment. It can only change the opening scene's text
 * and its overlapping caption; it has no field that could add a scene, a clip,
 * b-roll, or audio. Merging it can never invent media.
 */
export const hookPlanFragmentSchema = z
  .object({
    hookSceneId: bounded(200),
    heading: bounded(MAX_HOOK_TEXT).optional(),
    body: bounded(MAX_HOOK_TEXT).optional(),
    emphasis: bounded(MAX_HOOK_TEXT).optional(),
    frameZero: bounded(MAX_HOOK_TEXT).optional(),
    captionText: bounded(MAX_CAPTION).optional(),
  })
  .strict()
  .refine((f) => f.heading || f.body || f.emphasis || f.frameZero || f.captionText, {
    message: "a hook fragment must change at least one opening field",
  });
export type HookPlanFragmentValue = z.infer<typeof hookPlanFragmentSchema>;

/**
 * How a variant carries its plan change: a COMPLETE replacement plan (preferred
 * for safety) or a strictly typed fragment the engine merges. Both are validated.
 */
export const hookPlanCarrierSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete"), plan: editPlanSchema }).strict(),
  z.object({ kind: z.literal("fragment"), fragment: hookPlanFragmentSchema }).strict(),
]);
export type HookPlanCarrierValue = z.infer<typeof hookPlanCarrierSchema>;

/**
 * What a provider returns: interpretation data ONLY. No id, no timestamp, no
 * source-plan hash, no provider identity. The engine stamps all of that.
 */
export const modelHookVariantSchema = z
  .object({
    strategy: z.enum(HOOK_STRATEGIES),
    style: bounded(MAX_STYLE),
    hookText: bounded(MAX_HOOK_TEXT),
    rationale: bounded(MAX_RATIONALE),
    confidence: unitInterval,
    plan: hookPlanCarrierSchema,
  })
  .strict();
export type ModelHookVariantValue = z.infer<typeof modelHookVariantSchema>;

export const modelHookVariantSetSchema = z
  .object({
    variants: z.array(modelHookVariantSchema).min(1).max(MAX_HOOK_COUNT),
  })
  .strict();
export type ModelHookVariantSetValue = z.infer<typeof modelHookVariantSetSchema>;

/** One engine-stamped variant. `id` and `planHash` are assigned by the engine. */
export const hookVariantSchema = z
  .object({
    id: bounded(64),
    strategy: z.enum(HOOK_STRATEGIES),
    style: bounded(MAX_STYLE),
    hookText: bounded(MAX_HOOK_TEXT),
    rationale: bounded(MAX_RATIONALE),
    confidence: unitInterval,
    plan: hookPlanCarrierSchema,
    /** SHA-256 of the resolved COMPLETE plan. Distinct per variant. */
    planHash: z.string().length(64),
  })
  .strict();
export type HookVariantValue = z.infer<typeof hookVariantSchema>;

/** Normalize hook text for distinctness comparison: lowercase, collapse whitespace. */
export function normalizeHookText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function assertDistinct(values: readonly string[], label: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate ${label}: ${JSON.stringify(v)}`, path: ["variants"] });
      return;
    }
    seen.add(v);
  }
}

/**
 * The full, identity-stamped hook-variant set. STRICT. It must hold exactly
 * `count` variants, and their ids, normalized hook text, strategies, and plan
 * hashes must all be distinct. This is the single completeness-and-uniqueness gate.
 */
export const hookVariantSetSchema = z
  .object({
    format: z.literal(HOOK_VARIANT_SET_FORMAT),
    objective: bounded(MAX_OBJECTIVE),
    count: z.number().int().min(1).max(MAX_HOOK_COUNT),
    generatedAt: z.string().min(1),
    provider: z.object({ id: z.string().min(1), model: z.string().min(1) }).strict(),
    sourcePlan: z
      .object({
        title: z.string().min(1),
        identity: z.string().min(1),
        hash: z.string().length(64),
      })
      .strict(),
    variants: z.array(hookVariantSchema).min(1).max(MAX_HOOK_COUNT),
  })
  .strict()
  .superRefine((set, ctx) => {
    if (set.variants.length !== set.count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected exactly ${set.count} variant(s), got ${set.variants.length}`,
        path: ["variants"],
      });
    }
    assertDistinct(set.variants.map((v) => v.id), "variant id", ctx);
    assertDistinct(set.variants.map((v) => normalizeHookText(v.hookText)), "hook text", ctx);
    assertDistinct(set.variants.map((v) => v.strategy), "strategy", ctx);
    assertDistinct(set.variants.map((v) => v.planHash), "plan hash", ctx);
  });
export type HookVariantSetValue = z.infer<typeof hookVariantSetSchema>;

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

export function parseHookVariantRequest(json: unknown): ParseResult<HookVariantRequestValue> {
  const r = hookVariantRequestSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

export function parseModelHookVariantSet(json: unknown): ParseResult<ModelHookVariantSetValue> {
  const r = modelHookVariantSetSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

export function parseHookVariantSet(json: unknown): ParseResult<HookVariantSetValue> {
  const r = hookVariantSetSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}
