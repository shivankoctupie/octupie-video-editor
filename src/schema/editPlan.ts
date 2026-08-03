import { z } from "zod";
import { isSafeRelativePath } from "../util/paths.js";
import { validateCues, SFX_FAMILIES, SFX_INTENSITIES } from "../sfx/gates.js";

/**
 * The edit-plan schema is the stable contract between the planning layer
 * (language models) and the deterministic renderer. It is intentionally strict:
 * a plan that validates here is renderable and QA-able without further guessing.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;
const hexColor = z.string().regex(HEX, "must be a 6-digit hex color like #014CE3");

const safePath = z
  .string()
  .refine(isSafeRelativePath, "must be a portable relative path (no drive letter, absolute root, or '..')");

export const SCENE_TYPES = [
  "intro",
  "hook",
  "proof",
  "explanation",
  "breather",
  "payoff",
  "product-reveal",
  "logo-lockup",
  "cta",
  "title",
] as const;

const nonNegative = z.number().finite().min(0, "must not be negative");

export const brandSchema = z
  .object({
    name: z.string().min(1),
    font: z.string().min(1),
    paper: hexColor,
    ink: hexColor,
    accent: hexColor,
    paper2: hexColor.optional(),
  })
  .strict();

export const sceneSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(SCENE_TYPES),
    start: nonNegative,
    end: z.number().finite(),
    heading: z.string().optional(),
    body: z.string().optional(),
    emphasis: z.string().optional(),
    // Frame-zero intent: a scene may declare a value visible at its first frame.
    frameZero: z.string().optional(),
    punchIn: z.number().min(1).max(2).optional(),
    broll: safePath.optional(),
    // Real source footage: reference a declared source clip by id, optionally
    // starting at a nonnegative offset into that clip, with playback fit and mute.
    sourceClipId: z.string().min(1).optional(),
    sourceIn: nonNegative.optional(),
    mute: z.boolean().optional(),
    fit: z.enum(["cover", "contain"]).optional(),
  })
  .strict()
  .refine((s) => s.end > s.start, {
    message: "scene end must be after start",
    path: ["end"],
  });

export const captionCardSchema = z
  .object({
    text: z.string().min(1),
    start: nonNegative,
    end: z.number().finite(),
  })
  .strict()
  .refine((c) => c.end > c.start, { message: "caption end must be after start", path: ["end"] });

export const captionsSchema = z
  .object({
    maxWordsPerCard: z.number().int().min(1).max(8).default(3),
    allowExtendedCards: z.boolean().default(false),
    cards: z.array(captionCardSchema).default([]),
  })
  .strict();

export const sourceClipSchema = z
  .object({
    id: z.string().min(1),
    path: safePath,
    in: nonNegative.optional(),
    out: z.number().finite().optional(),
  })
  .strict()
  .refine((c) => c.in === undefined || c.out === undefined || c.out > c.in, {
    message: "clip out must be after in",
    path: ["out"],
  });

export const sfxCueSchema = z
  .object({
    time: nonNegative,
    asset: safePath,
    family: z.enum(SFX_FAMILIES),
    intensity: z.enum(SFX_INTENSITIES),
    role: z.string().min(1, "every cue needs a stated editorial role"),
    duration: z.number().finite().positive().optional(),
  })
  .strict();

export const audioSchema = z
  .object({
    targetLufs: z.number().finite().default(-16),
    truePeakDb: z.number().finite().default(-1.5),
    dialoguePath: safePath.optional(),
    music: z
      .object({
        path: safePath,
        license: z.string().min(1),
        sourceUrl: z.string().url(),
      })
      .strict()
      .optional(),
    sfx: z.array(sfxCueSchema).default([]),
  })
  .strict();

export const outputSchema = z
  .object({
    fileName: safePath,
    container: z.literal("mp4").default("mp4"),
    videoCodec: z.literal("h264").default("h264"),
    pixelFormat: z.literal("yuv420p").default("yuv420p"),
    audioCodec: z.literal("aac").default("aac"),
    audioSampleRate: z.literal(48000).default(48000),
    videoBitrate: z.string().default("12M"),
    audioBitrate: z.string().default("192k"),
    faststart: z.boolean().default(true),
    stripMetadata: z.boolean().default(true),
  })
  .strict();

/*
 * Editor timeline (additive, optional, backward-compatible).
 *
 * The browser timeline editor is track/clip based with per-clip transforms, trims, text,
 * and volume. That richer state is stored here losslessly so a reload reproduces the exact
 * timeline. It is purely additive: legacy plans omit it and still validate. The deterministic
 * renderer keeps consuming `scenes`/`captions`/`sourceClips`; on save the editor derives a
 * valid projection into those fields, so both the editor and the renderer stay honest.
 */
const transformSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    scale: z.number().finite().positive(),
    rotation: z.number().finite(),
    opacity: z.number().min(0).max(1),
  })
  .strict();

const captionStyleSchema = z
  .object({
    fontSize: z.number().finite().positive(),
    color: hexColor,
    background: z.union([hexColor, z.literal("")]),
    align: z.enum(["left", "center", "right"]),
    bold: z.boolean(),
  })
  .strict();

export const timelineTrackSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["video", "overlay", "caption", "audio"]),
    name: z.string(),
    muted: z.boolean(),
    locked: z.boolean(),
  })
  .strict();

export const timelineClipSchema = z
  .object({
    id: z.string().min(1),
    trackId: z.string().min(1),
    start: nonNegative,
    duration: z.number().finite().positive(),
    mediaId: z.string().min(1).nullable(),
    // Render-only media reference: the safe relative storage path the deterministic renderer
    // resolves this clip's bytes from. The editor keys media by `mediaId` locally; on save it
    // fills `mediaPath` for every media-backed clip so the final master can project the whole
    // timeline, not just the first video track. Optional and additive: timelines saved before
    // this field still validate and load (the editor re-derives the path from `mediaId` on the
    // next save), and text/caption clips never carry one.
    mediaPath: safePath.optional(),
    sourceIn: nonNegative,
    sourceDuration: z.number().finite().positive().nullable(),
    text: z.string(),
    transform: transformSchema,
    volume: z.number().min(0).max(1),
    captionStyle: captionStyleSchema.nullable(),
    name: z.string(),
  })
  .strict();

export const editorTimelineSchema = z
  .object({
    version: z.literal(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive().max(120),
    duration: z.number().finite().positive(),
    tracks: z.array(timelineTrackSchema),
    clips: z.array(timelineClipSchema),
  })
  .strict()
  .superRefine((tl, ctx) => {
    const trackIds = new Set(tl.tracks.map((t) => t.id));
    const seenTrack = new Set<string>();
    tl.tracks.forEach((t, i) => {
      if (seenTrack.has(t.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate timeline track id '${t.id}'`, path: ["tracks", i, "id"] });
      } else {
        seenTrack.add(t.id);
      }
    });
    const seenClip = new Set<string>();
    tl.clips.forEach((c, i) => {
      if (!trackIds.has(c.trackId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `timeline clip '${c.id}' references unknown track '${c.trackId}'`, path: ["clips", i, "trackId"] });
      }
      if (seenClip.has(c.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate timeline clip id '${c.id}'`, path: ["clips", i, "id"] });
      } else {
        seenClip.add(c.id);
      }
    });
  });

