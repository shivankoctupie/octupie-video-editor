/**
 * Agent CLI surface: `octupie-video-editor agent <subcommand>`.
 *
 * Pure and injectable: it takes argv and a small deps bag (logging, home,
 * provider and diagnostics factories, a prober) and returns an exit code, so
 * every path is testable without touching process globals. Exit codes: 0 ok,
 * 1 an operation that ran but did not pass (render/QA failed, unknown rule to
 * deactivate), 2 a usage or input error (bad args, invalid brief, bad scope,
 * unknown provider).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Provider, ProviderDiagnostic } from "./providers/types.js";
import { getProvider, isProviderId, diagnoseAll } from "./providers/index.js";
import { parseAgentBrief } from "./brief.js";
import { agentRun } from "./run.js";
import {
  agentHome,
  addFeedbackRule,
  listRules,
  deactivateRule,
  RULE_SCOPES,
  type RuleScope,
} from "./learning.js";
import { enforceMaxSize, MAX_SIZES } from "./redact.js";
import type { ClipProbe } from "./manifest.js";
import { resolveExistingAssetPath } from "../util/assetRoot.js";
import { probe as ffprobe, videoStream, audioStream } from "../ffmpeg/ffprobe.js";
import { diagnoseCapabilities } from "../capabilities/registry.js";
import type { CapabilityProbe } from "../capabilities/types.js";
import { buildCapabilityProbes } from "../capabilities/probes.js";
import { loadAcceptanceManifest } from "../capabilities/acceptance.js";
import { createPolicy, PERMISSION_ACTIONS } from "../permissions/policy.js";
import { analyzeSource, defaultAnalysisOutDir } from "../analysis/analyze.js";
import { understandSource, isUnderstandProviderId, UNDERSTAND_PROVIDERS } from "../understanding/understand.js";
import { parseEditPlan } from "../schema/editPlan.js";
import { critiqueRenderedMaster } from "../critique/critique.js";
import { reviewPlan } from "../critique/review.js";
import { discoverAssets } from "../discovery/discover.js";
import { ASSET_SOURCE_KINDS, type AssetSourceKind } from "../discovery/schemas.js";
import { produceHookVariants, type HookProviderId } from "../hooks/produce.js";
import { connectHermes, orchestrateHermes, type HermesFetch } from "../hermes/client.js";
import { HERMES_DEFAULT_BASE_URL } from "../hermes/schemas.js";
import { applyProposal, ImprovementGateError, type TestRunner } from "../improvements/apply.js";
import { rollbackProposal } from "../improvements/rollback.js";
import { testCommandArgv } from "../improvements/schemas.js";
import { authorize, isWorkflowAction, isWorkflowRole, WORKFLOW_ACTIONS, WORKFLOW_ROLES } from "../workflow/rbac.js";
import { publish as workflowPublish, disabledPublishingAdapter, type PublishingAdapter } from "../workflow/publishing.js";
import { execProcess, type ExecFn } from "./exec.js";
import { PermissionDeniedError } from "../permissions/policy.js";

export interface AgentCliDeps {
  log?: (s: string) => void;
  errorLog?: (s: string) => void;
  home?: string;
  now?: Date;
  /** Provider factory override (tests). When absent, the built-in registry is used. */
  provider?: (id: string) => Provider;
  /** Diagnostics override (tests). When absent, all providers are diagnosed. */
  diagnostics?: () => Promise<ProviderDiagnostic[]>;
  /** Clip prober override. When absent, a real FFprobe-backed prober is used. */
  prober?: (id: string, path: string) => Promise<ClipProbe>;
  /** Transcript loader override. The default reads a contained asset-root file. */
  transcriptLoader?: (path: string) => string;
  /** Capability probe overrides (tests). Used by `capabilities --probe`. */
  capabilityProbes?: Record<string, CapabilityProbe>;
  /** Source analyzer override (tests). Defaults to the real local analyzer. */
  analyze?: typeof analyzeSource;
  /** Multimodal understanding override (tests). Defaults to the real orchestrator. */
  understand?: typeof understandSource;
  /** Rendered-draft critique override (tests). Defaults to the real orchestrator. */
  critique?: typeof critiqueRenderedMaster;
  /** Bounded review-loop override (tests). Defaults to the real wiring. */
  review?: typeof reviewPlan;
  /** Rights-safe asset discovery override (tests). Defaults to local discovery and optional providers. */
  discoverAssets?: typeof discoverAssets;
  /** Hook-variant production override (tests). Defaults to the real orchestrator. */
  produceHookVariants?: typeof produceHookVariants;
  /** Environment source (tests). Defaults to `process.env`. Used to read the Hermes token. */
  env?: Record<string, string | undefined>;
  /** Hermes transport override (tests). Defaults to the real global-fetch transport. */
  hermesFetch?: HermesFetch;
  /** Hermes connect override (tests). Defaults to the real official adapter. */
  hermesConnect?: typeof connectHermes;
  /** Hermes orchestrate override (tests). Defaults to the real official adapter. */
  hermesOrchestrate?: typeof orchestrateHermes;
  /** Improvement-apply override (tests). Defaults to the real deterministic engine. */
  applyImprovement?: typeof applyProposal;
  /** Improvement-rollback override (tests). Defaults to the real deterministic engine. */
  rollbackImprovement?: typeof rollbackProposal;
  /** Injected test runner for improvement apply. Defaults to a shell:false exec runner. */
  improvementTestRunner?: TestRunner;
  /** Process runner for the default improvement test runner (tests). Defaults to execProcess. */
  exec?: ExecFn;
  /** Workflow publish override (tests). Defaults to the real deterministic publish flow. */
  publishWorkflow?: typeof workflowPublish;
  /** Publishing adapter override (tests). Defaults to the disabled adapter (publishing off). */
  publishingAdapter?: PublishingAdapter;
}

