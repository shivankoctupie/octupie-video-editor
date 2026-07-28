/**
 * Restricted Claude Code critique adapter (parity phase 3).
 *
 * This is the only path that hands rendered-master frames to a model for a
 * multimodal critique. It is modeled directly on the phase-2B vision adapter and
 * enforces the same restrictions here, not by convention:
 *
 *   - tools are restricted to Read only (no Bash, Edit, Write, MCP, browser);
 *   - session persistence is disabled and the strict MCP config is empty;
 *   - output is JSON and the model is handed the exact JSON Schema it must satisfy;
 *   - exactly one directory (the frame directory) is granted via `--add-dir`;
 *   - the prompt is delivered on stdin, never on argv;
 *   - frame count, per-frame bytes, prompt bytes, output bytes, and runtime are
 *     all capped, and every frame path is proven (canonical containment plus a
 *     JPEG signature) to live inside the frame directory before any spawn.
 *
 * The model reads the sampled frames of the actually-rendered master and returns
 * DATA ONLY. The engine stamps identity, the master reference, and the
 * FFprobe-authoritative duration, validates every result, and never treats the
 * reply as anything but a proposal a human still reviews.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { execProcess, type ExecFn } from "../agent/exec.js";
import { redactSecrets, truncate } from "../agent/redact.js";
import { claudeBinary, parseClaudeOutput } from "../agent/providers/claude.js";
import { isContainedPath } from "../util/paths.js";
import type { AssetRefValue } from "../analysis/schemas.js";
import type { EditPlan } from "../schema/editPlan.js";
import type { SampledMasterFrame } from "./sampleMaster.js";
import {
  DRAFT_CRITIQUE_FORMAT,
  modelCritiqueSchema,
  parseDraftCritique,
  parseModelCritique,
  type DraftCritiqueValue,
} from "./schemas.js";

export const CLAUDE_CRITIQUE_MODEL_LABEL = "claude-code-critique";

/** Tolerance (seconds) for matching a cited evidence-frame time to a supplied one. */
const EVIDENCE_TOLERANCE = 0.25;

export interface ClaudeCritiqueConfig {
  binary: string;
  timeoutMs: number;
  maxFrames: number;
  maxFrameBytes: number;
  maxPromptBytes: number;
  maxOutputBytes: number;
}

const DEFAULTS: Omit<ClaudeCritiqueConfig, "binary"> = {
  timeoutMs: 5 * 60_000,
  maxFrames: 24,
  maxFrameBytes: 2 * 1024 * 1024,
  maxPromptBytes: 256 * 1024,
  maxOutputBytes: 1024 * 1024,
};

export function resolveClaudeCritiqueConfig(overrides: Partial<ClaudeCritiqueConfig> = {}): ClaudeCritiqueConfig {
  return {
    binary: overrides.binary ?? claudeBinary(),
    timeoutMs: overrides.timeoutMs ?? DEFAULTS.timeoutMs,
    maxFrames: overrides.maxFrames ?? DEFAULTS.maxFrames,
    maxFrameBytes: overrides.maxFrameBytes ?? DEFAULTS.maxFrameBytes,
    maxPromptBytes: overrides.maxPromptBytes ?? DEFAULTS.maxPromptBytes,
    maxOutputBytes: overrides.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
  };
}

/**
 * Argument array for a single restricted, noninteractive, JSON-output critique
 * call. Read-only tools, no session persistence, and exactly one granted directory.
 */
export function buildClaudeCritiqueArgs(system: string, frameDir: string): string[] {
  const schema = JSON.stringify(zodToJsonSchema(modelCritiqueSchema, { $refStrategy: "none" }));
  return [
    "-p",
    "--safe-mode",
    "--output-format",
    "json",
    "--json-schema",
    schema,
    "--tools",
    "Read",
    "--allowedTools",
    "Read",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-session-persistence",
    "--add-dir",
    frameDir,
    "--system-prompt",
    system,
  ];
}

const SYSTEM_INSTRUCTIONS = [
  "You are a restricted rendered-draft reviewer for a deterministic video editing engine.",
  "You may use the Read tool ONLY, and only on the frame directory granted to you.",
  "Read the sampled frames of the ACTUALLY RENDERED master and judge the finished draft,",
  "not the plan: pacing, caption timing and legibility, audio, continuity, framing, and branding.",
  "Anchor each note to a source time; where a defect is visible, cite exactly one sampled frame by filename.",
  "Mark a note 'blocker' only for a real defect that must be fixed before delivery.",
  "Suggested plan changes are advisory DATA the engine may or may not use; never assume they are applied.",
  "Return DATA ONLY as a single JSON object matching the provided JSON Schema.",
  "Do not include prose, code fences, or any text outside the JSON object.",
  "State honest limitations. Never claim certainty you do not have.",
].join(" ");

