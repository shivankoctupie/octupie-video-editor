/**
 * Runtime-validated schemas for true multimodal source-footage interpretation
 * (parity phase 2B, scope A).
 *
 * These schemas are the trust boundary for everything a restricted vision
 * provider returns. Unlike the phase-2A local analysis (OpenCV blur, brightness,
 * face boxes, histogram deltas), this layer carries *semantic* findings: a facial
 * expression read from real frames, an off-camera crew prompt heard in the
 * transcript and confirmed on screen, a weak take, on-screen product proof, a
 * visual glitch, whether B-roll is relevant, and a genuine hook moment. Every
 * finding is data only. Nothing here is executed; the planner consumes the
 * validated result, and a human still signs off on the master.
 *
 * The model is forced to return a small, strict object; the engine wraps it with
 * provider identity, the clip reference, and the FFprobe-authoritative duration,
 * then re-validates, so a model reply can never spoof its own identity or smuggle
 * a finding that runs backwards or past the end of the footage.
 */

import { z } from "zod";
import { isSafeRelativePath } from "../util/paths.js";
import { assetRefSchema } from "../analysis/schemas.js";

/** Small tolerance (seconds) for float timing at the very end of a clip. */
const TIMING_TOLERANCE = 0.25;

const seconds = z.number().finite();
const nonNegSeconds = z.number().finite().min(0, "must not be negative");
const unitInterval = z.number().min(0).max(1);

/** The seven explicit semantic finding kinds this layer promises to cover. */
export const FINDING_KINDS = [
  "facial-expression",
  "crew-prompt",
  "weak-take",
  "product-proof",
  "visual-glitch",
  "broll-relevance",
  "hook-moment",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/**
 * A reference to one sampled frame the finding is grounded in. The path is a
 * portable relative filename (e.g. `frame_00007.jpg`); it is never an absolute
 * path, so a finding can never point the reader outside the frame directory.
 */
export const evidenceFrameSchema = z
  .object({
    path: z.string().refine(isSafeRelativePath, "must be a portable relative frame reference (no drive letter, absolute root, or '..')"),
    atSeconds: nonNegSeconds,
  })
  .strict();
export type EvidenceFrameValue = z.infer<typeof evidenceFrameSchema>;

/** One semantic finding: a kind, a valid source time range, confidence, rationale, evidence. */
export const semanticFindingSchema = z
  .object({
    kind: z.enum(FINDING_KINDS),
    startSeconds: nonNegSeconds,
    endSeconds: seconds,
    confidence: unitInterval,
    /** Plain-language reason a human editor can audit. Never empty. */
    rationale: z.string().min(1, "a finding needs a plain-language rationale"),
    /** At least one sampled frame the finding is grounded in. */
    evidenceFrames: z.array(evidenceFrameSchema).min(1, "a finding must cite at least one evidence frame"),
  })
  .strict()
  .refine((f) => f.endSeconds >= f.startSeconds, {
    message: "finding endSeconds must be >= startSeconds",
    path: ["endSeconds"],
  });
export type SemanticFindingValue = z.infer<typeof semanticFindingSchema>;

/** A time-ranged semantic segment for the planner manifest. */
export const semanticSegmentSchema = z
  .object({
    startSeconds: nonNegSeconds,
    endSeconds: seconds,
    /** What is happening, in plain language. */
    description: z.string().min(1),
    /** Editorial salience 0..1. */
    salience: unitInterval,
    tags: z.array(z.string().min(1)),
  })
  .strict()
  .refine((s) => s.endSeconds >= s.startSeconds, {
    message: "segment endSeconds must be >= startSeconds",
    path: ["endSeconds"],
  });
export type SemanticSegmentValue = z.infer<typeof semanticSegmentSchema>;

/**
 * The exact shape the model is asked to return. It carries only interpretation,
 * never identity: the engine supplies format, clip, duration, provider, and
 * timestamp so the model cannot spoof any of them.
 */
export const modelUnderstandingSchema = z
  .object({
    findings: z.array(semanticFindingSchema),
    segments: z.array(semanticSegmentSchema),
    summary: z.string().min(1),
    /** What the model could and could not determine; never empty (honesty gate). */
    limitations: z.array(z.string().min(1)).min(1, "the model must state at least one limitation"),
  })
  .strict();
export type ModelUnderstandingValue = z.infer<typeof modelUnderstandingSchema>;

export const SEMANTIC_UNDERSTANDING_FORMAT = "octupie-semantic-understanding/v1";

/** Assemble timing-bounds checks shared by findings, segments, and evidence frames. */
function checkTimingWithinDuration(
  duration: number,
  ranges: { startSeconds: number; endSeconds: number; label: string }[],
  points: { atSeconds: number; label: string }[],
  ctx: z.RefinementCtx,
): void {
  const limit = duration + TIMING_TOLERANCE;
  for (const r of ranges) {
    if (r.endSeconds > limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${r.label} ends at ${r.endSeconds}s, past clip duration ${duration}s`,
        path: ["findings"],
      });
      return;
    }
  }
  for (const p of points) {
    if (p.atSeconds > limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${p.label} is at ${p.atSeconds}s, past clip duration ${duration}s`,
        path: ["findings"],
      });
      return;
    }
  }
}

/** The full validated artifact written to disk. */
export const semanticUnderstandingSchema = z
  .object({
    format: z.literal(SEMANTIC_UNDERSTANDING_FORMAT),
    clip: assetRefSchema,
    durationSeconds: z.number().finite().positive(),
    generatedAt: z.string().min(1),
    provider: z
      .object({
        id: z.string().min(1),
        model: z.string().min(1),
      })
      .strict(),
    findings: z.array(semanticFindingSchema),
    segments: z.array(semanticSegmentSchema),
    summary: z.string().min(1),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((u, ctx) => {
    const ranges = [
      ...u.findings.map((f, i) => ({ startSeconds: f.startSeconds, endSeconds: f.endSeconds, label: `finding[${i}] (${f.kind})` })),
      ...u.segments.map((s, i) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, label: `segment[${i}]` })),
    ];
    const points = u.findings.flatMap((f, i) =>
      f.evidenceFrames.map((e, j) => ({ atSeconds: e.atSeconds, label: `finding[${i}] evidence[${j}]` })),
    );
    checkTimingWithinDuration(u.durationSeconds, ranges, points, ctx);
  });
export type SemanticUnderstandingValue = z.infer<typeof semanticUnderstandingSchema>;

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

export function parseModelUnderstanding(json: unknown): ParseResult<ModelUnderstandingValue> {
  const r = modelUnderstandingSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

export function parseSemanticUnderstanding(json: unknown): ParseResult<SemanticUnderstandingValue> {
  const r = semanticUnderstandingSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}
