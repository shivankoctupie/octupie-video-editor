/**
 * Runtime-validated schemas and types for local transcription and deterministic
 * editorial source analysis (parity phase 2A).
 *
 * These schemas are the trust boundary for everything a local Python bridge or an
 * FFmpeg pass produces. A word-timed transcript, its segments and speakers, the
 * silence / filler / crew-prompt marks, repeated-take groups, candidate hooks,
 * audio facts, and sampled-frame metrics all validate here before any of it is
 * written to an artifact or read by the planner. Timings are checked for
 * monotonicity and clip containment so a broken decoder can never smuggle out a
 * transcript that runs backwards or past the end of the footage.
 *
 * Nothing here claims semantic understanding. A "candidate hook" is a heuristic
 * score over timed words, a "mark" is a lexical or acoustic flag, and a speaker
 * label is only produced when a real diarizing provider supplies one. The schema
 * records measurements and heuristics, never certainty.
 */

import { z } from "zod";
import { isSafeRelativePath } from "../util/paths.js";

/** Small tolerance (seconds) for float timing at the very end of a clip. */
const TIMING_TOLERANCE = 0.25;

const seconds = z.number().finite();
const nonNegSeconds = z.number().finite().min(0, "must not be negative");

export const assetRefSchema = z
  .object({
    path: z.string().refine(isSafeRelativePath, "must be a portable relative path (no drive letter, absolute root, or '..')"),
    id: z.string().min(1).optional(),
  })
  .strict();
export type AssetRefValue = z.infer<typeof assetRefSchema>;

export const wordSchema = z
  .object({
    text: z.string().min(1),
    startSeconds: nonNegSeconds,
    endSeconds: seconds,
    speaker: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((w) => w.endSeconds >= w.startSeconds, {
    message: "word endSeconds must be >= startSeconds",
    path: ["endSeconds"],
  });
export type WordValue = z.infer<typeof wordSchema>;

export const segmentSchema = z
  .object({
    id: z.string().min(1),
    startSeconds: nonNegSeconds,
    endSeconds: seconds,
    text: z.string(),
    speaker: z.string().min(1).optional(),
    words: z.array(wordSchema),
  })
  .strict()
  .refine((s) => s.endSeconds >= s.startSeconds, {
    message: "segment endSeconds must be >= startSeconds",
    path: ["endSeconds"],
  });
export type SegmentValue = z.infer<typeof segmentSchema>;

/** True when every word start is non-decreasing and each end >= its start. */
export function wordsAreMonotonic(words: readonly WordValue[]): boolean {
  let prevStart = -Infinity;
  for (const w of words) {
    if (w.startSeconds < prevStart) return false;
    if (w.endSeconds < w.startSeconds) return false;
    prevStart = w.startSeconds;
  }
  return true;
}

export const transcriptSchema = z
  .object({
    clip: assetRefSchema,
    durationSeconds: z.number().finite().positive(),
    language: z.string().min(1),
    words: z.array(wordSchema),
    segments: z.array(segmentSchema),
    speakers: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (!wordsAreMonotonic(t.words)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "words must be monotonic in time", path: ["words"] });
    }
    for (const w of t.words) {
      if (w.endSeconds > t.durationSeconds + TIMING_TOLERANCE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `word "${w.text}" ends at ${w.endSeconds}s, past clip duration ${t.durationSeconds}s`,
          path: ["words"],
        });
        break;
      }
    }
  });
export type TranscriptValue = z.infer<typeof transcriptSchema>;