/** Compact, one-line-per-scene description of the plan under review. */
function sceneLines(plan: EditPlan): string {
  return plan.scenes
    .map((s) => `${s.id} (${s.type}) [${s.start}-${s.end}s] ${s.heading ?? s.body ?? ""}`.trim())
    .join("\n");
}

/** Assemble the stdin prompt: plan intent, master facts, the frame list, and the schema. */
export function buildCritiquePrompt(
  plan: EditPlan,
  master: AssetRefValue,
  durationSeconds: number,
  frames: SampledMasterFrame[],
): string {
  const schema = zodToJsonSchema(modelCritiqueSchema, { $refStrategy: "none" });
  const frameList = frames.map((f) => `${basename(f.absPath)} @ ${f.atSeconds.toFixed(2)}s`).join("\n");
  return [
    SYSTEM_INSTRUCTIONS,
    ``,
    `Title: ${plan.title}`,
    `Preset: ${plan.preset}  Composition: ${plan.composition}`,
    `Master file: ${master.path}`,
    `Master duration: ${durationSeconds.toFixed(3)}s  Canvas: ${plan.width}x${plan.height} @ ${plan.fps}fps`,
    ``,
    `Planned scenes:`,
    sceneLines(plan) || "(none)",
    ``,
    `Sampled frames of the rendered master available to Read (filename @ source time):`,
    frameList || "(none)",
    ``,
    `Reference every evidence frame by its filename exactly as listed above.`,
    `Return one JSON object conforming to this JSON Schema:`,
    JSON.stringify(schema),
  ].join("\n");
}

export interface CritiqueInput {
  /** The exact plan that produced the master under review. */
  plan: EditPlan;
  /** Portable relative reference to the rendered master. */
  master: AssetRefValue;
  /** FFprobe-authoritative duration of the real master. */
  durationSeconds: number;
  /** Sampled frames of the rendered master, each contained under `frameDir`. */
  frames: SampledMasterFrame[];
  /** Absolute directory granted to the Read tool. Every frame must live here. */
  frameDir: string;
  config?: Partial<ClaudeCritiqueConfig>;
  runner?: ExecFn;
  statFile?: (p: string) => { size: number; isFile: boolean };
  realpathFile?: (p: string) => string;
  readFramePrefix?: (p: string) => Uint8Array;
  now?: Date;
}

function defaultStat(p: string): { size: number; isFile: boolean } {
  const s = statSync(p);
  return { size: s.size, isFile: s.isFile() };
}

function defaultReadFramePrefix(p: string): Uint8Array {
  return readFileSync(p).subarray(0, 3);
}

