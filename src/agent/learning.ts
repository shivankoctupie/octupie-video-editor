/**
 * Persistent learning store.
 *
 * Human feedback and run records live outside the repository under
 * OVE_AGENT_HOME (default `~/.octupie-video-editor`). The rule log is
 * append-only JSONL of versioned, timestamped, hashed events; deactivation is a
 * tombstone event, never an in-place edit, so the history is auditable. Only
 * explicit human feedback ever becomes a durable rule. Model critiques and
 * failed runs are recorded as run history but never as rules, and nothing in
 * this store can rewrite the agent's source or prompts.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sha256String } from "../util/hash.js";
import { MAX_SIZES, enforceMaxSize } from "./redact.js";

export type RuleScope = "global" | "creator" | "series" | "project";
export const RULE_SCOPES: readonly RuleScope[] = ["global", "creator", "series", "project"];

export interface Rule {
  v: 1;
  id: string;
  createdAt: string;
  scope: RuleScope;
  text: string;
  hash: string;
  creator?: string;
  series?: string;
  project?: string;
  active: boolean;
}

export interface RuleSelectors {
  creator?: string;
  series?: string;
  project?: string;
}

/** Absolute path of the configured agent home. Defaults outside the repo. */
export function agentHome(): string {
  const dir = process.env.OVE_AGENT_HOME?.trim();
  if (dir) return resolve(dir);
  return join(homedir(), ".octupie-video-editor");
}

function rulesLogPath(home: string): string {
  return join(home, "rules.jsonl");
}

function runsIndexPath(home: string): string {
  return join(home, "runs", "index.jsonl");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function computeRuleId(scope: RuleScope, text: string, sel: RuleSelectors): string {
  const key = [scope, sel.creator ?? "", sel.series ?? "", sel.project ?? "", normalize(text).toLowerCase()].join("|");
  return "rule_" + sha256String(key).slice(0, 24);
}

interface RuleEvent {
  v: 1;
  type: "rule";
  id: string;
  createdAt: string;
  scope: RuleScope;
  text: string;
  hash: string;
  creator?: string;
  series?: string;
  project?: string;
  sourceRun?: string;
}

interface DeactivateEvent {
  v: 1;
  type: "deactivate";
  id: string;
  at: string;
}

type LogEvent = RuleEvent | DeactivateEvent;

function readLog(home: string): LogEvent[] {
  const path = rulesLogPath(home);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogEvent);
}

function appendLog(home: string, event: LogEvent): void {
  ensureDir(home);
  appendFileSync(rulesLogPath(home), JSON.stringify(event) + "\n", "utf8");
}

/** Fold the append-only log into current rule state. */
function foldRules(home: string): Map<string, Rule> {
  const rules = new Map<string, Rule>();
  for (const ev of readLog(home)) {
    if (ev.type === "rule") {
      rules.set(ev.id, {
        v: 1,
        id: ev.id,
        createdAt: ev.createdAt,
        scope: ev.scope,
        text: ev.text,
        hash: ev.hash,
        ...(ev.creator ? { creator: ev.creator } : {}),
        ...(ev.series ? { series: ev.series } : {}),
        ...(ev.project ? { project: ev.project } : {}),
        active: true,
      });
    } else if (ev.type === "deactivate") {
      const existing = rules.get(ev.id);
      if (existing) existing.active = false;
    }
  }
  return rules;
}

export interface AddRuleInput {
  scope: RuleScope;
  text: string;
  creator?: string;
  series?: string;
  project?: string;
  /** Run id this correction came from, kept as provenance (not part of identity). */
  sourceRun?: string;
  now?: Date;
}

export interface AddRuleResult {
  added: boolean;
  rule?: Rule;
}

/** Save an explicit human correction. The only path that creates a rule. */
export function addFeedbackRule(home: string, input: AddRuleInput): AddRuleResult {
  if (!RULE_SCOPES.includes(input.scope)) {
    throw new Error(`Unknown scope '${input.scope}'. Use one of: ${RULE_SCOPES.join(", ")}`);
  }
  const text = normalize(input.text);
  if (text.length === 0) throw new Error("rule text must not be empty");
  enforceMaxSize(text, MAX_SIZES.rule, "rule");

  const sel: RuleSelectors = {
    ...(input.creator ? { creator: input.creator } : {}),
    ...(input.series ? { series: input.series } : {}),
    ...(input.project ? { project: input.project } : {}),
  };
  if (input.scope !== "global" && sel[input.scope] === undefined) {
    throw new Error(`scope '${input.scope}' requires a --${input.scope} selector`);
  }

  const id = computeRuleId(input.scope, text, sel);
  const state = foldRules(home);
  const existing = state.get(id);
  if (existing && existing.active) {
    return { added: false, rule: existing };
  }

  const createdAt = (input.now ?? new Date()).toISOString();
  const hash = sha256String(JSON.stringify({ scope: input.scope, text, ...sel }));
  const event: RuleEvent = {
    v: 1,
    type: "rule",
    id,
    createdAt,
    scope: input.scope,
    text,
    hash,
    ...sel,
    ...(input.sourceRun ? { sourceRun: input.sourceRun } : {}),
  };
  appendLog(home, event);
  return { added: true, rule: { ...event, active: true } as Rule };
}

export function listRules(home: string, filter: { scope?: RuleScope } = {}): Rule[] {
  const rules = [...foldRules(home).values()];
  return filter.scope ? rules.filter((r) => r.scope === filter.scope) : rules;
}

export interface DeactivateResult {
  ok: boolean;
}

export function deactivateRule(home: string, id: string, now: Date = new Date()): DeactivateResult {
  const state = foldRules(home);
  if (!state.has(id)) return { ok: false };
  appendLog(home, { v: 1, type: "deactivate", id, at: now.toISOString() });
  return { ok: true };
}

export interface ApplicableRule {
  id: string;
  text: string;
  scope: RuleScope;
}

/** Load only active rules that apply to the given run selectors. */
export function loadApplicableRules(home: string, sel: RuleSelectors): ApplicableRule[] {
  const out: ApplicableRule[] = [];
  for (const rule of foldRules(home).values()) {
    if (!rule.active) continue;
    let applies = false;
    if (rule.scope === "global") applies = true;
    else if (rule.scope === "creator") applies = !!sel.creator && rule.creator === sel.creator;
    else if (rule.scope === "series") applies = !!sel.series && rule.series === sel.series;
    else if (rule.scope === "project") applies = !!sel.project && rule.project === sel.project;
    if (applies) out.push({ id: rule.id, text: rule.text, scope: rule.scope });
  }
  return out;
}

export interface RunRecordInput {
  runId: string;
  provider: string;
  status: string;
  iterations: number;
  planValid: boolean;
  now?: Date;
}

export interface RunRecord {
  v: 1;
  type: "run";
  runId: string;
  at: string;
  provider: string;
  status: string;
  iterations: number;
  planValid: boolean;
  hash: string;
}

export function recordRun(home: string, input: RunRecordInput): RunRecord {
  ensureDir(join(home, "runs"));
  const at = (input.now ?? new Date()).toISOString();
  const body = {
    runId: input.runId,
    provider: input.provider,
    status: input.status,
    iterations: input.iterations,
    planValid: input.planValid,
    at,
  };
  const hash = sha256String(JSON.stringify(body));
  const record: RunRecord = { v: 1, type: "run", ...body, hash };
  appendFileSync(runsIndexPath(home), JSON.stringify(record) + "\n", "utf8");
  return record;
}

export function readRunRecords(home: string): RunRecord[] {
  const path = runsIndexPath(home);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunRecord);
}