export const MARK_KINDS = ["filler", "silence", "crew-prompt"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export const markSchema = z
  .object({
    kind: z.enum(MARK_KINDS),
    startSeconds: nonNegSeconds,
    endSeconds: seconds,
    text: z.string().optional(),
    /** Auditable reason this was flagged (the matched token, phrase, or acoustic rule). */
    reason: z.string().min(1),
  })
  .strict()
  .refine((m) => m.endSeconds >= m.startSeconds, {
    message: "mark endSeconds must be >= startSeconds",
    path: ["endSeconds"],
  });
export type MarkValue = z.infer<typeof markSchema>;

export const takeGroupSchema = z
  .object({
    id: z.string().min(1),
    /** Segment ids that are repeated attempts at the same line. */
    segmentIds: z.array(z.string().min(1)).min(1, "a take group needs at least one segment"),
    /** Heuristic pick of the best take, if the grouping offers one. */
    preferredSegmentId: z.string().min(1).optional(),
    reason: z.string().optional(),
  })
  .strict();
export type TakeGroupValue = z.infer<typeof takeGroupSchema>;

export const candidateHookSchema = z
  .object({
    startSeconds: nonNegSeconds,
    endSeconds: seconds,
    text: z.string(),
    /** Heuristic strength 0..1. Not a semantic guarantee. */
    score: z.number().min(0).max(1),
    reasons: z.array(z.string()),
  })
  .strict()
  .refine((h) => h.endSeconds >= h.startSeconds, {
    message: "hook endSeconds must be >= startSeconds",
    path: ["endSeconds"],
  });
export type CandidateHookValue = z.infer<typeof candidateHookSchema>;

export const timeRangeSchema = z
  .object({ startSeconds: nonNegSeconds, endSeconds: seconds })
  .strict()
  .refine((r) => r.endSeconds >= r.startSeconds, { message: "endSeconds must be >= startSeconds", path: ["endSeconds"] });

export const audioFactsSchema = z
  .object({
    durationSeconds: z.number().finite().nonnegative(),
    speechSeconds: z.number().finite().nonnegative(),
    silenceSeconds: z.number().finite().nonnegative(),
    speechRatio: z.number().min(0).max(1),
    silenceThresholdDb: z.number().finite(),
    minSilenceSeconds: z.number().finite().nonnegative(),
    silences: z.array(timeRangeSchema),
    meanVolumeDb: z.number().finite().optional(),
    maxVolumeDb: z.number().finite().optional(),
  })
  .strict();
export type AudioFactsValue = z.infer<typeof audioFactsSchema>;

/** A detected face box in normalized [0,1] frame coordinates. */
export const faceSchema = z
  .object({
    xNorm: z.number().min(0).max(1),
    yNorm: z.number().min(0).max(1),
    wNorm: z.number().min(0).max(1),
    hNorm: z.number().min(0).max(1),
  })
  .strict();
export type FaceValue = z.infer<typeof faceSchema>;

export const frameMetricSchema = z
  .object({
    atSeconds: nonNegSeconds,
    /** Variance of the Laplacian. Higher is sharper; low means blurry. */
    blur: z.number().finite().nonnegative(),
    /** Mean luma normalized 0..1. */
    brightness: z.number().min(0).max(1),
    faceCount: z.number().int().nonnegative(),
    faces: z.array(faceSchema),
    /** 0..1 change from the previous sampled frame (1 = fully different). */
    discontinuity: z.number().min(0).max(1).optional(),
  })
  .strict();
export type FrameMetricValue = z.infer<typeof frameMetricSchema>;

export const SOURCE_ANALYSIS_FORMAT = "octupie-source-analysis/v1";

export const sourceAnalysisSchema = z
  .object({
    format: z.literal(SOURCE_ANALYSIS_FORMAT),
    clip: assetRefSchema,
    durationSeconds: z.number().finite().positive(),
    generatedAt: z.string().min(1),
    transcription: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        language: z.string().min(1),
      })
      .strict(),
    transcript: transcriptSchema,
    marks: z.array(markSchema),
    takes: z.array(takeGroupSchema),
    candidateHooks: z.array(candidateHookSchema),
    audio: audioFactsSchema,
    frames: z.array(frameMetricSchema).optional(),
    /** Honest caveats: what the heuristics do and do not claim. */
    notes: z.array(z.string()),
  })
  .strict();
export type SourceAnalysisValue = z.infer<typeof sourceAnalysisSchema>;

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

export function parseTranscript(json: unknown): ParseResult<TranscriptValue> {
  const r = transcriptSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

export function parseSourceAnalysis(json: unknown): ParseResult<SourceAnalysisValue> {
  const r = sourceAnalysisSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}