function isJpegPrefix(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Run one restricted critique of a rendered master and return validated critique
 * DATA. Throws on any cap violation, path escape, spawn/timeout/truncation
 * failure, or schema-invalid or evidence-inconsistent model output. Nothing is
 * written here; the caller persists a result only after this resolves.
 */
export async function critiqueWithClaude(input: CritiqueInput): Promise<DraftCritiqueValue> {
  const cfg = resolveClaudeCritiqueConfig(input.config ?? {});
  const runner = input.runner ?? execProcess;
  const stat = input.statFile ?? defaultStat;
  const realpath = input.realpathFile ?? realpathSync;
  const readPrefix = input.readFramePrefix ?? defaultReadFramePrefix;
  const now = input.now ?? new Date();

  // --- Pre-spawn safety: caps and path containment, before any process starts. ---
  if (input.frames.length === 0) {
    throw new Error("No sampled frames to critique; sample the rendered master first.");
  }
  if (input.frames.length > cfg.maxFrames) {
    throw new Error(`Frame count ${input.frames.length} exceeds the cap of ${cfg.maxFrames}.`);
  }
  const realFrameDir = realpath(input.frameDir);
  for (const f of input.frames) {
    if (!isContainedPath(f.absPath, input.frameDir)) {
      throw new Error(`Frame path escapes the granted frame directory: ${JSON.stringify(f.absPath)}`);
    }
    const realFrame = realpath(f.absPath);
    if (!isContainedPath(realFrame, realFrameDir)) {
      throw new Error(`Frame real path escapes the granted frame directory: ${JSON.stringify(f.absPath)}`);
    }
    const s = stat(realFrame);
    if (!s.isFile) throw new Error(`Frame is not a file: ${JSON.stringify(f.absPath)}`);
    if (s.size > cfg.maxFrameBytes) {
      throw new Error(`Frame ${basename(f.absPath)} is ${s.size} bytes, over the ${cfg.maxFrameBytes}-byte cap.`);
    }
    if (!isJpegPrefix(readPrefix(realFrame))) {
      throw new Error(`Frame ${basename(f.absPath)} is not a JPEG image.`);
    }
  }

  const prompt = buildCritiquePrompt(input.plan, input.master, input.durationSeconds, input.frames);
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > cfg.maxPromptBytes) {
    throw new Error(`Critique prompt is ${promptBytes} bytes, over the ${cfg.maxPromptBytes}-byte cap.`);
  }

  const args = buildClaudeCritiqueArgs(SYSTEM_INSTRUCTIONS, realFrameDir);
  const res = await runner(cfg.binary, args, {
    input: prompt,
    cwd: realFrameDir,
    timeoutMs: cfg.timeoutMs,
    maxBuffer: cfg.maxOutputBytes,
  });

  if (res.spawnError) throw new Error(`Could not start the critique provider ('${cfg.binary}'): ${res.spawnError}`);
  if (res.timedOut) throw new Error(`Critique timed out after ${cfg.timeoutMs}ms.`);
  if (res.truncated) throw new Error(`Critique output exceeded the ${cfg.maxOutputBytes}-byte limit and was rejected.`);
  if (res.code !== 0) {
    const diagnostic = truncate(redactSecrets((res.stderr.trim() || res.stdout.trim()) || "no diagnostic output"), 400);
    throw new Error(`Critique provider exited ${res.code}: ${diagnostic}`);
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
    if (!envelope.ok) throw new Error(`Critique provider returned an error: ${envelope.error ?? "unknown"}`);
    try {
      modelJson = JSON.parse(envelope.text.trim());
    } catch (err) {
      throw new Error(`Critique provider did not return a JSON object: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const model = parseModelCritique(modelJson);
  if (!model.ok || !model.data) {
    throw new Error(`Critique output failed validation: ${model.errors.join("; ")}`);
  }

  const suppliedFrames = new Map(input.frames.map((f) => [basename(f.absPath), f.atSeconds]));
  for (const note of model.data.notes) {
    if (!note.evidenceFrame) continue;
    const suppliedAt = suppliedFrames.get(note.evidenceFrame.path);
    if (suppliedAt === undefined) {
      throw new Error(`Evidence frame '${note.evidenceFrame.path}' was not supplied to the critique provider.`);
    }
    if (Math.abs(suppliedAt - note.evidenceFrame.atSeconds) > EVIDENCE_TOLERANCE) {
      throw new Error(
        `Evidence frame '${note.evidenceFrame.path}' time ${note.evidenceFrame.atSeconds}s does not match supplied time ${suppliedAt}s.`,
      );
    }
  }

  // The engine, not the model, stamps identity, master, duration, and time.
  const candidate = {
    format: DRAFT_CRITIQUE_FORMAT,
    master: input.master,
    durationSeconds: input.durationSeconds,
    generatedAt: now.toISOString(),
    provider: { id: "claude-cli", model: CLAUDE_CRITIQUE_MODEL_LABEL },
    approved: model.data.approved,
    notes: model.data.notes,
    summary: model.data.summary,
    limitations: model.data.limitations,
  };

  const parsed = parseDraftCritique(candidate);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`Assembled critique failed validation: ${parsed.errors.join("; ")}`);
  }
  return parsed.data;
}

/** Provider-neutral interface: any backend that returns validated critique data. */
export interface DraftReviewProvider {
  id: string;
  critique(input: CritiqueInput): Promise<DraftCritiqueValue>;
}

export interface ClaudeCritiqueProviderOptions {
  runner?: ExecFn;
  config?: Partial<ClaudeCritiqueConfig>;
}

/** Build the restricted Claude Code critique provider. */
export function createClaudeCritiqueProvider(opts: ClaudeCritiqueProviderOptions = {}): DraftReviewProvider {
  return {
    id: "claude-cli",
    critique(input: CritiqueInput): Promise<DraftCritiqueValue> {
      return critiqueWithClaude({
        ...input,
        ...(opts.runner ? { runner: opts.runner } : {}),
        config: { ...opts.config, ...input.config },
      });
    },
  };
}
