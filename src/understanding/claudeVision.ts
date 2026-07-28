/**
 * Restricted Claude Code vision adapter (parity phase 2B, scope A).
 *
 * This is the ONLY multimodal path in the engine. It consumes an already
 * validated source-analysis artifact plus its sampled frame files, and invokes
 * the standalone `claude` executable through the existing argument-array,
 * shell:false, bounded runner. The restriction is deliberate and enforced here,
 * not by convention:
 *
 *   - tools are restricted to Read only (no Bash, Edit, Write, MCP, browser);
 *   - session persistence is disabled;
 *   - output is JSON, and the model is handed a JSON Schema it must satisfy;
 *   - exactly one directory (the frame directory) is granted with the official
 *     `--add-dir` flag, and nothing else is reachable;
 *   - the prompt is delivered on stdin, never on argv;
 *   - frame count, per-frame bytes, prompt bytes, output bytes, and runtime are
 *     all capped, and every frame path is proven to live inside the frame
 *     directory before the process is ever spawned.
 *
 * The model reads real image frames and combines them with the timed transcript;
 * it returns DATA. The engine validates every result before anything is written,
 * and never treats a local OpenCV metric as semantic understanding.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { execProcess, type ExecFn } from "../agent/exec.js";
import { redactSecrets, truncate } from "../agent/redact.js";
import { claudeBinary, parseClaudeOutput } from "../agent/providers/claude.js";
import { isContainedPath } from "../util/paths.js";
import type { SourceAnalysisValue } from "../analysis/schemas.js";
import {
  modelUnderstandingSchema,
  parseModelUnderstanding,
  parseSemanticUnderstanding,
  SEMANTIC_UNDERSTANDING_FORMAT,
  type SemanticUnderstandingValue,
} from "./schemas.js";

export const CLAUDE_VISION_MODEL_LABEL = "claude-code-vision";

export interface ClaudeVisionConfig {
  binary: string;
  timeoutMs: number;
  /** Maximum number of frames handed to the model. */
  maxFrames: number;
  /** Maximum bytes for any single frame image. */
  maxFrameBytes: number;
  /** Maximum bytes for the assembled stdin prompt. */
  maxPromptBytes: number;
  /** Maximum bytes of model output retained (runner maxBuffer). */
  maxOutputBytes: number;
}

const DEFAULTS: Omit<ClaudeVisionConfig, "binary"> = {
  timeoutMs: 5 * 60_000,
  maxFrames: 24,
  maxFrameBytes: 2 * 1024 * 1024,
  maxPromptBytes: 256 * 1024,
  maxOutputBytes: 1024 * 1024,
};

export function resolveClaudeVisionConfig(overrides: Partial<ClaudeVisionConfig> = {}): ClaudeVisionConfig {
  return {
    binary: overrides.binary ?? claudeBinary(),
    timeoutMs: overrides.timeoutMs ?? DEFAULTS.timeoutMs,
    maxFrames: overrides.maxFrames ?? DEFAULTS.maxFrames,
    maxFrameBytes: overrides.maxFrameBytes ?? DEFAULTS.maxFrameBytes,
    maxPromptBytes: overrides.maxPromptBytes ?? DEFAULTS.maxPromptBytes,
    maxOutputBytes: overrides.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
  };
}

/** One sampled frame available to the model: its on-disk file and source time. */
export interface FrameFile {
  /** Absolute path to the extracted frame image. Must live under `frameDir`. */
  absPath: string;
  atSeconds: number;
}

/**
 * Argument array for a single restricted, noninteractive, JSON-output vision call.
 * Read-only tools, no session persistence, and exactly one granted directory.
 */
export function buildClaudeVisionArgs(system: string, frameDir: string): string[] {
  const schema = JSON.stringify(zodToJsonSchema(modelUnderstandingSchema, { $refStrategy: "none" }));
  return [
    "-p",
    "--safe-mode",
    "--output-format",
    "json",
    "--json-schema",
    schema,
    // Restrict the built-in tool set itself, then auto-allow only Read.
    "--tools",
    "Read",
    "--allowedTools",
    "Read",
    "--permission-mode",
    "dontAsk",
    // Load no configured MCP servers.
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-session-persistence",
    // Grant exactly the frame directory, nothing else, via the official flag.
    "--add-dir",
    frameDir,
    "--system-prompt",
    system,
  ];
}