export const editPlanSchema = z
  .object({
    format: z.literal("octupie-edit-plan/v1"),
    title: z.string().min(1),
    preset: z.string().min(1),
    composition: z.enum(["PremiumProductFilm", "FounderSocialReel"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive().max(120),
    duration: z.number().finite().positive(),
    brand: brandSchema,
    scenes: z.array(sceneSchema).min(1),
    captions: captionsSchema.default({ maxWordsPerCard: 3, allowExtendedCards: false, cards: [] }),
    sourceClips: z.array(sourceClipSchema).default([]),
    audio: audioSchema.default({ targetLufs: -16, truePeakDb: -1.5, sfx: [] }),
    output: outputSchema,
    timeline: editorTimelineSchema.optional(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    // Source-clip integrity gates: ids are unique, references resolve, and each
    // scene's in-point sits inside the referenced clip's valid range.
    const clipById = new Map<string, (typeof plan.sourceClips)[number]>();
    plan.sourceClips.forEach((clip, i) => {
      if (clipById.has(clip.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate source clip id '${clip.id}'`,
          path: ["sourceClips", i, "id"],
        });
      } else {
        clipById.set(clip.id, clip);
      }
    });
    plan.scenes.forEach((scene, i) => {
      if (scene.sourceClipId === undefined) return;
      const clip = clipById.get(scene.sourceClipId);
      if (!clip) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `scene '${scene.id}' references unknown source clip '${scene.sourceClipId}'`,
          path: ["scenes", i, "sourceClipId"],
        });
        return;
      }
      const clipIn = clip.in ?? 0;
      const startInto = scene.sourceIn ?? clipIn;
      if (scene.sourceIn !== undefined && scene.sourceIn < clipIn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `scene '${scene.id}' sourceIn ${scene.sourceIn}s starts before clip '${clip.id}' in-point ${clipIn}s`,
          path: ["scenes", i, "sourceIn"],
        });
      }
      if (clip.out !== undefined && startInto >= clip.out) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `scene '${scene.id}' sourceIn ${startInto}s is at or past clip '${clip.id}' out-point ${clip.out}s`,
          path: ["scenes", i, "sourceIn"],
        });
      }
      if (clip.out !== undefined && startInto + (scene.end - scene.start) > clip.out + 0.0001) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `scene '${scene.id}' needs ${scene.end - scene.start}s from clip '${clip.id}', past its out-point ${clip.out}s`,
          path: ["scenes", i, "sourceIn"],
        });
      }
    });

    // Scene range and overlap gates.
    const sorted = [...plan.scenes].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      const scene = sorted[i]!;
      if (scene.end > plan.duration) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `scene '${scene.id}' ends at ${scene.end}s, past the plan duration ${plan.duration}s`,
          path: ["scenes"],
        });
      }
      if (i > 0) {
        const prev = sorted[i - 1]!;
        if (scene.start < prev.end) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `scenes '${prev.id}' and '${scene.id}' overlap between ${scene.start}s and ${prev.end}s`,
            path: ["scenes"],
          });
        }
      }
    }

    // Caption word-count gate.
    const hardMax = plan.captions.allowExtendedCards ? plan.captions.maxWordsPerCard : 3;
    plan.captions.cards.forEach((card, i) => {
      const words = card.text.trim().split(/\s+/).filter(Boolean);
      if (words.length > hardMax) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `caption card ${i + 1} has ${words.length} words ("${card.text}"); limit is ${hardMax}${
            plan.captions.allowExtendedCards ? " (preset-extended)" : " (one to three words)"
          }`,
          path: ["captions", "cards", i, "text"],
        });
      }
      if (card.end > plan.duration) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `caption card ${i + 1} ends past the plan duration`,
          path: ["captions", "cards", i, "end"],
        });
      }
    });

    // SFX stack gates (blocking errors only; warnings are surfaced elsewhere).
    const sfxResult = validateCues(plan.audio.sfx);
    for (const error of sfxResult.errors) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `sfx: ${error}`, path: ["audio", "sfx"] });
    }
    for (const cue of plan.audio.sfx) {
      if (cue.time > plan.duration || (cue.duration !== undefined && cue.time + cue.duration > plan.duration + 0.0001)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `sfx cue at ${cue.time}s extends past the plan duration`,
          path: ["audio", "sfx"],
        });
      }
    }
  });

export type EditPlan = z.infer<typeof editPlanSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type CaptionCard = z.infer<typeof captionCardSchema>;
export type EditorTimeline = z.infer<typeof editorTimelineSchema>;
export type TimelineTrackValue = z.infer<typeof timelineTrackSchema>;
export type TimelineClipValue = z.infer<typeof timelineClipSchema>;

export interface ParseResult {
  ok: boolean;
  plan?: EditPlan;
  errors: string[];
}

export function parseEditPlan(input: unknown): ParseResult {
  const result = editPlanSchema.safeParse(input);
  if (result.success) {
    return { ok: true, plan: result.data, errors: [] };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, errors };
}
