/**
 * Restricted Claude Code hook-variant text provider (parity phase 5).
 *
 * This is the only path that asks a model to draft hook variants. It is
 * text-only: no frames, no media bytes, so it needs `network` (checked by the
 * orchestrator before this is ever reached) and never `media-upload`. The
 * restriction is enforced here, not by convention:
 *
 *   - no tools are granted (no Read, Bash, Edit, Write, MCP, browser) and no
 *     directory is added, because the task needs no file access;
 *   - session persistence is disabled and the strict MCP config is empty;
 *   - output is JSON and the model is handed the exact JSON Schema it must satisfy;
 *   - the prompt is delivered on stdin, never on argv, through the existing
 *     argument-array, shell:false, bounded runner;
 *   - prompt bytes, output bytes, and runtime are all capped.
 *
 * The model returns interpretation DATA only (strategy, style, hook text,
 * rationale, confidence, and a plan carrier). It carries no identity: the engine
 * stamps ids, timestamp, source-plan hash, count, and provider, and re-validates
 * everything. Count enforcement, duplicate rejection, edit-plan validation, and
 * the invented-media check all happen in the engine assembly that consumes this.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { execProcess, type ExecFn } from "../agent/exec.js";
import { redactSecrets, truncate } from "../agent/redact.js";
import { claudeBinary, parseClaudeOutput } from "../agent/providers/claude.js";
import type { EditPlan } from "../schema/editPlan.js";
import {
  HOOK_STRATEGIES,
  modelHookVariantSetSchema,
  parseModelHookVariantSet,
  selectHookSceneId,
  type HookVariantRequestValue,
  type ModelHookVariantValue,
} from "./schemas.js";

export const CLAUDE_HOOK_MODEL_LABEL = "claude-code-hooks";

export interface ClaudeHookConfig {
  binary: string;
  timeoutMs: number;
  maxPromptBytes: number;
  maxOutputBytes: number;
}

const DEFAULTS: Omit<ClaudeHookConfig, "binary"> = {
  timeoutMs: 5 * 60_000,
  maxPromptBytes: 256 * 1024,
  maxOutputBytes: 1024 * 1024,
};

export function resolveClaudeHookConfig(overrides: Partial<ClaudeHookConfig> = {}): ClaudeHookConfig {
  return {
    binary: overrides.binary ?? claudeBinary(),
    timeoutMs: overrides.timeoutMs ?? DEFAULTS.timeoutMs,
    maxPromptBytes: overrides.maxPromptBytes ?? DEFAULTS.maxPromptBytes,
    maxOutputBytes: overrides.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
  };
}

const SYSTEM_INSTRUCTIONS = [
  "You are a restricted hook-variant writer for a deterministic video editing engine.",
  "You may use NO tools. You have no file, shell, or network access of your own.",
  "Given an objective and a source edit plan, propose exactly the requested number of DISTINCT opening variants.",
  "Change ONLY the opening: the hook scene's heading/body/emphasis/frameZero and its overlapping caption.",
  "Never add, remove, or re-time scenes; never add source clips, b-roll, or audio; never invent media or ranges.",
  "Prefer returning a strictly typed fragment for the opening scene (kind:'fragment'); a complete plan is also accepted.",
  "Each variant must use a different strategy from the allowed list and a distinct hook text.",
  "Return DATA ONLY as a single JSON object matching the provided JSON Schema.",
  "Do not include prose, code fences, or any text outside the JSON object.",
].join(" ");

/** Argument array for a single restricted, noninteractive, JSON-output text call. */
export function buildClaudeHookArgs(system: string): string[] {
  const schema = JSON.stringify(zodToJsonSchema(modelHookVariantSetSchema, { $refStrategy: "none" }));
  return [
    "-p",
    "--safe-mode",
    "--output-format",
    "json",
    "--json-schema",
    schema,
    // Grant no tools at all; the task is pure text generation.
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    // Load no configured MCP servers.
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-session-persistence",
    "--system-prompt",
    system,
  ];
}

/** Compact, one-line-per-scene description of the source plan. */
function sceneLines(plan: EditPlan): string {
  return plan.scenes
    .map((s) => `${s.id} (${s.type}) [${s.start}-${s.end}s] ${s.heading ?? s.body ?? ""}`.trim())
    .join("\n");
}

