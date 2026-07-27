/**
 * Prompt construction for the bounded planner/reviewer loop.
 *
 * The model receives only text: the sanitized brief, the transcript text, the
 * FFprobe-derived asset manifest, the active learned rules, and the edit-plan
 * schema plus rubric. It never receives raw media. Both roles are constrained
 * to return a single JSON object and nothing else; the loop validates that
 * object with the real schema, so the model can only ever propose data.
 */

import { z } from "zod";
import type { AgentBrief } from "./brief.js";

export interface RuleLike {
  id: string;
  text: string;
}

export interface Messages {
  system: string;
  prompt: string;
}

export const PLANNER_SYSTEM =
  "You are the planning layer of a deterministic video editor. You make editorial " +
  "decisions and express them ONLY as an edit-plan JSON object that validates against " +
  "the provided schema. You never output prose, code, or commands. You never reference " +
  "raw media bytes. Return exactly one JSON object and nothing else.";

export const CRITIQUE_SYSTEM =
  "You are an editorial reviewer. You judge a proposed edit plan against the brief and " +
  "the rubric and return ONLY a JSON object with your verdict. Return exactly one JSON " +
  "object and nothing else.";

export const RUBRIC = [
  "Rubric:",
  "- The hook lands in the first beat and matches the objective.",
  "- Captions are one to three words unless the preset explicitly extends them.",
  "- Cuts fall on phrase boundaries; real proof beats generic visuals.",
  "- B-roll must not cover the speaker when the preset forbids it.",
  "- SFX must have a stated editorial role; no default whoosh + riser + impact stack.",
  "- Duration, dimensions, and preset match the brief.",
].join("\n");

function rulesBlock(rules: RuleLike[]): string {
  if (rules.length === 0) return "Active learned rules: none.";
  return ["Active learned rules (human feedback, must be honored):", ...rules.map((r) => `- ${r.text}`)].join("\n");
}

function briefBlock(brief: AgentBrief): string {
  return [
    "Brief:",
    `- objective: ${brief.objective}`,
    `- audience: ${brief.audience}`,
    `- platform: ${brief.platform}`,
    brief.creator ? `- creator: ${brief.creator}` : "",
    brief.style ? `- style: ${brief.style}` : "",
    `- preset: ${brief.preset}`,
    `- desired duration: ${brief.desiredDurationSeconds}s`,
    `- output file: ${brief.output.fileName}`,
    brief.constraints.length ? `- constraints: ${brief.constraints.join("; ")}` : "",
    brief.hookVariants !== undefined ? `- hook variants requested: ${brief.hookVariants}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPlannerMessages(input: {
  brief: AgentBrief;
  manifestText: string;
  transcriptText?: string;
  rules: RuleLike[];
  schemaText: string;
  priorErrors?: string[];
}): Messages {
  const parts = [
    briefBlock(input.brief),
    "",
    input.manifestText ? input.manifestText : "Source clips: none declared.",
    "Media policy: use only media paths declared in the brief. Do not invent source clips, B-roll, dialogue, music, or SFX assets.",
    "",
    input.transcriptText ? `Transcript (text only):\n${input.transcriptText}` : "Transcript: none supplied.",
    "",
    rulesBlock(input.rules),
    "",
    "Edit-plan JSON Schema (the plan MUST validate against this):",
    input.schemaText,
    "",
    RUBRIC,
  ];

  if (input.priorErrors && input.priorErrors.length > 0) {
    parts.push(
      "",
      "Your previous plan was rejected by the validator. Repair these exact errors and return a corrected plan:",
      ...input.priorErrors.map((e) => `- ${e}`),
    );
  }

  parts.push("", "Return exactly one JSON edit-plan object and nothing else.");
  return { system: PLANNER_SYSTEM, prompt: parts.join("\n") };
}

export function buildCritiqueMessages(input: {
  brief: AgentBrief;
  plan: unknown;
  rules: RuleLike[];
}): Messages {
  const prompt = [
    briefBlock(input.brief),
    "",
    rulesBlock(input.rules),
    "",
    RUBRIC,
    "",
    "Proposed edit plan (JSON):",
    JSON.stringify(input.plan),
    "",
    'Return ONLY: {"approved": boolean, "issues": string[], "notes": string}. ',
    "Set approved to false if any rubric point or active rule is violated, listing each in issues.",
  ].join("\n");
  return { system: CRITIQUE_SYSTEM, prompt };
}

export const critiqueSchema = z
  .object({
    approved: z.boolean(),
    issues: z.array(z.string()).default([]),
    notes: z.string().optional(),
  })
  .strip();

export type Critique = z.infer<typeof critiqueSchema>;

export interface CritiqueParseResult {
  ok: boolean;
  critique?: Critique;
  errors: string[];
}

export function parseCritique(input: unknown): CritiqueParseResult {
  const result = critiqueSchema.safeParse(input);
  if (result.success) {
    return { ok: true, critique: result.data, errors: [] };
  }
  return { ok: false, errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}
