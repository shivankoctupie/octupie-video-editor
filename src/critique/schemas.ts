/**
 * Runtime-validated schemas for rendered-draft multimodal critique (parity
 * phase 3).
 *
 * This is the trust boundary for everything a restricted critique provider
 * returns about an actually-rendered master (not just the plan). Each note is
 * anchored to a source time and, optionally, one sampled evidence frame; it
 * carries a severity, a category, a concise human-readable note, and optional
 * suggested plan changes expressed as DATA ONLY. Nothing here is executed: the
 * bounded revision loop consumes validated data, re-validates any replacement
 * plan against the edit-plan schema, and a human still signs off on the master.
 *
 * The model is asked to return a small, strict object carrying only its
 * interpretation. The engine wraps it with format, the master reference, the
 * FFprobe-authoritative master duration, provider identity, and a timestamp,
 * then re-validates, so a model reply can never spoof its own identity or anchor
 * a note past the end of the real master.
 */

import { z } from "zod";
import { isSafeRelativePath } from "../util/paths.js";
import { assetRefSchema } from "../analysis/schemas.js";

/** Small tolerance (seconds) for float timing at the very end of a master. */
const TIMING_TOLERANCE = 0.25;

const nonNegSeconds = z.number().finite().min(0, "must not be negative");

export const DRAFT_CRITIQUE_FORMAT = "octupie-draft-critique/v1";

/** Severities a note can carry. A `blocker` must be cleared before approval. */
export const CRITIQUE_SEVERITIES = ["info", "suggest", "blocker"] as const;
export type CritiqueSeverity = (typeof CRITIQUE_SEVERITIES)[number];

/** The editorial categories a note may fall under. Strict, but broad. */
export const CRITIQUE_CATEGORIES = [
  "pacing",
  "captions",
  "audio",
  "visual",
  "continuity",
  "legibility",
  "branding",
  "framing",
  "compliance",
  "other",
] as const;
export type CritiqueCategory = (typeof CRITIQUE_CATEGORIES)[number];

/**
 * A reference to one sampled evidence frame the note is grounded in. The path is
 * a portable relative filename (e.g. `critique_frame_00002.jpg`); it is never an
 * absolute path, so a note can never point the reader outside the frame directory.
 */
export const critiqueEvidenceFrameSchema = z
  .object({
    path: z
      .string()
      .refine(isSafeRelativePath, "must be a portable relative frame reference (no drive letter, absolute root, or '..')"),
    atSeconds: nonNegSeconds,
  })
  .strict();
export type CritiqueEvidenceFrameValue = z.infer<typeof critiqueEvidenceFrameSchema>;

/**
 * A suggested plan change, DATA ONLY. It names a target (a scene id, "captions",
 * "audio", etc.) and describes the change in plain language. The engine never
 * applies this directly; the revision loop asks a provider for a complete
 * replacement plan and re-validates that, so this is purely advisory.
 */
export const suggestedPlanChangeSchema = z
  .object({
    target: z.string().min(1),
    change: z.string().min(1),
  })
  .strict();
export type SuggestedPlanChangeValue = z.infer<typeof suggestedPlanChangeSchema>;

/** One frame-anchored critique note. */
export const critiqueNoteSchema = z
  .object({
    atSeconds: nonNegSeconds,
    severity: z.enum(CRITIQUE_SEVERITIES),
    category: z.enum(CRITIQUE_CATEGORIES),
    /** Concise, plain-language note a human editor can act on. Never empty. */
    note: z.string().min(1, "a note needs concise plain-language text"),
    /** Optional single sampled frame the note is grounded in. */
    evidenceFrame: critiqueEvidenceFrameSchema.optional(),
    /** Optional advisory plan changes, DATA only; never executed. */
    suggestedPlanChanges: z.array(suggestedPlanChangeSchema).optional(),
  })
  .strict();
export type CritiqueNoteValue = z.infer<typeof critiqueNoteSchema>;

/**
 * The exact shape the model is asked to return. It carries only interpretation,
 * never identity: the engine supplies format, master, duration, provider, and
 * timestamp so the model cannot spoof any of them.
 */
export const modelCritiqueSchema = z
  .object({
    approved: z.boolean(),
    notes: z.array(critiqueNoteSchema),
    summary: z.string().min(1),
    /** What the model could and could not determine; never empty (honesty gate). */
    limitations: z.array(z.string().min(1)).min(1, "the model must state at least one limitation"),
  })
  .strict();
export type ModelCritiqueValue = z.infer<typeof modelCritiqueSchema>;

/** Assert every anchored time lies within the real master duration. */
function checkTimingWithinDuration(duration: number, notes: readonly CritiqueNoteValue[], ctx: z.RefinementCtx): void {
  const limit = duration + TIMING_TOLERANCE;
  notes.forEach((n, i) => {
    if (n.atSeconds > limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `note[${i}] is at ${n.atSeconds}s, past master duration ${duration}s`,
        path: ["notes", i, "atSeconds"],
      });
    }
    if (n.evidenceFrame && n.evidenceFrame.atSeconds > limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `note[${i}] evidence frame is at ${n.evidenceFrame.atSeconds}s, past master duration ${duration}s`,
        path: ["notes", i, "evidenceFrame", "atSeconds"],
      });
    }
  });
}

/** The full validated critique artifact written to disk. */
export const draftCritiqueSchema = z
  .object({
    format: z.literal(DRAFT_CRITIQUE_FORMAT),
    master: assetRefSchema,
    durationSeconds: z.number().finite().positive(),
    generatedAt: z.string().min(1),
    provider: z
      .object({
        id: z.string().min(1),
        model: z.string().min(1),
      })
      .strict(),
    approved: z.boolean(),
    notes: z.array(critiqueNoteSchema),
    summary: z.string().min(1),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((c, ctx) => checkTimingWithinDuration(c.durationSeconds, c.notes, ctx));
export type DraftCritiqueValue = z.infer<typeof draftCritiqueSchema>;

/** True when any note is a blocker. */
export function hasBlockers(notes: readonly CritiqueNoteValue[]): boolean {
  return notes.some((n) => n.severity === "blocker");
}

/**
 * True only when the critique is approved AND carries no blocker note. An
 * approved flag with an outstanding blocker is never treated as approval.
 */
export function isApproved(critique: DraftCritiqueValue): boolean {
  return critique.approved && !hasBlockers(critique.notes);
}

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

export function parseModelCritique(json: unknown): ParseResult<ModelCritiqueValue> {
  const r = modelCritiqueSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

export function parseDraftCritique(json: unknown): ParseResult<DraftCritiqueValue> {
  const r = draftCritiqueSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}