/** Assemble the stdin prompt: objective, count, the opening scene id, the plan, and the schema. */
export function buildHookPrompt(request: HookVariantRequestValue): string {
  const plan = request.sourcePlan;
  const schema = zodToJsonSchema(modelHookVariantSetSchema, { $refStrategy: "none" });
  const hookSceneId = selectHookSceneId(plan);
  const transcript = request.transcriptText ? truncate(request.transcriptText, 8000) : "(none)";
  return [
    SYSTEM_INSTRUCTIONS,
    ``,
    `Objective: ${request.objective}`,
    `Variants requested (return EXACTLY this many): ${request.count}`,
    `Allowed strategies (use a different one per variant): ${HOOK_STRATEGIES.join(", ")}`,
    request.style?.maxWords !== undefined ? `Max words per hook: ${request.style.maxWords}` : "",
    request.style?.tone ? `Tone: ${request.style.tone}` : "",
    request.style?.allowBodyChanges ? "Body changes are permitted for this request." : "Change only the opening.",
    ``,
    `Source plan title: ${plan.title}  Preset: ${plan.preset}  Composition: ${plan.composition}`,
    `Opening scene id to change: ${hookSceneId}`,
    `Scenes:`,
    sceneLines(plan) || "(none)",
    ``,
    `Transcript (advisory, do not invent from it):`,
    transcript,
    ``,
    `Return one JSON object conforming to this JSON Schema:`,
    JSON.stringify(schema),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export interface HookProviderInput {
  request: HookVariantRequestValue;
  now?: Date;
}

/** Provider-neutral interface: any backend that returns validated interpretation variants. */
export interface HookTextProvider {
  id: string;
  produce(input: HookProviderInput): Promise<ModelHookVariantValue[]>;
}

export interface ClaudeHookInput extends HookProviderInput {
  config?: Partial<ClaudeHookConfig>;
  runner?: ExecFn;
}

/**
 * Run one restricted hook-variant draft and return validated interpretation
 * variants. Throws on any cap violation, spawn/timeout/truncation failure, or
 * schema-invalid output. Nothing is written here; the engine assembles identity,
 * enforces the exact count, rejects duplicates and invalid or invented-media
 * plans, and only then may a caller persist a result.
 */
export async function produceHookVariantsWithClaude(input: ClaudeHookInput): Promise<ModelHookVariantValue[]> {
  const cfg = resolveClaudeHookConfig(input.config ?? {});
  const runner = input.runner ?? execProcess;

  const prompt = buildHookPrompt(input.request);
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > cfg.maxPromptBytes) {
    throw new Error(`Hook prompt is ${promptBytes} bytes, over the ${cfg.maxPromptBytes}-byte cap.`);
  }

  const args = buildClaudeHookArgs(SYSTEM_INSTRUCTIONS);
  const res = await runner(cfg.binary, args, {
    input: prompt,
    timeoutMs: cfg.timeoutMs,
    maxBuffer: cfg.maxOutputBytes,
  });

  if (res.spawnError) throw new Error(`Could not start the hook provider ('${cfg.binary}'): ${res.spawnError}`);
  if (res.timedOut) throw new Error(`Hook generation timed out after ${cfg.timeoutMs}ms.`);
  if (res.truncated) throw new Error(`Hook output exceeded the ${cfg.maxOutputBytes}-byte limit and was rejected.`);
  if (res.code !== 0) {
    const diagnostic = truncate(redactSecrets((res.stderr.trim() || res.stdout.trim()) || "no diagnostic output"), 400);
    throw new Error(`Hook provider exited ${res.code}: ${diagnostic}`);
  }

  let modelJson: unknown;
  try {
    const rawEnvelope = JSON.parse(res.stdout) as { structured_output?: unknown };
    if (rawEnvelope && typeof rawEnvelope === "object" && rawEnvelope.structured_output !== undefined) {
      modelJson = rawEnvelope.structured_output;
    }
  } catch {
    // Fall through to the legacy result-text envelope parser below.
  }
  if (modelJson === undefined) {
    const envelope = parseClaudeOutput(res.stdout);
    if (!envelope.ok) throw new Error(`Hook provider returned an error: ${envelope.error ?? "unknown"}`);
    try {
      modelJson = JSON.parse(envelope.text.trim());
    } catch (err) {
      throw new Error(`Hook provider did not return a JSON object: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const parsed = parseModelHookVariantSet(modelJson);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`Hook output failed validation: ${parsed.errors.join("; ")}`);
  }
  return parsed.data.variants;
}

export interface ClaudeHookProviderOptions {
  runner?: ExecFn;
  config?: Partial<ClaudeHookConfig>;
}

/** Build the restricted Claude Code hook-variant provider. */
export function createClaudeHookProvider(opts: ClaudeHookProviderOptions = {}): HookTextProvider {
  return {
    id: "claude-cli",
    produce(input: HookProviderInput): Promise<ModelHookVariantValue[]> {
      return produceHookVariantsWithClaude({
        ...input,
        ...(opts.runner ? { runner: opts.runner } : {}),
        ...(opts.config ? { config: opts.config } : {}),
      });
    },
  };
}
