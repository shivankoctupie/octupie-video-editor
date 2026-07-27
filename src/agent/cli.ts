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
import { loadAcceptanceManifest } from "../capabilities/acceptance.js";
import { PERMISSION_ACTIONS } from "../permissions/policy.js";

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
      return cmdCapabilities(flags, log);
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
  log: (s: string) => void,
): Promise<number> {
  const diags = await diagnoseCapabilities();
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
  log("  capabilities [--json]                       Show parity capability status, permissions, gates.");
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
