/**
 * Complete hook-variant production (parity phase 5).
 *
 * A request for N variants returns exactly N distinct, renderer-ready, validated
 * variants, or it fails. Never fewer, never prose. This module holds:
 *
 *   - the deterministic offline producer, which builds the full requested count
 *     from safe opening strategies, changing only the opening scene's text (and,
 *     where present, its overlapping caption), preserving every body scene, all
 *     media, and all audio, and inventing no media or source ranges;
 *   - the engine assembly, which stamps identity (id, timestamp, source-plan
 *     hash, count, provider), resolves each variant to a COMPLETE plan, validates
 *     it against the existing edit-plan schema, forbids invented media, forbids
 *     body changes unless the request explicitly permits them, and enforces
 *     distinct ids, text, strategies, and plan hashes;
 *   - the orchestrator, which selects the deterministic or restricted Claude
 *     provider, enforces the network permission before any Claude call, and
 *     optionally writes an atomic manifest plus one validated plan JSON per
 *     variant under a contained output directory. It never renders.
 *
 * A provider returns interpretation DATA only; the engine owns identity. A
 * Claude shortfall, duplicate, invalid plan, or undeclared media fails and is
 * never silently padded unless the operator explicitly selects deterministic
 * fallback.
 */

import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createPolicy, requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import { assertContainedPath } from "../util/paths.js";
import { atomicWrite } from "../agent/audit.js";
import { sha256String } from "../util/hash.js";
import { parseEditPlan, type EditPlan, type Scene, type CaptionCard } from "../schema/editPlan.js";
import type { ExecFn } from "../agent/exec.js";
import {
  HOOK_STRATEGIES,
  HOOK_VARIANT_SET_FORMAT,
  normalizeHookText,
  parseHookVariantRequest,
  parseHookVariantSet,
  selectHookSceneId,
  type HookPlanCarrierValue,
  type HookPlanFragmentValue,
  type HookStrategy,
  type HookVariantRequestValue,
  type HookVariantSetValue,
  type HookVariantValue,
  type ModelHookVariantValue,
} from "./schemas.js";
import { createClaudeHookProvider, type HookTextProvider } from "./claudeHooks.js";

export const DETERMINISTIC_PROVIDER_LABEL = "deterministic-offline";
export const DETERMINISTIC_FALLBACK_LABEL = "deterministic-fallback";
export const CLAUDE_HOOK_MODEL_LABEL = "claude-code-hooks";

/** The output root every write stays under. Defaults to `<cwd>/output`. */
export function hookVariantsOutputRoot(): string {
  const dir = process.env.OVE_OUTPUT_DIR?.trim() || "output";
  return resolve(process.cwd(), dir);
}

// --- Deterministic opening text -------------------------------------------------

/** Distinct opening template per strategy. Each leads with a different word so
 *  even a one-word truncation stays distinct. None references media. */
const STRATEGY_TEMPLATE: Record<HookStrategy, (objective: string) => string> = {
  "direct-question": (o) => `What matters most about ${o}?`,
  "bold-claim": (o) => `Notice why ${o} deserves a closer look.`,
  "curiosity-gap": (o) => `There is more to ${o}.`,
  "stat-callout": (o) => `Count the parts of ${o} that matter.`,
  "direct-address": (o) => `You can look at ${o} this way.`,
  contrarian: (o) => `Instead, look at ${o} from the opposite angle.`,
  "story-open": (o) => `Watch how ${o} unfolds.`,
  "pattern-interrupt": (o) => `Pause. Let us look at ${o}.`,
  "problem-first": (o) => `Start with ${o} when it feels hard.`,
  "outcome-first": (o) => `Approach ${o} with a clearer path.`,
};

/** Short human-readable style label per strategy (distinct). */
const STRATEGY_STYLE: Record<HookStrategy, string> = {
  "direct-question": "curious question",
  "bold-claim": "confident claim",
  "curiosity-gap": "open loop",
  "stat-callout": "number-led",
  "direct-address": "second-person",
  contrarian: "myth-buster",
  "story-open": "narrative cold-open",
  "pattern-interrupt": "scroll-stopper",
  "problem-first": "pain-first",
  "outcome-first": "result-first",
};

