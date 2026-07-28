/**
 * Rendered-draft critique orchestrator (parity phase 3).
 *
 * Ties permission enforcement, containment, deterministic frame sampling, the
 * FFprobe-authoritative master duration, the restricted critique provider, and
 * validated writing into one flow:
 *   1. require explicit `network` and `media-upload` grants; deny by default
 *      before anything is sampled or spawned.
 *   2. sample the already-rendered master into a contained run directory (lexical
 *      and realpath containment, regular-file check, no master overwrite).
 *   3. probe the real master duration with FFprobe.
 *   4. hand the plan, master reference, duration, and sampled frames to the
 *      restricted provider, which returns validated critique DATA only.
 *   5. write the validated critique under the same output root; it never escapes.
 *
 * Every heavy step is injectable so the whole flow runs offline in tests without
 * spawning FFmpeg or `claude`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertContainedPath } from "../util/paths.js";
import { createPolicy, requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import { probe } from "../ffmpeg/ffprobe.js";
import type { ExecFn } from "../agent/exec.js";
import type { EditPlan } from "../schema/editPlan.js";
import { sampleRenderedMaster, type SampleMasterResult } from "./sampleMaster.js";
import {
  createClaudeCritiqueProvider,
  type ClaudeCritiqueConfig,
  type DraftReviewProvider,
} from "./claudeCritique.js";
import { type DraftCritiqueValue } from "./schemas.js";

/** The output root every read and write stays under. Defaults to `<cwd>/output`. */
export function critiqueOutputRoot(): string {
  const dir = process.env.OVE_OUTPUT_DIR?.trim() || "output";
  return resolve(process.cwd(), dir);
}

export interface CritiqueRenderedMasterInput {
  /** The exact plan that produced the master under review. */
  plan: EditPlan;
  /** Path to the already-rendered master (relative to cwd or absolute). */
  masterPath: string;
  /** Explicit output root the master and frames stay under. Defaults to the output root. */
  outputRoot?: string;
  /** Explicit grants for outbound model access and sending sampled frame bytes. Default deny. */
  permissionPolicy?: PermissionPolicy;
  /** Output file. Defaults to `<master>.critique.json` beside the master. */
  outFile?: string;
  now?: Date;
  config?: Partial<ClaudeCritiqueConfig>;

  // Injectable steps (real defaults below).
  sample?: typeof sampleRenderedMaster;
  probeDuration?: (masterAbsPath: string) => Promise<number>;
  provider?: DraftReviewProvider;
  writeFile?: (path: string, data: string) => void;
  ensureDir?: (dir: string) => void;
  /** Runner passed to the default sampler and provider (tests inject fakes). */
  runner?: ExecFn;
}

export interface CritiqueRenderedMasterResult {
  critiquePath: string;
  masterPath: string;
  frameDir: string;
  frameCount: number;
  durationSeconds: number;
  critique: DraftCritiqueValue;
}

async function defaultProbeDuration(masterAbsPath: string): Promise<number> {
  const p = await probe(masterAbsPath);
  const dur = Number(p.format.duration);
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`Could not read a valid duration from the master: ${masterAbsPath}`);
  }
  return dur;
}

/** Run one restricted critique of a rendered master and write a validated artifact. */
export async function critiqueRenderedMaster(
  input: CritiqueRenderedMasterInput,
): Promise<CritiqueRenderedMasterResult> {
  // 1. Permission: deny by default, before any sampling or spawn.
  const policy = input.permissionPolicy ?? createPolicy([]);
  requireGrant("network", policy, input.now);
  requireGrant("media-upload", policy, input.now);

  const root = input.outputRoot ? resolve(input.outputRoot) : critiqueOutputRoot();
  const sample = input.sample ?? sampleRenderedMaster;
  const probeDuration = input.probeDuration ?? defaultProbeDuration;
  const provider = input.provider ?? createClaudeCritiqueProvider(input.runner ? { runner: input.runner } : {});
  const writeFile = input.writeFile ?? ((p: string, d: string) => writeFileSync(p, d, "utf8"));
  const ensureDir = input.ensureDir ?? ((d: string) => mkdirSync(d, { recursive: true }));

  // 2. Sample the rendered master into a contained run directory.
  const sampled: SampleMasterResult = await sample({
    masterPath: input.masterPath,
    outputRoot: root,
    ...(input.config?.maxFrames !== undefined ? { maxFrames: input.config.maxFrames } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
  });

  // 3. Probe the FFprobe-authoritative duration of the real master.
  const durationSeconds = await probeDuration(sampled.masterPath);

  // 4. Portable relative master reference under the root.
  const masterRelPath = relative(resolve(root), sampled.masterPath).replace(/\\/g, "/");
  const master = { path: masterRelPath };

  // 5. Critique. The provider returns validated data only.
  const critique = await provider.critique({
    plan: input.plan,
    master,
    durationSeconds,
    frames: sampled.frames,
    frameDir: sampled.frameDir,
    ...(input.config ? { config: input.config } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
    ...(input.now ? { now: input.now } : {}),
  });

  // 6. Write under the root; the output never escapes.
  const critiquePath = input.outFile
    ? isAbsolute(input.outFile)
      ? resolve(input.outFile)
      : resolve(process.cwd(), input.outFile)
    : join(dirname(sampled.masterPath), `${planMasterBase(sampled.masterPath)}.critique.json`);
  assertContainedPath(critiquePath, root, "output file");

  ensureDir(dirname(critiquePath));
  writeFile(critiquePath, JSON.stringify(critique, null, 2) + "\n");

  return {
    critiquePath,
    masterPath: sampled.masterPath,
    frameDir: sampled.frameDir,
    frameCount: sampled.frames.length,
    durationSeconds,
    critique,
  };
}

function planMasterBase(masterAbsPath: string): string {
  return masterAbsPath.split(/[\\/]/).pop()!.replace(/\.mp4$/i, "");
}