interface Parsed {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Parsed {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export async function runAgentCli(argv: string[], deps: AgentCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((s: string) => process.stdout.write(s + "\n"));
  const errorLog = deps.errorLog ?? ((s: string) => process.stderr.write(s + "\n"));
  const home = deps.home ?? agentHome();
  const { _, flags } = parse(argv);
  const sub = _.shift();

  switch (sub) {
    case "providers":
      return cmdProviders(deps, log);
    case "capabilities":
      return cmdCapabilities(flags, deps, log);
    case "analyze":
      return cmdAnalyze({ _, flags }, deps, log, errorLog);
    case "understand":
      return cmdUnderstand({ _, flags }, deps, log, errorLog);
    case "critique":
      return cmdCritique({ _, flags }, deps, log, errorLog);
    case "review":
      return cmdReview({ _, flags }, deps, log, errorLog);
    case "discover-assets":
      return cmdDiscoverAssets({ _, flags }, deps, log, errorLog);
    case "hook-variants":
      return cmdHookVariants({ _, flags }, deps, log, errorLog);
    case "hermes-check":
      return cmdHermesCheck({ _, flags }, deps, log, errorLog);
    case "hermes-orchestrate":
      return cmdHermesOrchestrate({ _, flags }, deps, log, errorLog);
    case "improvement-apply":
      return cmdImprovementApply({ _, flags }, deps, log, errorLog);
    case "improvement-rollback":
      return cmdImprovementRollback({ _, flags }, deps, log, errorLog);
    case "workflow-authorize":
      return cmdWorkflowAuthorize({ _, flags }, log, errorLog);
    case "workflow-publish":
      return cmdWorkflowPublish({ _, flags }, deps, log, errorLog);
    case "run":
      return cmdRun({ _, flags }, deps, home, log, errorLog);
    case "feedback":
      return cmdFeedback(flags, deps, home, log, errorLog);
    case "rules":
      return cmdRules(flags, home, log);
    case "deactivate":
      return cmdDeactivate(flags, deps, home, log, errorLog);
    case "help":
    case undefined:
      usage(log);
      return 0;
    default:
      errorLog(`Unknown agent subcommand: ${sub}`);
      usage(errorLog);
      return 2;
  }
}

async function cmdProviders(deps: AgentCliDeps, log: (s: string) => void): Promise<number> {
  const diags = await (deps.diagnostics ?? diagnoseAll)();
  log("agent providers");
  for (const d of diags) {
    const auth = d.authenticated === true ? "auth:yes" : d.authenticated === false ? "auth:no" : "auth:unknown";
    log(`  ${d.available ? "ok  " : "--  "} ${d.id.padEnd(14)} ${auth.padEnd(13)} ${d.detail}`);
  }
  return 0;
}

/**
 * `agent capabilities` reports the truthful state of the eight parity capabilities,
 * the default-deny permission model, and the acceptance-gate ledger. It is fully
 * offline and deterministic and never claims an unimplemented feature.
 */
async function cmdCapabilities(
  flags: Record<string, string | boolean>,
  deps: AgentCliDeps,
  log: (s: string) => void,
): Promise<number> {
  // Default stays fully offline and all-unavailable. `--probe` runs the real
  // probes, which may report `configured` (never `verified` without a gate).
  const probes = flags["probe"] === true ? (deps.capabilityProbes ?? buildCapabilityProbes()) : undefined;
  const diags = await diagnoseCapabilities(probes ? { probes } : {});
  const manifest = loadAcceptanceManifest();
  const green = manifest.gates.filter((g) => g.status === "passed").length;
  const pending = manifest.gates.filter((g) => g.status === "pending").length;

  if (flags["json"] === true) {
    const payload = {
      capabilities: diags.map((d) => ({
        id: d.id,
        title: d.title,
        contract: d.contract,
        status: d.status,
        claimed: d.claimed,
        requiresPermissions: d.requiresPermissions,
        acceptanceGateIds: d.acceptanceGateIds,
        detail: d.detail,
      })),
      permissions: { defaultDeny: true, actions: [...PERMISSION_ACTIONS] },
      acceptance: { total: manifest.gates.length, green, pending },
    };
    log(JSON.stringify(payload, null, 2));
    return 0;
  }

  log("agent capabilities");
  for (const d of diags) {
    log(`  ${d.status.padEnd(11)} ${d.id.padEnd(30)} ${d.contract}`);
  }
  log("");
  log(`permissions: default-deny (${PERMISSION_ACTIONS.join(", ")})`);
  log(`acceptance gates: ${manifest.gates.length} total, ${green} green, ${pending} pending`);
  return 0;
}

async function cmdRun(
  parsed: Parsed,
  deps: AgentCliDeps,
  home: string,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const briefPath = parsed._[0];
  if (!briefPath) {
    errorLog("Usage: octupie-video-editor agent run <brief.json> [--provider id] [--max-iterations N] [--no-render]");
    return 2;
  }

  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), briefPath), "utf8");
    enforceMaxSize(raw, MAX_SIZES.brief, "brief");
  } catch (err) {
    errorLog(`Could not read brief: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    errorLog(`Brief is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const parsedBrief = parseAgentBrief(json);
  if (!parsedBrief.ok || !parsedBrief.brief) {
    errorLog(`Invalid brief: ${briefPath}`);
    for (const e of parsedBrief.errors) errorLog(`  - ${e}`);
    return 2;
  }

  const providerId = str(parsed.flags, "provider") ?? "deterministic";
  let provider: Provider;
  try {
    if (deps.provider) {
      provider = deps.provider(providerId);
    } else {
      if (!isProviderId(providerId)) {
        throw new Error(`Unknown provider '${providerId}'.`);
      }
      provider = getProvider(providerId);
    }
  } catch (err) {
    errorLog(`Provider error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const maxRaw = str(parsed.flags, "max-iterations");
  const maxIterations = maxRaw !== undefined ? Number(maxRaw) : undefined;
  if (maxIterations !== undefined && !Number.isFinite(maxIterations)) {
    errorLog(`--max-iterations must be a number, got "${maxRaw}".`);
    return 2;
  }
  const render = parsed.flags["no-render"] !== true;

  let transcriptText = parsedBrief.brief.transcript?.text;
  const transcriptPath = parsedBrief.brief.transcript?.path;
  if (transcriptText === undefined && transcriptPath !== undefined) {
    try {
      const load = deps.transcriptLoader ?? defaultTranscriptLoader;
      transcriptText = load(transcriptPath);
      enforceMaxSize(transcriptText, MAX_SIZES.transcript, "transcript");
    } catch (err) {
      errorLog(`Could not read transcript: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  try {
    const res = await agentRun({
      brief: parsedBrief.brief,
      provider,
      home,
      render,
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(transcriptText !== undefined ? { transcriptText } : {}),
      probe: deps.prober ?? defaultProber,
    });
    log(`run: ${res.runId}`);
    log(`audit: ${res.runDir}`);
    log(`status: ${res.status} (accepted=${res.accepted}, fallback=${res.usedFallback}, iterations=${res.iterations})`);
    if (res.activeRuleIds.length) log(`active rules: ${res.activeRuleIds.length}`);
    if (res.render) {
      log(`master: ${res.render.finalPath}`);
      log(`qa: ${res.render.pass ? "PASS" : "FAIL"} (${res.render.qaReportPath})`);
    }
    if (res.failure) log(`failure: ${res.failure}`);
    if (res.status === "render-failed" || res.status === "render-qa-failed") return 1;
    return 0;
  } catch (err) {
    errorLog(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `agent analyze <relClipPath>` runs the fully local source analysis: transcribe
 * with the faster-whisper bridge, measure silence, run the deterministic editorial
 * pass, and (optionally) sample frame metrics. It writes one validated analysis
 * artifact plus transcript JSON, SRT, and VTT under the output directory. It never
 * reaches the network (beyond the model's first-run download) and never writes
 * beside the source media.
 */
async function cmdAnalyze(
  parsed: Parsed,
  deps: AgentCliDeps,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const clipRelPath = parsed._[0];
  if (!clipRelPath) {
    errorLog("Usage: octupie-video-editor agent analyze <relative-clip-path> [--out DIR] [--model M] [--language L] [--allow-model-download] [--frames] [--json]");
    return 2;
  }
  const outFlag = str(parsed.flags, "out");
  const outDir = outFlag ? resolve(process.cwd(), outFlag) : defaultAnalysisOutDir(clipRelPath);
  const analyze = deps.analyze ?? analyzeSource;

  try {
    const res = await analyze({
      clipRelPath,
      outDir,
      ...(str(parsed.flags, "model") ? { model: str(parsed.flags, "model")! } : {}),
      ...(str(parsed.flags, "language") ? { language: str(parsed.flags, "language")! } : {}),
      allowModelDownload: parsed.flags["allow-model-download"] === true,
      includeFrames: parsed.flags["frames"] === true,
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (parsed.flags["json"] === true) {
      log(JSON.stringify({
        analysisPath: res.analysisPath,
        transcriptPath: res.transcriptPath,
        srtPath: res.srtPath,
        vttPath: res.vttPath,
        durationSeconds: res.analysis.durationSeconds,
        language: res.analysis.transcript.language,
        words: res.analysis.transcript.words.length,
        marks: res.analysis.marks.length,
        takes: res.analysis.takes.length,
        candidateHooks: res.analysis.candidateHooks.length,
        frames: res.analysis.frames?.length ?? 0,
      }, null, 2));
    } else {
      log(`analysis: ${res.analysisPath}`);
      log(`transcript: ${res.transcriptPath}`);
      log(`captions: ${res.srtPath}, ${res.vttPath}`);
      log(`language: ${res.analysis.transcript.language}, words: ${res.analysis.transcript.words.length}, marks: ${res.analysis.marks.length}, takes: ${res.analysis.takes.length}, hooks: ${res.analysis.candidateHooks.length}`);
      if (res.analysis.frames) log(`frames measured: ${res.analysis.frames.length}`);
    }
    return 0;
  } catch (err) {
    errorLog(`Analyze failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `agent understand <analysis.json> --provider claude` runs the restricted
 * multimodal interpretation: it reads an already-validated source-analysis
 * artifact plus its sampled frames and returns validated semantic findings
 * (facial expressions, crew prompts, weak takes, product proof, visual glitches,
 * B-roll relevance, hook moments). The analysis file and every frame must be
 * contained under the project output root (or `OVE_ANALYSIS_ROOT`); the output
 * stays under that root. It is the only path that hands frames to a model, and it
 * validates every result before writing.
 */
async function cmdUnderstand(
  parsed: Parsed,
  deps: AgentCliDeps,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const analysisPath = parsed._[0];
  if (!analysisPath) {
    errorLog("Usage: octupie-video-editor agent understand <analysis.json> --provider claude --allow-network --allow-media-upload [--out FILE] [--json]");
    return 2;
  }
  const providerId = str(parsed.flags, "provider");
  if (!providerId || !isUnderstandProviderId(providerId)) {
    errorLog(`--provider is required and must be one of: ${UNDERSTAND_PROVIDERS.join(", ")}`);
    return 2;
  }
  if (parsed.flags["allow-network"] !== true || parsed.flags["allow-media-upload"] !== true) {
    errorLog("Remote understanding requires both --allow-network and --allow-media-upload.");
    return 2;
  }
  const grantedAt = (deps.now ?? new Date()).toISOString();
  const permissionPolicy = createPolicy([
    { action: "network", grantedBy: "operator-cli", grantedAt, reason: "agent understand" },
    { action: "media-upload", grantedBy: "operator-cli", grantedAt, reason: "agent understand sampled frames" },
  ]);
  const understand = deps.understand ?? understandSource;

  try {
    const res = await understand({
      analysisPath,
      providerId,
      permissionPolicy,
      ...(str(parsed.flags, "out") ? { outFile: str(parsed.flags, "out")! } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    const u = res.understanding;
    if (parsed.flags["json"] === true) {
      log(JSON.stringify({
        understandingPath: res.understandingPath,
        frameDir: res.frameDir,
        frames: res.frameCount,
        provider: u.provider,
        durationSeconds: u.durationSeconds,
        findings: u.findings.length,
        segments: u.segments.length,
        limitations: u.limitations.length,
      }, null, 2));
    } else {
      log(`understanding: ${res.understandingPath}`);
      log(`provider: ${u.provider.id} (${u.provider.model})`);
      log(`frames: ${res.frameCount}, findings: ${u.findings.length}, segments: ${u.segments.length}`);
      log(`summary: ${u.summary}`);
    }
    return 0;
  } catch (err) {
    errorLog(`Understand failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `agent critique <plan.json> <master.mp4> --provider claude` samples the exact
 * already-rendered master, hands the sampled JPEG frames and plan intent to the
 * restricted Claude critique provider, and writes a validated, frame-anchored
 * critique artifact under the output root. Both `--allow-network` and
 * `--allow-media-upload` are required; without them nothing is sampled or spawned.
 * It never re-renders and never replaces human editorial approval.
 */
async function cmdCritique(
  parsed: Parsed,
  deps: AgentCliDeps,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const planPath = parsed._[0];
  const masterPath = parsed._[1];
  if (!planPath || !masterPath) {
    errorLog("Usage: octupie-video-editor agent critique <plan.json> <master.mp4> --provider claude --allow-network --allow-media-upload [--out FILE] [--json]");
    return 2;
  }
  if (str(parsed.flags, "provider") !== "claude") {
    errorLog("--provider is required and must be: claude");
    return 2;
  }
  if (parsed.flags["allow-network"] !== true || parsed.flags["allow-media-upload"] !== true) {
    errorLog("Remote critique requires both --allow-network and --allow-media-upload.");
    return 2;
  }

  let plan;
  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8"));
    const p = parseEditPlan(raw);
    if (!p.ok || !p.plan) {
      errorLog(`Invalid plan: ${planPath}`);
      for (const e of p.errors) errorLog(`  - ${e}`);
      return 2;
    }
    plan = p.plan;
  } catch (err) {
    errorLog(`Could not read plan: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const grantedAt = (deps.now ?? new Date()).toISOString();
  const permissionPolicy = createPolicy([
    { action: "network", grantedBy: "operator-cli", grantedAt, reason: "agent critique" },
    { action: "media-upload", grantedBy: "operator-cli", grantedAt, reason: "agent critique sampled frames" },
  ]);
  const critique = deps.critique ?? critiqueRenderedMaster;

  try {
    const res = await critique({
      plan,
      masterPath,
      permissionPolicy,
      ...(str(parsed.flags, "out") ? { outFile: str(parsed.flags, "out")! } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    const c = res.critique;
    const blockers = c.notes.filter((n) => n.severity === "blocker").length;
    if (parsed.flags["json"] === true) {
      log(JSON.stringify({
        critiquePath: res.critiquePath,
        master: c.master,
        durationSeconds: res.durationSeconds,
        frames: res.frameCount,
        provider: c.provider,
        approved: c.approved,
        blockers,
        notes: c.notes.length,
      }, null, 2));
    } else {
      log(`critique: ${res.critiquePath}`);
      log(`provider: ${c.provider.id} (${c.provider.model})`);
      log(`approved: ${c.approved}, blockers: ${blockers}, notes: ${c.notes.length}, frames: ${res.frameCount}`);
      log(`summary: ${c.summary}`);
    }
    return 0;
  } catch (err) {
    errorLog(`Critique failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `agent review <plan.json>` runs the bounded revision loop: render the exact
 * plan, critique the exact rendered master, and (if unapproved) ask for a
 * complete replacement plan that is re-validated against the edit-plan schema
 * before re-rendering. The loop is hard-capped by `--max-rounds` and escalates to
 * a human at the cap or on any invalid proposal rather than looping. Both
 * `--allow-network` and `--allow-media-upload` are required. Human sign-off is
 * never replaced.
 */
async function cmdReview(
  parsed: Parsed,
  deps: AgentCliDeps,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const planPath = parsed._[0];
  if (!planPath) {
    errorLog("Usage: octupie-video-editor agent review <plan.json> --allow-network --allow-media-upload [--max-rounds N] [--json]");
    return 2;
  }
  if (parsed.flags["allow-network"] !== true || parsed.flags["allow-media-upload"] !== true) {
    errorLog("Bounded review requires both --allow-network and --allow-media-upload.");
    return 2;
  }

  let plan;
  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8"));
    const p = parseEditPlan(raw);
    if (!p.ok || !p.plan) {
      errorLog(`Invalid plan: ${planPath}`);
      for (const e of p.errors) errorLog(`  - ${e}`);
      return 2;
    }
    plan = p.plan;
  } catch (err) {
    errorLog(`Could not read plan: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const maxRaw = str(parsed.flags, "max-rounds");
  const maxRounds = maxRaw !== undefined ? Number(maxRaw) : 2;
  if (!Number.isFinite(maxRounds)) {
    errorLog(`--max-rounds must be a number, got "${maxRaw}".`);
    return 2;
  }

  const grantedAt = (deps.now ?? new Date()).toISOString();
  const permissionPolicy = createPolicy([
    { action: "network", grantedBy: "operator-cli", grantedAt, reason: "agent review" },
    { action: "media-upload", grantedBy: "operator-cli", grantedAt, reason: "agent review sampled frames" },
  ]);
  const review = deps.review ?? reviewPlan;

  try {
    const res = await review({
      plan,
      maxRounds,
      permissionPolicy,
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (parsed.flags["json"] === true) {
      log(JSON.stringify({
        approved: res.approved,
        humanEscalation: res.humanEscalation,
        rounds: res.rounds,
        reason: res.reason,
        finalTitle: res.finalPlan.title,
      }, null, 2));
    } else {
      log(`review: ${res.approved ? "APPROVED" : "NOT APPROVED"} after ${res.rounds} round(s)`);
      log(`human escalation: ${res.humanEscalation}`);
      log(`reason: ${res.reason}`);
    }
    return 0;
  } catch (err) {
    errorLog(`Review failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Rights-cleared reference discovery. Local mode is offline; remote sources need an explicit network grant. */
async function cmdDiscoverAssets(
  parsed: Parsed,
  deps: AgentCliDeps,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const intent = str(parsed.flags, "intent")?.trim();
  if (!intent) {
    errorLog("Usage: octupie-video-editor agent discover-assets --intent TEXT [--source local,drive,web] [--asset-root PATH] [--max-results N] [--allow-network] [--json]");
    return 2;
  }

  const sourceRaw = str(parsed.flags, "source") ?? "local";
  const sources = sourceRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const invalid = sources.filter((s) => !(ASSET_SOURCE_KINDS as readonly string[]).includes(s));
  if (sources.length === 0 || invalid.length > 0) {
    errorLog(`--source must contain only: ${ASSET_SOURCE_KINDS.join(", ")}.`);
    return 2;
  }
  const typedSources = sources as AssetSourceKind[];
  const wantsRemote = typedSources.some((s) => s === "drive" || s === "web");
  if (wantsRemote && parsed.flags["allow-network"] !== true) {
    errorLog("Drive and web discovery require --allow-network. Local discovery remains offline.");
    return 2;
  }

  const maxRaw = str(parsed.flags, "max-results");
  const maxResults = maxRaw === undefined ? 20 : Number(maxRaw);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) {
    errorLog("--max-results must be an integer from 1 to 200.");
    return 2;
  }

  const now = deps.now ?? new Date();
  const permissionPolicy = createPolicy(
    wantsRemote
      ? [{ action: "network", grantedBy: "operator-cli", grantedAt: now.toISOString(), reason: "asset reference discovery" }]
      : [],
  );
  const assetRoot = resolve(process.cwd(), str(parsed.flags, "asset-root") ?? process.env.OVE_ASSET_ROOT ?? "assets");
  const discover = deps.discoverAssets ?? discoverAssets;

  try {
    const result = await discover({
      query: { intent, sources: typedSources, maxResults },
      assetRoot,
      permissionPolicy,
      now,
    });
    if (parsed.flags["json"] === true) {
      log(JSON.stringify(result, null, 2));
    } else {
      log(`asset discovery: ${result.candidates.length} rights-cleared candidate(s)`);
      for (const candidate of result.candidates) {
        log(`  ${candidate.source.padEnd(5)} ${candidate.relevance.toFixed(2)} ${candidate.ref} [${candidate.license.id}]`);
      }
      for (const diagnostic of result.diagnostics) {
        log(`  ${diagnostic.level.toUpperCase()} ${diagnostic.source}: ${diagnostic.message}`);
      }
    }
    return result.diagnostics.some((d) => d.level === "error") ? 1 : 0;
  } catch (err) {
    errorLog(`Asset discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `agent hook-variants <plan.json> --objective TEXT --count N` produces exactly N
 * distinct, renderer-ready, validated hook variants from a source plan. The
 * deterministic provider is offline; the Claude provider requires an explicit
 * `--allow-network` grant, checked before any model call. With `--out DIR` it
 * writes an atomic manifest plus one validated plan JSON per variant under a
 * contained directory. It never renders.
 */
async function cmdHookVariants(
  parsed: Parsed,
  deps: AgentCliDeps,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const planPath = parsed._[0];
  const objective = str(parsed.flags, "objective")?.trim();
  if (!planPath || !objective) {
    errorLog(
      "Usage: octupie-video-editor agent hook-variants <plan.json> --objective TEXT --count N [--provider deterministic|claude] [--transcript FILE | --transcript-text TEXT] [--allow-network] [--out DIR] [--json]",
    );
    return 2;
  }

  const countRaw = str(parsed.flags, "count");
  const count = countRaw === undefined ? NaN : Number(countRaw);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    errorLog("--count must be an integer from 1 to 10.");
    return 2;
  }

  const providerId = str(parsed.flags, "provider") ?? "deterministic";
  if (providerId !== "deterministic" && providerId !== "claude") {
    errorLog("--provider must be one of: deterministic, claude");
    return 2;
  }

  let plan;
  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8"));
    const p = parseEditPlan(raw);
    if (!p.ok || !p.plan) {
      errorLog(`Invalid plan: ${planPath}`);
      for (const e of p.errors) errorLog(`  - ${e}`);
      return 2;
    }
    plan = p.plan;
  } catch (err) {
    errorLog(`Could not read plan: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const inlineTranscript = str(parsed.flags, "transcript-text");
  const transcriptFile = str(parsed.flags, "transcript");
  let transcriptText = inlineTranscript;
  if (transcriptText === undefined && transcriptFile !== undefined) {
    try {
      transcriptText = readFileSync(resolve(process.cwd(), transcriptFile), "utf8");
      enforceMaxSize(transcriptText, MAX_SIZES.transcript, "transcript");
    } catch (err) {
      errorLog(`Could not read transcript: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (providerId === "claude" && parsed.flags["allow-network"] !== true) {
    errorLog("Claude hook variants require --allow-network. The deterministic provider works offline.");
    return 2;
  }

  const now = deps.now ?? new Date();
  const permissionPolicy = createPolicy(
    providerId === "claude"
      ? [{ action: "network", grantedBy: "operator-cli", grantedAt: now.toISOString(), reason: "hook variant generation" }]
      : [],
  );

  const outFlag = str(parsed.flags, "out");
  const produce = deps.produceHookVariants ?? produceHookVariants;

  try {
    const res = await produce({
      request: {
        objective,
        count,
        sourcePlan: plan,
        ...(transcriptText !== undefined ? { transcriptText } : {}),
      },
      providerId: providerId as HookProviderId,
      permissionPolicy,
      now,
      ...(outFlag ? { outputDir: resolve(process.cwd(), outFlag) } : {}),
    });
    if (parsed.flags["json"] === true) {
      log(JSON.stringify({
        set: res.set,
        ...(res.outDir ? { outDir: res.outDir } : {}),
        ...(res.manifestPath ? { manifestPath: res.manifestPath } : {}),
        ...(res.planPaths ? { planPaths: res.planPaths } : {}),
      }, null, 2));
    } else {
      log(`hook variants: ${res.set.variants.length} of ${res.set.count} (provider ${res.set.provider.id})`);
      for (const v of res.set.variants) {
        log(`  ${v.id} [${v.strategy}] ${v.hookText}`);
      }
      if (res.manifestPath) log(`manifest: ${res.manifestPath}`);
    }
    return 0;
  } catch (err) {
    errorLog(`Hook variants failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** The ONLY source of a Hermes token. It is never a CLI flag and never printed. */
const HERMES_TOKEN_ENV = "OCTUPIE_HERMES_API_KEY";
/** Flags that would smuggle a token onto argv. Rejected outright. */
const HERMES_TOKEN_FLAGS = ["api-key", "apikey", "token", "key", "bearer"];

interface HermesGate {
  ok: boolean;
  code: number;
  token?: string;
  endpoint?: string;
}

/**
 * Shared pre-flight for the Hermes commands: an endpoint, an explicit
 * `--allow-network` grant, and a token that comes ONLY from the environment. Any
 * missing gate is a usage/config failure (exit 2) BEFORE any fetch. The token is
 * never echoed, even on error.
 */
function hermesGate(
  parsed: Parsed,
  deps: AgentCliDeps,
  errorLog: (s: string) => void,
  usageLine: string,
): HermesGate {
  const endpoint = str(parsed.flags, "endpoint")?.trim();
  if (!endpoint) {
    errorLog(usageLine);
    return { ok: false, code: 2 };
  }
  // A token must never be passed as a flag.
  for (const f of HERMES_TOKEN_FLAGS) {
    if (parsed.flags[f] !== undefined) {
      errorLog(`The Hermes token must not be passed as a flag. Set the ${HERMES_TOKEN_ENV} environment variable instead.`);
      return { ok: false, code: 2 };
    }
  }
  if (parsed.flags["allow-network"] !== true) {
    errorLog("Hermes requires an explicit --allow-network grant. Standalone offline operation is the default.");
    return { ok: false, code: 2 };
  }
  const env = deps.env ?? process.env;
  const token = env[HERMES_TOKEN_ENV]?.trim();
  if (!token) {
    errorLog(`No Hermes token found. Set the ${HERMES_TOKEN_ENV} environment variable (it is never accepted as a flag).`);
    return { ok: false, code: 2 };
  }
  return { ok: true, code: 0, token, endpoint };
}

/**
 * `agent hermes-check --endpoint URL` proves an authenticated Hermes API Server
 * is reachable via `GET /v1/capabilities`. Requires `--allow-network` and the
 * token env. Never prints the token. Standalone offline operation is unaffected.
 */
async function cmdHermesCheck(
  parsed: Parsed,
  deps: AgentCliDeps,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const usageLine = `Usage: octupie-video-editor agent hermes-check --endpoint URL [--model NAME] --allow-network [--json]  (token via ${HERMES_TOKEN_ENV})`;
  const gate = hermesGate(parsed, deps, errorLog, usageLine);
  if (!gate.ok) return gate.code;

  const now = deps.now ?? new Date();
  const permissionPolicy = createPolicy([
    { action: "network", grantedBy: "operator-cli", grantedAt: now.toISOString(), reason: "hermes capability check" },
  ]);
  const connect = deps.hermesConnect ?? connectHermes;

  try {
    const connection = await connect({
      config: {
        surface: "api",
        baseUrl: gate.endpoint!,
        apiKey: gate.token!,
        ...(str(parsed.flags, "model") ? { model: str(parsed.flags, "model")! } : {}),
      },
      policy: permissionPolicy,
      ...(deps.hermesFetch ? { deps: { fetch: deps.hermesFetch } } : {}),
      now,
    });
    if (parsed.flags["json"] === true) {
      log(JSON.stringify(connection, null, 2));
    } else {
      log(`hermes: official surface reachable at ${connection.baseUrl}`);
      log(`  platform: ${connection.platform}${connection.model ? " (model " + connection.model + ")" : ""}`);
      log(`  auth: ${connection.auth.type} (required: ${connection.auth.required})`);
      log(`  standalonePreserved: ${connection.standalonePreserved}  officialSurface: ${connection.officialSurface}`);
    }
    return 0;
  } catch (err) {
    // The token never appears in a client error; still, never widen the message.
    errorLog(`Hermes check failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `agent hermes-orchestrate --endpoint URL --objective TEXT --stage NAME` asks the
 * Hermes API Server for bounded, DATA-ONLY guidance via `POST /v1/chat/completions`.
 * Requires `--allow-network` and the token env. Output is data only and never
 * executed. Never prints the token.
 */
async function cmdHermesOrchestrate(
  parsed: Parsed,
  deps: AgentCliDeps,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const usageLine = `Usage: octupie-video-editor agent hermes-orchestrate --endpoint URL --objective TEXT --stage NAME [--context-file PATH] [--model NAME] --allow-network [--json]  (token via ${HERMES_TOKEN_ENV})`;

  const objective = str(parsed.flags, "objective")?.trim();
  const stage = str(parsed.flags, "stage")?.trim();
  if (!objective || !stage) {
    // Fall through to the shared gate so a bare invocation prints the full usage.
    if (!str(parsed.flags, "endpoint")) {
      errorLog(usageLine);
      return 2;
    }
    errorLog(usageLine);
    return 2;
  }

  const gate = hermesGate(parsed, deps, errorLog, usageLine);
  if (!gate.ok) return gate.code;

  let contextText: string | undefined;
  const contextFile = str(parsed.flags, "context-file");
  if (contextFile !== undefined) {
    try {
      contextText = readFileSync(resolve(process.cwd(), contextFile), "utf8");
      enforceMaxSize(contextText, MAX_SIZES.transcript, "context");
    } catch (err) {
      errorLog(`Could not read context file: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  const now = deps.now ?? new Date();
  const permissionPolicy = createPolicy([
    { action: "network", grantedBy: "operator-cli", grantedAt: now.toISOString(), reason: "hermes orchestration" },
  ]);
  const orchestrate = deps.hermesOrchestrate ?? orchestrateHermes;

  try {
    const result = await orchestrate({
      config: {
        surface: "api",
        baseUrl: gate.endpoint!,
        apiKey: gate.token!,
        ...(str(parsed.flags, "model") ? { model: str(parsed.flags, "model")! } : {}),
      },
      request: {
        objective,
        workflowStage: stage,
        ...(contextText !== undefined ? { contextText } : {}),
      },
      policy: permissionPolicy,
      ...(deps.hermesFetch ? { deps: { fetch: deps.hermesFetch } } : {}),
      now,
    });
    if (parsed.flags["json"] === true) {
      log(JSON.stringify(result, null, 2));
    } else {
      log(`hermes orchestration (model ${result.model}):`);
      log(`  summary: ${result.data.summary}`);
      log(`  recommendedNextStep: ${result.data.recommendedNextStep}`);
      for (const a of result.data.orderedActions) log(`  action: ${a}`);
      for (const w of result.data.warnings) log(`  warning: ${w}`);
      log(`  requiresHumanApproval: ${result.data.requiresHumanApproval}`);
    }
    return 0;
  } catch (err) {
    errorLog(`Hermes orchestration failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** The only source of a code-change grant is the explicit `--allow-code-change` flag. */
function readJsonFile(path: string, label: string): { ok: true; json: unknown } | { ok: false; message: string } {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), path), "utf8");
  } catch (err) {
    return { ok: false, message: `Could not read ${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw.length > 8 * 1024 * 1024) return { ok: false, message: `${label} is too large.` };
  try {
    return { ok: true, json: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, message: `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * A shell:false test runner for improvement apply. It tokenizes each already
 * allowlisted command into an explicit argv and runs it with no shell, so no test
 * string is ever interpreted by a command line. Never used by the core engine.
 */
function cliImprovementTestRunner(exec: ExecFn, cwd: string): TestRunner {
  return async (command) => {
    const argv = testCommandArgv(command);
    const bin = process.platform === "win32" ? `${argv[0]}.cmd` : argv[0]!;
    const res = await exec(bin, argv.slice(1), { cwd, timeoutMs: 600_000 });
    const ok = res.spawnError === undefined && !res.timedOut && res.code === 0;
    const detail = ok
      ? "passed"
      : res.spawnError
        ? `spawn error: ${res.spawnError}`
        : res.timedOut
          ? "timed out"
          : `exit ${res.code}`;
    return { command, ok, detail };
  };
}

/**
 * `agent improvement-apply PROPOSAL.json --decision DECISION.json --allow-code-change`
 * applies a reviewed proposal only with an explicit matching approval decision and
 * an explicit `--allow-code-change` grant, checked before any write. Every operation
 * is preflighted; on any write or test failure the touched files are restored and the
 * proposal is marked failed. Audit and exact backups are written under the state root.
 */
async function cmdImprovementApply(
  parsed: Parsed,
  deps: AgentCliDeps,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const proposalPath = parsed._[0];
  const decisionPath = str(parsed.flags, "decision");
  if (!proposalPath || !decisionPath) {
    errorLog("Usage: octupie-video-editor agent improvement-apply PROPOSAL.json --decision DECISION.json --allow-code-change [--state-root PATH] [--json]");
    return 2;
  }
  if (parsed.flags["allow-code-change"] !== true) {
    errorLog("Applying an improvement requires the explicit --allow-code-change grant. There is no apply path without it.");
    return 2;
  }

  const proposal = readJsonFile(proposalPath, "proposal");
  if (!proposal.ok) {
    errorLog(proposal.message);
    return 2;
  }
  const decision = readJsonFile(decisionPath, "decision");
  if (!decision.ok) {
    errorLog(decision.message);
    return 2;
  }

  const now = deps.now ?? new Date();
  const policy = createPolicy([
    { action: "code-change", grantedBy: "operator-cli", grantedAt: now.toISOString(), reason: "improvement apply" },
  ]);
  const stateRoot = resolve(process.cwd(), str(parsed.flags, "state-root") ?? "output/improvements");
  const apply = deps.applyImprovement ?? applyProposal;
  const testRunner = deps.improvementTestRunner ?? cliImprovementTestRunner(deps.exec ?? execProcess, process.cwd());

  try {
    const result = await apply({ proposal: proposal.json, decision: decision.json, policy, testRunner, stateRoot, now });
    if (parsed.flags["json"] === true) {
      log(JSON.stringify(result, null, 2));
    } else {
      log(`improvement-apply: ${result.status} (rolledBack=${result.rolledBack})`);
      for (const op of result.operations) log(`  ${op.path}  ${op.beforeSha256.slice(0, 12)} -> ${op.afterSha256.slice(0, 12)}`);
      for (const t of result.tests) log(`  test ${t.ok ? "PASS" : "FAIL"} ${t.command}${t.ok ? "" : " (" + t.detail + ")"}`);
      if (result.auditPath) log(`audit: ${result.auditPath}`);
      if (result.failure) log(`failure: ${result.failure}`);
    }
    return result.status === "applied" ? 0 : 1;
  } catch (err) {
    if (err instanceof ImprovementGateError || err instanceof PermissionDeniedError) {
      errorLog(`improvement-apply blocked: ${err.message}`);
      return 2;
    }
    errorLog(`improvement-apply failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `agent improvement-rollback PROPOSAL.json --decision DECISION.json --allow-code-change`
 * restores an applied proposal's exact prior bytes. It needs a matching rollback-action
 * approval decision, an explicit `--allow-code-change` grant, and a prior applied audit
 * record that passes its integrity check. It refuses a tampered audit or a changed file.
 */
async function cmdImprovementRollback(
  parsed: Parsed,
  deps: AgentCliDeps,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const proposalPath = parsed._[0];
  const decisionPath = str(parsed.flags, "decision");
  if (!proposalPath || !decisionPath) {
    errorLog("Usage: octupie-video-editor agent improvement-rollback PROPOSAL.json --decision DECISION.json --allow-code-change [--state-root PATH] [--json]");
    return 2;
  }
  if (parsed.flags["allow-code-change"] !== true) {
    errorLog("Rolling back an improvement requires the explicit --allow-code-change grant.");
    return 2;
  }

  const proposal = readJsonFile(proposalPath, "proposal");
  if (!proposal.ok) {
    errorLog(proposal.message);
    return 2;
  }
  const decision = readJsonFile(decisionPath, "decision");
  if (!decision.ok) {
    errorLog(decision.message);
    return 2;
  }

  const now = deps.now ?? new Date();
  const policy = createPolicy([
    { action: "code-change", grantedBy: "operator-cli", grantedAt: now.toISOString(), reason: "improvement rollback" },
  ]);
  const stateRoot = resolve(process.cwd(), str(parsed.flags, "state-root") ?? "output/improvements");
  const rollback = deps.rollbackImprovement ?? rollbackProposal;

  try {
    const result = await rollback({ proposal: proposal.json, decision: decision.json, policy, stateRoot, now });
    if (parsed.flags["json"] === true) {
      log(JSON.stringify(result, null, 2));
    } else {
      log(`improvement-rollback: ${result.status} (alreadyRolledBack=${result.alreadyRolledBack})`);
      for (const op of result.operations) log(`  ${op.path}  restored ${op.restoredSha256.slice(0, 12)}`);
      if (result.auditPath) log(`audit: ${result.auditPath}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof ImprovementGateError || err instanceof PermissionDeniedError) {
      errorLog(`improvement-rollback blocked: ${err.message}`);
      return 2;
    }
    errorLog(`improvement-rollback failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `agent workflow-authorize ROLE ACTION` reports the pure, default-deny RBAC
 * decision for a (role, action) pair. Exit 0 when allowed, 1 when denied, 2 for an
 * unknown role or action (a usage error). It never touches the filesystem.
 */
function cmdWorkflowAuthorize(
  parsed: Parsed,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): number {
  const role = parsed._[0];
  const action = parsed._[1];
  if (!role || !action) {
    errorLog(`Usage: octupie-video-editor agent workflow-authorize ROLE ACTION  (roles: ${WORKFLOW_ROLES.join(", ")}; actions: ${WORKFLOW_ACTIONS.join(", ")})`);
    return 2;
  }
  if (!isWorkflowRole(role)) {
    errorLog(`Unknown role '${role}'. Known roles: ${WORKFLOW_ROLES.join(", ")}.`);
    return 2;
  }
  if (!isWorkflowAction(action)) {
    errorLog(`Unknown action '${action}'. Known actions: ${WORKFLOW_ACTIONS.join(", ")}.`);
    return 2;
  }
  const allowed = authorize(role, action);
  log(`${allowed ? "ALLOW" : "DENY"} ${role} ${action}`);
  return allowed ? 0 : 1;
}

/**
 * `agent workflow-publish REQUEST.json --allow-publish` runs the gated publish flow
 * with injectable dependencies. Publishing is disabled by default: without
 * `--allow-publish` there is no publishing grant, and the default adapter is the
 * disabled one, so a publish always blocks. Exit 0 only on a real published result;
 * 1 on a blocked or failed attempt; 2 on a usage or input error.
 */
async function cmdWorkflowPublish(
  parsed: Parsed,
  deps: AgentCliDeps,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): Promise<number> {
  const requestPath = parsed._[0];
  if (!requestPath) {
    errorLog("Usage: octupie-video-editor agent workflow-publish REQUEST.json --allow-publish [--state-root PATH] [--project-root PATH] [--json]");
    return 2;
  }
  if (parsed.flags["allow-publish"] !== true) {
    errorLog("Publishing requires the explicit --allow-publish grant. It is disabled by default and there is no publish path without it.");
    return 2;
  }

  const request = readJsonFile(requestPath, "publish request");
  if (!request.ok) {
    errorLog(request.message);
    return 2;
  }

  const now = deps.now ?? new Date();
  const policy = createPolicy([
    { action: "publishing", grantedBy: "operator-cli", grantedAt: now.toISOString(), reason: "workflow publish" },
  ]);
  const stateRoot = resolve(process.cwd(), str(parsed.flags, "state-root") ?? "output/workflow");
  const projectRoot = resolve(process.cwd(), str(parsed.flags, "project-root") ?? ".");
  const adapter = deps.publishingAdapter ?? disabledPublishingAdapter;
  const publishFn = deps.publishWorkflow ?? workflowPublish;

  try {
    const result = await publishFn({
      request: request.json,
      store: { stateRoot, projectRoot, now },
      policy,
      adapter,
      now,
    });
    if (parsed.flags["json"] === true) {
      log(JSON.stringify(result, null, 2));
    } else {
      log(`workflow-publish: ${result.status}${result.gate ? ` (gate ${result.gate})` : ""}`);
      log(`  ${result.reason}`);
      if (result.receiptPath) log(`  receipt: ${result.receiptPath}`);
      if (result.publishedVersionId) log(`  published version: ${result.publishedVersionId}`);
    }
    return result.status === "published" ? 0 : 1;
  } catch (err) {
    errorLog(`workflow-publish failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function cmdFeedback(
  flags: Record<string, string | boolean>,
  deps: AgentCliDeps,
  home: string,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): number {
  const scope = str(flags, "scope");
  const rule = str(flags, "rule");
  if (!scope || !rule) {
    errorLog("Usage: octupie-video-editor agent feedback --run ID --scope SCOPE --rule TEXT [--creator X] [--series X] [--project X]");
    return 2;
  }
  if (!(RULE_SCOPES as readonly string[]).includes(scope)) {
    errorLog(`Unknown scope '${scope}'. Use one of: ${RULE_SCOPES.join(", ")}`);
    return 2;
  }
  try {
    const result = addFeedbackRule(home, {
      scope: scope as RuleScope,
      text: rule,
      ...(str(flags, "creator") ? { creator: str(flags, "creator")! } : {}),
      ...(str(flags, "series") ? { series: str(flags, "series")! } : {}),
      ...(str(flags, "project") ? { project: str(flags, "project")! } : {}),
      ...(str(flags, "run") ? { sourceRun: str(flags, "run")! } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (result.added) log(`saved rule ${result.rule!.id} (${scope})`);
    else log(`already active, no change: ${result.rule!.id}`);
    return 0;
  } catch (err) {
    errorLog(`Feedback error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

function cmdRules(
  flags: Record<string, string | boolean>,
  home: string,
  log: (s: string) => void,
): number {
  const scope = str(flags, "scope");
  const rules = listRules(home, scope ? { scope: scope as RuleScope } : {});
  if (rules.length === 0) {
    log("No rules.");
    return 0;
  }
  for (const r of rules) {
    const sel = [r.creator && `creator=${r.creator}`, r.series && `series=${r.series}`, r.project && `project=${r.project}`]
      .filter(Boolean)
      .join(" ");
    log(`${r.active ? "[on] " : "[off]"} ${r.id}  ${r.scope}${sel ? " " + sel : ""}  ${r.text}`);
  }
  return 0;
}

function cmdDeactivate(
  flags: Record<string, string | boolean>,
  deps: AgentCliDeps,
  home: string,
  log: (s: string) => void,
  errorLog: (s: string) => void,
): number {
  const id = str(flags, "rule");
  if (!id) {
    errorLog("Usage: octupie-video-editor agent deactivate --rule ID");
    return 2;
  }
  const res = deactivateRule(home, id, deps.now ?? new Date());
  if (res.ok) {
    log(`deactivated ${id}`);
    return 0;
  }
  errorLog(`No such rule: ${id}`);
  return 1;
}

function usage(log: (s: string) => void): void {
  log("octupie-video-editor agent <subcommand>");
  log("");
  log("Subcommands:");
  log("  providers                                   Show provider availability and auth.");
  log("  capabilities [--json] [--probe]             Show parity capability status, permissions, gates.");
  log("  analyze <rel-clip> [--out DIR] [--model M]  Local transcription + editorial source analysis.");
  log("      [--language L] [--allow-model-download] [--frames] [--json]");
  log("  understand <analysis.json> --provider claude Multimodal semantic interpretation of sampled frames.");
  log("      [--out FILE] [--json]");
  log("  critique <plan.json> <master.mp4>           Frame-anchored critique of the rendered master.");
  log("      --provider claude --allow-network --allow-media-upload [--out FILE] [--json]");
  log("  review <plan.json>                          Bounded render/critique/revise loop; escalates at the cap.");
  log("      --allow-network --allow-media-upload [--max-rounds N] [--json]");
  log("  discover-assets --intent TEXT               Rights-cleared local, Drive, or web references.");
  log("      [--source local,drive,web] [--asset-root PATH] [--max-results N] [--allow-network] [--json]");
  log("  hook-variants <plan.json> --objective TEXT  Exactly N distinct renderer-ready hook plans.");
  log("      --count N [--provider deterministic|claude] [--transcript FILE | --transcript-text TEXT]");
  log("      [--allow-network] [--out DIR] [--json]");
  log("  hermes-check --endpoint URL                 Prove an authenticated Hermes API Server (optional).");
  log(`      [--model NAME] --allow-network [--json]  (token via ${HERMES_TOKEN_ENV}; default ${HERMES_DEFAULT_BASE_URL})`);
  log("  hermes-orchestrate --endpoint URL           DATA-ONLY guidance from the Hermes API Server (optional).");
  log("      --objective TEXT --stage NAME [--context-file PATH] [--model NAME] --allow-network [--json]");
  log("  improvement-apply PROPOSAL.json             Apply a reviewed proposal after explicit approval.");
  log("      --decision DECISION.json --allow-code-change [--state-root PATH] [--json]");
  log("  improvement-rollback PROPOSAL.json          Restore an applied proposal's exact prior bytes.");
  log("      --decision DECISION.json --allow-code-change [--state-root PATH] [--json]");
  log("  workflow-authorize ROLE ACTION              Pure default-deny RBAC decision (exit 0 allow, 1 deny).");
  log("  workflow-publish REQUEST.json               Gated publish; disabled by default, needs --allow-publish.");
  log("      --allow-publish [--state-root PATH] [--project-root PATH] [--json]");
  log("  run <brief.json> [--provider id]            Plan (and optionally render) from a brief.");
  log("      [--max-iterations N] [--no-render]");
  log("  feedback --run ID --scope SCOPE --rule TEXT Save an explicit human correction.");
  log("      [--creator X] [--series X] [--project X]");
  log("  rules [--scope SCOPE]                        List learned rules.");
  log("  deactivate --rule ID                         Deactivate a learned rule.");
  log("");
  log("Providers: deterministic, claude-cli, codex-cli");
}

function defaultTranscriptLoader(path: string): string {
  const abs = resolveExistingAssetPath(path, `transcript '${path}'`);
  return readFileSync(abs, "utf8");
}

/** Real FFprobe-backed clip prober for the asset manifest. */
async function defaultProber(id: string, path: string): Promise<ClipProbe> {
  try {
    const abs = resolveExistingAssetPath(path, `source clip '${id}'`);
    const p = await ffprobe(abs);
    const v = videoStream(p);
    const a = audioStream(p);
    const dur = Number(p.format.duration);
    return {
      ok: true,
      ...(Number.isFinite(dur) ? { durationSeconds: dur } : {}),
      ...(v?.width ? { width: v.width } : {}),
      ...(v?.height ? { height: v.height } : {}),
      hasAudio: !!a,
      ...(v?.codec_name ? { codec: v.codec_name } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