function hookTopic(objective: string): string {
  const trimmed = objective.trim();
  const whyMatters = trimmed.match(/^(?:explain|show)\s+why\s+(.+?)\s+matters[.!?]?$/i);
  if (whyMatters?.[1]) return whyMatters[1].trim();
  const howTo = trimmed.match(/^(?:explain|show)\s+how\s+to\s+(.+)$/i);
  if (howTo?.[1]) return howTo[1].trim();
  const explain = trimmed.match(/^(?:explain|show)\s+(.+)$/i);
  return explain?.[1]?.trim() || trimmed;
}

function clampWords(text: string, maxWords: number | undefined): string {
  if (maxWords === undefined) return text;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ");
}

/** Build the opening text for one strategy, honoring an optional word cap. */
export function buildHookText(strategy: HookStrategy, objective: string, maxWords?: number): string {
  const raw = STRATEGY_TEMPLATE[strategy](hookTopic(objective));
  return clampWords(raw, maxWords);
}

function buildRationale(strategy: HookStrategy, objective: string): string {
  return `Opens with a ${STRATEGY_STYLE[strategy]} framing of "${objective.trim()}" to earn the first three seconds, leaving every body scene, all media, and the audio untouched.`;
}

// --- Plan selection, merge, resolve ---------------------------------------------

/** The opening scene: first `hook`, else first `intro`, else the earliest scene. */
export function selectHookScene(plan: EditPlan): { scene: Scene; index: number } {
  const id = selectHookSceneId(plan);
  const index = plan.scenes.findIndex((s) => s.id === id);
  return { scene: plan.scenes[index]!, index };
}

/** Apply a strictly typed fragment to a clone of the plan. Text only; never adds media. */
export function mergeHookFragment(plan: EditPlan, fragment: HookPlanFragmentValue): EditPlan {
  const clone = structuredClone(plan) as EditPlan;
  const scene = clone.scenes.find((s) => s.id === fragment.hookSceneId);
  if (!scene) {
    throw new Error(`Hook fragment references unknown scene id '${fragment.hookSceneId}'.`);
  }
  if (fragment.heading !== undefined) scene.heading = fragment.heading;
  if (fragment.body !== undefined) scene.body = fragment.body;
  if (fragment.emphasis !== undefined) scene.emphasis = fragment.emphasis;
  if (fragment.frameZero !== undefined) scene.frameZero = fragment.frameZero;

  if (fragment.captionText !== undefined) {
    const wordCap = clone.captions.allowExtendedCards ? clone.captions.maxWordsPerCard : 3;
    const capped = clampWords(fragment.captionText, wordCap);
    // Only rewrite caption cards that already overlap the opening scene. Never add one.
    for (const card of clone.captions.cards) {
      if (cardOverlaps(card, scene)) card.text = capped;
    }
  }
  return clone;
}

function cardOverlaps(card: CaptionCard, scene: Scene): boolean {
  return card.start < scene.end && card.end > scene.start;
}

