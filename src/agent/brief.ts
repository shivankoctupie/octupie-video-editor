import { z } from "zod";
import { isSafeRelativePath } from "../util/paths.js";

/**
 * AgentBrief v1 is the human-authored request the agentic layer plans from.
 * It is intentionally strict and portable: every path is a safe relative path,
 * so a brief can travel between machines and can never point the agent at a
 * private absolute location. The agent turns a valid brief into a validated
 * edit plan; it never invents a brief.
 */

const safePath = z
  .string()
  .refine(isSafeRelativePath, "must be a portable relative path (no drive letter, absolute root, or '..')");

export const briefSourceClipSchema = z
  .object({
    id: z.string().min(1),
    path: safePath,
  })
  .strict();

export const briefTranscriptSchema = z
  .object({
    text: z.string().min(1).optional(),
    path: safePath.optional(),
  })
  .strict()
  .refine((t) => t.text !== undefined || t.path !== undefined, {
    message: "transcript must supply either text or a path",
  });

export const briefScopeSchema = z
  .object({
    creator: z.string().min(1).optional(),
    series: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
  })
  .strict();

export const agentBriefSchema = z
  .object({
    format: z.literal("octupie-agent-brief/v1"),
    objective: z.string().min(1),
    audience: z.string().min(1),
    platform: z.string().min(1),
    creator: z.string().min(1).optional(),
    style: z.string().min(1).optional(),
    preset: z.string().min(1),
    desiredDurationSeconds: z.number().finite().positive().max(600),
    sourceClips: z.array(briefSourceClipSchema).default([]),
    transcript: briefTranscriptSchema.optional(),
    output: z.object({ fileName: safePath }).strict(),
    constraints: z.array(z.string().min(1)).default([]),
    hookVariants: z.number().int().min(0).max(10).optional(),
    scope: briefScopeSchema.optional(),
  })
  .strict();

export type AgentBrief = z.infer<typeof agentBriefSchema>;

export interface BriefParseResult {
  ok: boolean;
  brief?: AgentBrief;
  errors: string[];
}

export function parseAgentBrief(input: unknown): BriefParseResult {
  const result = agentBriefSchema.safeParse(input);
  if (result.success) {
    return { ok: true, brief: result.data, errors: [] };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, errors };
}