const SYSTEM_INSTRUCTIONS = [
  "You are a restricted video-footage interpreter for a deterministic editing engine.",
  "You may use the Read tool ONLY, and only on the frame directory granted to you.",
  "Read the sampled frame images and combine them with the timed transcript provided.",
  "Return semantic findings a human editor can act on: facial-expression, crew-prompt,",
  "weak-take, product-proof, visual-glitch, broll-relevance, and hook-moment.",
  "Ground every finding in at least one frame you actually read; cite it by filename.",
  "Return DATA ONLY as a single JSON object matching the provided JSON Schema.",
  "Do not include prose, code fences, or any text outside the JSON object.",
  "State honest limitations. Never claim certainty you do not have.",
].join(" ");

/** Compact, timed transcript lines for the prompt. */
function transcriptLines(analysis: SourceAnalysisValue): string {
  return analysis.transcript.words
    .map((w) => `[${w.startSeconds.toFixed(2)}-${w.endSeconds.toFixed(2)}] ${w.text}`)
    .join("\n");
}

/** Assemble the stdin prompt: transcript, existing marks, the frame list, and the schema. */
export function buildVisionPrompt(analysis: SourceAnalysisValue, frames: FrameFile[]): string {
  const schema = zodToJsonSchema(modelUnderstandingSchema, { $refStrategy: "none" });
  const frameList = frames.map((f) => `${basename(f.absPath)} @ ${f.atSeconds.toFixed(2)}s`).join("\n");
  const marks = analysis.marks
    .map((m) => `${m.kind} [${m.startSeconds.toFixed(2)}-${m.endSeconds.toFixed(2)}] ${m.reason}`)
    .join("\n");
  const hooks = analysis.candidateHooks
    .map((h) => `[${h.startSeconds.toFixed(2)}-${h.endSeconds.toFixed(2)}] score=${h.score.toFixed(2)} ${h.text}`)
    .join("\n");
  return [
    SYSTEM_INSTRUCTIONS,
    ``,
    `Clip: ${analysis.clip.path}`,
    `Duration: ${analysis.durationSeconds.toFixed(3)}s`,
    `Language: ${analysis.transcript.language}`,
    ``,
    `Timed transcript:`,
    transcriptLines(analysis) || "(no words)",
    ``,
    `Local deterministic marks (heuristics, not ground truth):`,
    marks || "(none)",
    ``,
    `Heuristic candidate hooks:`,
    hooks || "(none)",
    ``,
    `Sampled frames available to Read (filename @ source time):`,
    frameList || "(none)",
    ``,
    `Reference every evidence frame by its filename exactly as listed above.`,
    `Return one JSON object conforming to this JSON Schema:`,
    JSON.stringify(schema),
  ].join("\n");
}