/** Resolve a carrier to a COMPLETE, validated plan. */
export function resolveVariantPlan(
  carrier: HookPlanCarrierValue,
  sourcePlan: EditPlan,
): { ok: boolean; plan?: EditPlan; errors: string[] } {
  let candidate: unknown;
  if (carrier.kind === "complete") {
    candidate = carrier.plan;
  } else {
    try {
      candidate = mergeHookFragment(sourcePlan, carrier.fragment);
    } catch (err) {
      return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
  }
  const parsed = parseEditPlan(candidate);
  return parsed.ok && parsed.plan ? { ok: true, plan: parsed.plan, errors: [] } : { ok: false, errors: parsed.errors };
}

// --- Integrity checks -----------------------------------------------------------

/** Every media reference in `resolved` must already exist in the source plan. */
export function findInventedMedia(resolved: EditPlan, source: EditPlan): string[] {
  const invented: string[] = [];
  if (JSON.stringify(resolved.sourceClips) !== JSON.stringify(source.sourceClips)) {
    invented.push("source clip declarations or ranges changed");
  }
  if (JSON.stringify(resolved.audio) !== JSON.stringify(source.audio)) {
    invented.push("audio declarations changed");
  }
  const sourceClips = new Map(source.sourceClips.map((c) => [c.id, c.path]));
  for (const clip of resolved.sourceClips) {
    if (!sourceClips.has(clip.id)) invented.push(`source clip id '${clip.id}'`);
    else if (sourceClips.get(clip.id) !== clip.path) invented.push(`source clip '${clip.id}' path '${clip.path}'`);
  }
  const sourceBroll = new Set(source.scenes.map((s) => s.broll).filter((b): b is string => b !== undefined));
  for (const scene of resolved.scenes) {
    if (scene.broll !== undefined && !sourceBroll.has(scene.broll)) invented.push(`b-roll '${scene.broll}'`);
  }
  const sourceAudioPaths = audioPaths(source);
  for (const p of audioPaths(resolved)) {
    if (!sourceAudioPaths.has(p)) invented.push(`audio media '${p}'`);
  }
  return invented;
}

function audioPaths(plan: EditPlan): Set<string> {
  const out = new Set<string>();
  if (plan.audio.dialoguePath) out.add(plan.audio.dialoguePath);
  if (plan.audio.music) out.add(plan.audio.music.path);
  for (const cue of plan.audio.sfx) out.add(cue.asset);
  return out;
}

/**
 * Report any change outside the opening scene: a differing body/media field on
 * the hook scene, any change to another scene, any change to source clips, audio,
 * or non-overlapping captions. Used to enforce opening-only edits.
 */
export function changesOutsideOpening(source: EditPlan, resolved: EditPlan, hookSceneId: string): string[] {
  const violations: string[] = [];
  const j = (v: unknown) => JSON.stringify(v);

  if (source.scenes.length !== resolved.scenes.length) {
    violations.push("scene count changed");
    return violations;
  }
  for (let i = 0; i < source.scenes.length; i++) {
    const a = source.scenes[i]!;
    const b = resolved.scenes[i]!;
    if (a.id !== b.id) {
      violations.push(`scene ${i} id changed`);
      continue;
    }
    if (b.id === hookSceneId) {
      // The opening may change text only; structure and media must not move.
      for (const key of ["start", "end", "type", "punchIn", "broll", "sourceClipId", "sourceIn", "mute", "fit"] as const) {
        if (j(a[key]) !== j(b[key])) violations.push(`opening scene '${a.id}' changed protected field '${key}'`);
      }
    } else if (j(a) !== j(b)) {
      violations.push(`body scene '${a.id}' changed`);
    }
  }

  if (j(source.sourceClips) !== j(resolved.sourceClips)) violations.push("source clips changed");
  if (j(source.audio) !== j(resolved.audio)) violations.push("audio changed");
  for (const key of ["format", "title", "preset", "composition", "width", "height", "fps", "duration", "brand", "output"] as const) {
    if (j(source[key]) !== j(resolved[key])) violations.push(`plan field '${key}' changed`);
  }

  // Captions: only cards overlapping the opening may change; the rest, and the
  // caption config, must be identical.
  const hookScene = resolved.scenes.find((s) => s.id === hookSceneId)!;
  if (source.captions.maxWordsPerCard !== resolved.captions.maxWordsPerCard) violations.push("caption maxWordsPerCard changed");
  if (source.captions.allowExtendedCards !== resolved.captions.allowExtendedCards) violations.push("caption allowExtendedCards changed");
  if (source.captions.cards.length === resolved.captions.cards.length) {
    for (let i = 0; i < source.captions.cards.length; i++) {
      const a = source.captions.cards[i]!;
      const b = resolved.captions.cards[i]!;
      const overlaps = cardOverlaps(a, hookScene);
      if (!overlaps && j(a) !== j(b)) violations.push(`caption card ${i} outside the opening changed`);
      if (overlaps && (a.start !== b.start || a.end !== b.end)) violations.push(`caption card ${i} timing changed`);
    }
  } else {
    violations.push("caption card count changed");
  }
  return violations;
}

// --- Deterministic producer -----------------------------------------------------

/** Build exactly `count` interpretation variants offline. Fails rather than under-produce. */
export function deterministicHookVariants(request: HookVariantRequestValue): ModelHookVariantValue[] {
  const count = request.count;
  if (count > HOOK_STRATEGIES.length) {
    throw new Error(`Cannot produce ${count} distinct variants; only ${HOOK_STRATEGIES.length} safe strategies exist.`);
  }
  const { scene } = selectHookScene(request.sourcePlan);
  const out: ModelHookVariantValue[] = [];
  for (let i = 0; i < count; i++) {
    const strategy = HOOK_STRATEGIES[i]!;
    const hookText = buildHookText(strategy, request.objective, request.style?.maxWords);
    const merged = mergeHookFragment(request.sourcePlan, { hookSceneId: scene.id, heading: hookText });
    out.push({
      strategy,
      style: STRATEGY_STYLE[strategy],
      hookText,
      rationale: buildRationale(strategy, request.objective),
      confidence: 0.6,
      plan: { kind: "complete", plan: merged },
    });
  }
  return out;
}

// --- Engine assembly ------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** SHA-256 of a plan, with keys sorted so the hash is stable across key order. */
export function hashPlan(plan: EditPlan): string {
  return sha256String(stableStringify(plan));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function styleViolations(text: string, request: HookVariantRequestValue): string[] {
  const normalized = normalizeHookText(text);
  const violations: string[] = [];
  const maxWords = request.style?.maxWords;
  if (maxWords !== undefined && text.trim().split(/\s+/).filter(Boolean).length > maxWords) {
    violations.push(`exceeds maxWords ${maxWords}`);
  }
  for (const phrase of request.style?.bannedPhrases ?? []) {
    if (normalized.includes(normalizeHookText(phrase))) violations.push(`contains banned phrase '${phrase}'`);
  }
  for (const keyword of request.style?.requiredKeywords ?? []) {
    if (!normalized.includes(normalizeHookText(keyword))) violations.push(`is missing required keyword '${keyword}'`);
  }
  return violations;
}

export interface AssembleParams {
  request: HookVariantRequestValue;
  modelVariants: ModelHookVariantValue[];
  providerId: string;
  providerModel: string;
  now: Date;
}

/**
 * Assemble the final, identity-stamped set. Throws on any shortfall, overage,
 * invalid plan, invented media, disallowed body change, or duplicate. The engine,
 * not the provider, owns identity.
 */
export function assembleVariantSet(params: AssembleParams): HookVariantSetValue {
  const { request, modelVariants, providerId, providerModel, now } = params;
  if (modelVariants.length !== request.count) {
    throw new Error(`Provider returned ${modelVariants.length} variant(s); exactly ${request.count} were requested.`);
  }
  const { scene: hookScene } = selectHookScene(request.sourcePlan);
  const sourceHash = hashPlan(request.sourcePlan);
  const allowBody = request.style?.allowBodyChanges === true;

  const variants: HookVariantValue[] = [];
  const seenText = new Set<string>();
  const seenStrategy = new Set<string>();
  const seenHash = new Set<string>();

  modelVariants.forEach((mv, i) => {
    const label = `variant ${i + 1} (${mv.strategy})`;
    const resolved = resolveVariantPlan(mv.plan, request.sourcePlan);
    if (!resolved.ok || !resolved.plan) {
      throw new Error(`${label} produced an invalid plan: ${resolved.errors.join("; ")}`);
    }
    const invented = findInventedMedia(resolved.plan, request.sourcePlan);
    if (invented.length) {
      throw new Error(`${label} declared media not present in the source plan: ${invented.join(", ")}`);
    }
    if (!allowBody) {
      const changed = changesOutsideOpening(request.sourcePlan, resolved.plan, hookScene.id);
      if (changed.length) {
        throw new Error(`${label} changed content outside the opening (body changes not permitted): ${changed.join("; ")}`);
      }
    }
    const planHash = hashPlan(resolved.plan);
    const textKey = normalizeHookText(mv.hookText);
    const resolvedHook = resolved.plan.scenes.find((s) => s.id === hookScene.id)!;
    const renderedOpeningText = [
      resolvedHook.heading,
      resolvedHook.body,
      resolvedHook.emphasis,
      resolvedHook.frameZero,
      ...resolved.plan.captions.cards.filter((c) => cardOverlaps(c, resolvedHook)).map((c) => c.text),
    ].filter((v): v is string => typeof v === "string");
    if (!renderedOpeningText.some((text) => normalizeHookText(text) === textKey)) {
      throw new Error(`${label} hookText does not match any rendered opening text field.`);
    }
    const styleErrors = styleViolations(mv.hookText, request);
    if (styleErrors.length) throw new Error(`${label} violates style constraints: ${styleErrors.join("; ")}`);
    if (seenStrategy.has(mv.strategy)) throw new Error(`${label} repeats strategy '${mv.strategy}'.`);
    if (seenText.has(textKey)) throw new Error(`${label} repeats hook text "${mv.hookText}".`);
    if (seenHash.has(planHash)) throw new Error(`${label} repeats a plan identical to another variant.`);
    seenStrategy.add(mv.strategy);
    seenText.add(textKey);
    seenHash.add(planHash);

    variants.push({
      id: `hook-${pad2(i + 1)}`,
      strategy: mv.strategy,
      style: mv.style,
      hookText: mv.hookText,
      rationale: mv.rationale,
      confidence: mv.confidence,
      plan: mv.plan,
      planHash,
    });
  });

  const set = {
    format: HOOK_VARIANT_SET_FORMAT,
    objective: request.objective,
    count: request.count,
    generatedAt: now.toISOString(),
    provider: { id: providerId, model: providerModel },
    sourcePlan: { title: request.sourcePlan.title, identity: request.sourcePlan.format, hash: sourceHash },
    variants,
  };
  const parsed = parseHookVariantSet(set);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`Assembled hook-variant set failed validation: ${parsed.errors.join("; ")}`);
  }
  return parsed.data;
}

