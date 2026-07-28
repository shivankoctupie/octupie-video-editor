/**
 * Multimodal source-understanding orchestrator (parity phase 2B, scope A).
 *
 * Ties containment, artifact loading, frame gathering, the restricted vision
 * provider, and validated writing into one flow:
 *   1. resolve the input analysis file and confirm it lives under the project
 *      output root (or a separately configured analysis root). No arbitrary file
 *      reads: a path outside the root is refused before anything is read.
 *   2. load and re-validate the source-analysis artifact.
 *   3. gather the sampled frame files from the analysis's `frames/` directory,
 *      each confirmed contained under the root, and pair each with its source
 *      time from the artifact.
 *   4. hand the artifact and frames to the restricted provider, which returns
 *      validated semantic understanding data only.
 *   5. write the validated result under the same root; the output never escapes.
 *
 * Every heavy step is injectable so the whole flow runs offline in tests without
 * ever spawning `claude`.
 */

import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertContainedPath } from "../util/paths.js";
import { createPolicy, requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import { parseSourceAnalysis, type SourceAnalysisValue } from "../analysis/schemas.js";
import {
  createClaudeVisionProvider,
  type ClaudeVisionInput,
  type FrameFile,
  type VideoUnderstandingProvider,
} from "./claudeVision.js";
import { type SemanticUnderstandingValue } from "./schemas.js";

/** Supported provider ids for `agent understand`. */
export const UNDERSTAND_PROVIDERS = ["claude"] as const;
export type UnderstandProviderId = (typeof UNDERSTAND_PROVIDERS)[number];

export function isUnderstandProviderId(id: string): id is UnderstandProviderId {
  return (UNDERSTAND_PROVIDERS as readonly string[]).includes(id);
}

const FRAME_FILE = /^frame_\d{5}\.jpg$/i;

/**
 * The root every read and write must stay under. Defaults to `<cwd>/output`;
 * override with `OVE_ANALYSIS_ROOT` to point at a separately configured analysis
 * root. This is the containment boundary for the whole command.
 */
export function analysisRoot(): string {
  const dir = process.env.OVE_ANALYSIS_ROOT?.trim() || "output";
  return resolve(process.cwd(), dir);
}

export interface UnderstandSourceInput {
  /** Path to the analysis.json artifact (relative to cwd or absolute). */
  analysisPath: string;
  providerId: UnderstandProviderId;
  /** Explicit grants for outbound model access and sending sampled frame bytes. Default deny. */
  permissionPolicy?: PermissionPolicy;
  /** Output file. Defaults to `understanding.json` beside the analysis file. */
  outFile?: string;
  now?: Date;

  // Injectable steps (real defaults below).
  root?: string;
  readAnalysis?: (absPath: string) => string;
  listFrames?: (frameDir: string) => string[];
  /** Canonical path resolver used to defeat symlink escapes. */
  realpathPath?: (path: string) => string;
  writeFile?: (path: string, data: string) => void;
  ensureDir?: (dir: string) => void;
  /** Provider factory override (tests). Defaults to the restricted Claude vision provider. */
  provider?: (id: UnderstandProviderId) => VideoUnderstandingProvider;
  /** Runner passed to the default provider (tests inject a fake `claude`). */
  runner?: ClaudeVisionInput["runner"];
  /** Stat override passed to the default provider (tests). */
  statFile?: ClaudeVisionInput["statFile"];
  config?: ClaudeVisionInput["config"];
}

export interface UnderstandSourceResult {
  understandingPath: string;
  frameDir: string;
  frameCount: number;
  understanding: SemanticUnderstandingValue;
}

function defaultProvider(
  _id: UnderstandProviderId,
  runner: UnderstandSourceInput["runner"],
): VideoUnderstandingProvider {
  return createClaudeVisionProvider(runner ? { runner } : {});
}

/** Pair each sampled frame file with its source time from the analysis artifact. */
export function pairFrameTimes(files: string[], frameDir: string, analysis: SourceAnalysisValue): FrameFile[] {
  const metrics = analysis.frames ?? [];
  if (files.length !== metrics.length) {
    throw new Error(`Sampled frame count ${files.length} does not match frame metric count ${metrics.length}.`);
  }
  return files.map((name, i) => ({
    absPath: join(frameDir, name),
    atSeconds: metrics[i]!.atSeconds,
  }));
}

/** Keep temporal coverage while respecting a provider frame cap. */
export function selectFramesEvenly(frames: FrameFile[], maxFrames: number): FrameFile[] {
  if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new Error("maxFrames must be a positive integer.");
  if (frames.length <= maxFrames) return [...frames];
  if (maxFrames === 1) return [frames[0]!];
  const selected: FrameFile[] = [];
  for (let i = 0; i < maxFrames; i++) {
    const index = Math.round((i * (frames.length - 1)) / (maxFrames - 1));
    selected.push(frames[index]!);
  }
  return selected;
}

/** Run one multimodal interpretation and write a validated understanding artifact. */
export async function understandSource(input: UnderstandSourceInput): Promise<UnderstandSourceResult> {
  const policy = input.permissionPolicy ?? createPolicy([]);
  requireGrant("network", policy, input.now);
  requireGrant("media-upload", policy, input.now);

  const root = input.root ?? analysisRoot();
  const readAnalysis = input.readAnalysis ?? ((p: string) => readFileSync(p, "utf8"));
  const listFrames = input.listFrames ?? ((d: string) => readdirSync(d));
  const realpathPath = input.realpathPath ?? realpathSync;
  const writeFile = input.writeFile ?? ((p: string, d: string) => writeFileSync(p, d, "utf8"));
  const ensureDir = input.ensureDir ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const makeProvider = input.provider ?? ((id: UnderstandProviderId) => defaultProvider(id, input.runner));

  // 1. Containment: the analysis file must live under the root. No arbitrary reads.
  const absAnalysis = isAbsolute(input.analysisPath)
    ? resolve(input.analysisPath)
    : resolve(process.cwd(), input.analysisPath);
  assertContainedPath(absAnalysis, root, "analysis file");
  const realRoot = realpathPath(root);
  const realAnalysis = realpathPath(absAnalysis);
  assertContainedPath(realAnalysis, realRoot, "real analysis file");

  const raw = readAnalysis(realAnalysis);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Analysis file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseSourceAnalysis(json);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`Analysis file failed validation: ${parsed.errors.join("; ")}`);
  }
  const analysis = parsed.data;

  // 2. Frames live in the `frames/` directory beside the analysis file; it too
  //    must be contained. Every evidence frame is inside this one granted dir.
  const frameDir = join(dirname(realAnalysis), "frames");
  assertContainedPath(frameDir, realRoot, "frame directory");
  const realFrameDir = realpathPath(frameDir);
  assertContainedPath(realFrameDir, realRoot, "real frame directory");
  const files = listFrames(realFrameDir)
    .filter((f) => FRAME_FILE.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error(`No sampled frames under ${realFrameDir}; re-run 'agent analyze ... --frames' first.`);
  }
  const pairedFrames = pairFrameTimes(files, realFrameDir, analysis);
  const frames = selectFramesEvenly(pairedFrames, input.config?.maxFrames ?? 24);

  // 3. Interpret. The provider returns validated data only.
  if (!isUnderstandProviderId(input.providerId)) {
    throw new Error(`Unknown understanding provider '${input.providerId}'. Use: ${UNDERSTAND_PROVIDERS.join(", ")}`);
  }
  const provider = makeProvider(input.providerId);
  const understanding = await provider.understand({
    analysis,
    frames,
    frameDir: realFrameDir,
    ...(input.statFile ? { statFile: input.statFile } : {}),
    ...(input.config ? { config: input.config } : {}),
    ...(input.now ? { now: input.now } : {}),
  });

  // 4. Write under the root; the output never escapes.
  const understandingPath = input.outFile
    ? isAbsolute(input.outFile)
      ? resolve(input.outFile)
      : resolve(process.cwd(), input.outFile)
    : join(dirname(absAnalysis), "understanding.json");
  assertContainedPath(understandingPath, root, "output file");

  ensureDir(dirname(understandingPath));
  writeFile(understandingPath, JSON.stringify(understanding, null, 2) + "\n");

  return { understandingPath, frameDir: realFrameDir, frameCount: frames.length, understanding };
}