export interface ClaudeVisionInput {
  /** Already validated source-analysis artifact. */
  analysis: SourceAnalysisValue;
  /** Sampled frame files, each contained under `frameDir`. */
  frames: FrameFile[];
  /** Absolute directory granted to the Read tool. Every frame must live here. */
  frameDir: string;
  config?: Partial<ClaudeVisionConfig>;
  runner?: ExecFn;
  /** Injected file stat for offline tests. Defaults to fs.statSync. */
  statFile?: (p: string) => { size: number; isFile: boolean };
  /** Injected canonical-path resolver for symlink-safe tests. Defaults to fs.realpathSync. */
  realpathFile?: (p: string) => string;
  /** Injected header reader for image-signature tests. Defaults to the first three bytes on disk. */
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
 * Run one restricted vision interpretation and return a validated artifact.
 * Throws on any cap violation, path escape, spawn/timeout/truncation failure, or
 * schema-invalid model output. Nothing is written here; the caller persists a
 * result only after this resolves.
 */
export async function understandWithClaudeVision(input: ClaudeVisionInput): Promise<SemanticUnderstandingValue> {
  const cfg = resolveClaudeVisionConfig(input.config ?? {});
  const runner = input.runner ?? execProcess;
  const stat = input.statFile ?? defaultStat;
  const realpath = input.realpathFile ?? realpathSync;
  const readPrefix = input.readFramePrefix ?? defaultReadFramePrefix;
  const now = input.now ?? new Date();

  // --- Pre-spawn safety: caps and path containment, before any process starts. ---
  if (input.frames.length === 0) {
    throw new Error("No sampled frames to interpret; run analysis with --frames first.");
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

  const prompt = buildVisionPrompt(input.analysis, input.frames);
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > cfg.maxPromptBytes) {
    throw new Error(`Vision prompt is ${promptBytes} bytes, over the ${cfg.maxPromptBytes}-byte cap.`);
  }

  const args = buildClaudeVisionArgs(SYSTEM_INSTRUCTIONS, realFrameDir);
  const res = await runner(cfg.binary, args, {
    input: prompt,
    cwd: realFrameDir,
    timeoutMs: cfg.timeoutMs,
    maxBuffer: cfg.maxOutputBytes,
  });

  if (res.spawnError) throw new Error(`Could not start the vision provider ('${cfg.binary}'): ${res.spawnError}`);
  if (res.timedOut) throw new Error(`Vision interpretation timed out after ${cfg.timeoutMs}ms.`);
  if (res.truncated) throw new Error(`Vision output exceeded the ${cfg.maxOutputBytes}-byte limit and was rejected.`);
  if (res.code !== 0) {
    const diagnostic = truncate(redactSecrets((res.stderr.trim() || res.stdout.trim()) || "no diagnostic output"), 400);
    throw new Error(`Vision provider exited ${res.code}: ${diagnostic}`);
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
    if (!envelope.ok) throw new Error(`Vision provider returned an error: ${envelope.error ?? "unknown"}`);
    try {
      modelJson = JSON.parse(envelope.text.trim());
    } catch (err) {
      throw new Error(`Vision provider did not return a JSON object: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const model = parseModelUnderstanding(modelJson);
  if (!model.ok || !model.data) {
    throw new Error(`Vision output failed validation: ${model.errors.join("; ")}`);
  }

  const suppliedFrames = new Map(input.frames.map((f) => [basename(f.absPath), f.atSeconds]));
  for (const finding of model.data.findings) {
    for (const evidence of finding.evidenceFrames) {
      const suppliedAt = suppliedFrames.get(evidence.path);
      if (suppliedAt === undefined) {
        throw new Error(`Evidence frame '${evidence.path}' was not supplied to the vision provider.`);
      }
      if (Math.abs(suppliedAt - evidence.atSeconds) > 0.25) {
        throw new Error(
          `Evidence frame '${evidence.path}' timestamp ${evidence.atSeconds}s does not match supplied time ${suppliedAt}s.`,
        );
      }
    }
  }

  // The engine, not the model, stamps identity, clip, duration, and time.
  const candidate = {
    format: SEMANTIC_UNDERSTANDING_FORMAT,
    clip: input.analysis.clip,
    durationSeconds: input.analysis.durationSeconds,
    generatedAt: now.toISOString(),
    provider: { id: "claude-cli", model: CLAUDE_VISION_MODEL_LABEL },
    findings: model.data.findings,
    segments: model.data.segments,
    summary: model.data.summary,
    limitations: model.data.limitations,
  };

  const parsed = parseSemanticUnderstanding(candidate);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`Assembled semantic understanding failed validation: ${parsed.errors.join("; ")}`);
  }
  return parsed.data;
}

/** Provider-neutral interface: any backend that returns validated understanding data. */
export interface VideoUnderstandingProvider {
  id: string;
  understand(input: ClaudeVisionInput): Promise<SemanticUnderstandingValue>;
}

export interface ClaudeVisionProviderOptions {
  runner?: ExecFn;
  config?: Partial<ClaudeVisionConfig>;
}

/** Build the restricted Claude Code vision provider. */
export function createClaudeVisionProvider(opts: ClaudeVisionProviderOptions = {}): VideoUnderstandingProvider {
  return {
    id: "claude-cli",
    understand(input: ClaudeVisionInput): Promise<SemanticUnderstandingValue> {
      return understandWithClaudeVision({
        ...input,
        ...(opts.runner ? { runner: opts.runner } : {}),
        config: { ...opts.config, ...input.config },
      });
    },
  };
}