// --- Orchestrator ---------------------------------------------------------------

export type HookProviderId = "deterministic" | "claude";

export interface ProduceHookVariantsInput {
  /** The request. Re-validated here regardless of caller. */
  request: HookVariantRequestValue;
  providerId: HookProviderId;
  /** Grants. Deterministic is offline; Claude requires a `network` grant. */
  permissionPolicy?: PermissionPolicy;
  now?: Date;
  /** When set, write an atomic manifest and per-variant plan files under this directory. */
  outputDir?: string;
  /** Containment root the output directory must stay under. Defaults to the output root. */
  outputRoot?: string;
  /** Only when the operator explicitly opts in: fall back to the deterministic set if Claude fails. */
  allowDeterministicFallback?: boolean;

  // Injectable steps (real defaults below).
  claudeProvider?: HookTextProvider;
  runner?: ExecFn;
  writeFile?: (path: string, data: string) => void;
  ensureDir?: (dir: string) => void;
  canonicalize?: (path: string) => string;
  isDirectory?: (path: string) => boolean;
}

export interface ProduceHookVariantsResult {
  set: HookVariantSetValue;
  outDir?: string;
  manifestPath?: string;
  planPaths?: string[];
}

/** Produce exactly N distinct, validated hook variants (or fail). Never renders. */
export async function produceHookVariants(input: ProduceHookVariantsInput): Promise<ProduceHookVariantsResult> {
  const parsedReq = parseHookVariantRequest(input.request);
  if (!parsedReq.ok || !parsedReq.data) {
    throw new Error(`Invalid hook-variant request: ${parsedReq.errors.join("; ")}`);
  }
  const request = parsedReq.data;
  const now = input.now ?? new Date();
  const policy = input.permissionPolicy ?? createPolicy([]);

  let set: HookVariantSetValue;
  if (input.providerId === "deterministic") {
    set = assembleVariantSet({
      request,
      modelVariants: deterministicHookVariants(request),
      providerId: "deterministic",
      providerModel: DETERMINISTIC_PROVIDER_LABEL,
      now,
    });
  } else if (input.providerId === "claude") {
    // Permission gate BEFORE any Claude invocation. Deny by default.
    requireGrant("network", policy, now);
    const provider = input.claudeProvider ?? createClaudeHookProvider(input.runner ? { runner: input.runner } : {});
    try {
      const modelVariants = await provider.produce({ request, now });
      set = assembleVariantSet({ request, modelVariants, providerId: "claude", providerModel: CLAUDE_HOOK_MODEL_LABEL, now });
    } catch (err) {
      if (!input.allowDeterministicFallback) throw err;
      set = assembleVariantSet({
        request,
        modelVariants: deterministicHookVariants(request),
        providerId: "deterministic-fallback",
        providerModel: DETERMINISTIC_FALLBACK_LABEL,
        now,
      });
    }
  } else {
    throw new Error(`Unknown hook-variant provider '${String(input.providerId)}'.`);
  }

  if (input.outputDir === undefined) {
    return { set };
  }

  const root = input.outputRoot ? resolve(input.outputRoot) : hookVariantsOutputRoot();
  const outDir = isAbsolute(input.outputDir) ? resolve(input.outputDir) : resolve(process.cwd(), input.outputDir);
  const writeFile = input.writeFile ?? atomicWrite;
  const ensureDir = input.ensureDir ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const written = writeHookVariantOutput({
    set,
    request,
    outDir,
    root,
    writeFile,
    ensureDir,
    canonicalize: input.canonicalize ?? realpathSync,
    isDirectory: input.isDirectory ?? ((p) => statSync(p).isDirectory()),
  });
  return { set, outDir, manifestPath: written.manifestPath, planPaths: written.planPaths };
}

interface WriteParams {
  set: HookVariantSetValue;
  request: HookVariantRequestValue;
  outDir: string;
  root: string;
  writeFile: (path: string, data: string) => void;
  ensureDir: (dir: string) => void;
  canonicalize: (path: string) => string;
  isDirectory: (path: string) => boolean;
}

/** Write one validated plan JSON per variant plus a manifest, all atomic and contained. */
function writeHookVariantOutput(params: WriteParams): { manifestPath: string; planPaths: string[] } {
  const { set, request, outDir, root, writeFile, ensureDir, canonicalize, isDirectory } = params;
  assertContainedPath(outDir, root, "hook-variants output directory");
  ensureDir(outDir);
  const canonicalRoot = canonicalize(root);
  const canonicalOutDir = canonicalize(outDir);
  assertContainedPath(canonicalOutDir, canonicalRoot, "canonical hook-variants output directory");
  if (!isDirectory(canonicalOutDir)) throw new Error("Hook-variants output path is not a directory.");

  const planPaths: string[] = [];
  const manifestVariants = set.variants.map((v) => {
    const resolved = resolveVariantPlan(v.plan, request.sourcePlan);
    if (!resolved.ok || !resolved.plan) {
      throw new Error(`Variant ${v.id} plan failed to resolve for writing: ${resolved.errors.join("; ")}`);
    }
    const planFileName = `${v.id}.plan.json`;
    const planFile = join(canonicalOutDir, planFileName);
    assertContainedPath(planFile, canonicalRoot, "variant plan file");
    writeFile(planFile, JSON.stringify(resolved.plan, null, 2) + "\n");
    planPaths.push(planFile);
    return {
      id: v.id,
      strategy: v.strategy,
      style: v.style,
      hookText: v.hookText,
      confidence: v.confidence,
      planHash: v.planHash,
      planFile: planFileName,
    };
  });

  const manifest = {
    format: HOOK_VARIANT_SET_FORMAT,
    objective: set.objective,
    count: set.count,
    generatedAt: set.generatedAt,
    provider: set.provider,
    sourcePlan: set.sourcePlan,
    variants: manifestVariants,
  };
  // Write the manifest LAST so a crashed run never leaves a complete-looking manifest
  // pointing at plan files that were not all written.
  const manifestPath = join(canonicalOutDir, "manifest.json");
  assertContainedPath(manifestPath, canonicalRoot, "manifest file");
  writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifestPath, planPaths };
}
