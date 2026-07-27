/**
 * Audit writer.
 *
 * Every run leaves a self-describing directory: the sanitized brief, the text
 * asset manifest, each iteration's prompt (or its hash), the raw model replies
 * (already redacted), the validated plan and critique per iteration, the
 * selected final plan, provider metadata, the active rule ids, render and QA
 * paths when enabled, and any failure detail. It never copies source media or
 * credentials. Files are written atomically (temp + rename) so a crashed run
 * cannot leave a half-written artifact that reads as complete.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBrief } from "./brief.js";
import type { AssetManifest } from "./manifest.js";
import type { IterationRecord } from "./planner.js";
import type { ApplicableRule } from "./learning.js";
import type { EditPlan } from "../schema/editPlan.js";
import { redactSecrets } from "./redact.js";

export interface RenderRecord {
  finalPath: string;
  qaReportPath: string;
  pass: boolean;
}

export interface AuditBundle {
  runId: string;
  runDir: string;
  createdAt: string;
  brief: AgentBrief;
  manifest: AssetManifest;
  manifestText: string;
  transcriptIncluded: boolean;
  providerId: string;
  activeRules: ApplicableRule[];
  iterations: IterationRecord[];
  finalPlan: EditPlan | null;
  usedFallback: boolean;
  accepted: boolean;
  status: string;
  failure?: string;
  render?: RenderRecord | null;
}

/** Write text to `path` atomically: write a sibling temp file, then rename. */
export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function atomicJson(path: string, value: unknown): void {
  atomicWrite(path, redactSecrets(JSON.stringify(value, null, 2)) + "\n");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function writeRunAudit(bundle: AuditBundle): void {
  const dir = bundle.runDir;
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "iterations"), { recursive: true });

  // Sanitized brief: redact any secret a human may have pasted into free text.
  atomicWrite(join(dir, "brief.sanitized.json"), redactSecrets(JSON.stringify(bundle.brief, null, 2)) + "\n");

  atomicWrite(join(dir, "asset-manifest.txt"), redactSecrets(bundle.manifestText) + "\n");
  atomicJson(join(dir, "asset-manifest.json"), bundle.manifest);

  atomicJson(join(dir, "provider.json"), {
    id: bundle.providerId,
    createdAt: bundle.createdAt,
    iterations: bundle.iterations.length,
    usedFallback: bundle.usedFallback,
    accepted: bundle.accepted,
  });

  atomicJson(join(dir, "rules.json"), {
    activeRuleIds: bundle.activeRules.map((r) => r.id),
    rules: bundle.activeRules,
  });

  bundle.iterations.forEach((rec) => {
    atomicJson(join(dir, "iterations", `iteration-${pad(rec.index)}.json`), rec);
  });

  if (bundle.finalPlan) {
    atomicJson(join(dir, "final-plan.json"), bundle.finalPlan);
  }

  atomicJson(join(dir, "result.json"), {
    runId: bundle.runId,
    createdAt: bundle.createdAt,
    provider: bundle.providerId,
    status: bundle.status,
    accepted: bundle.accepted,
    usedFallback: bundle.usedFallback,
    iterations: bundle.iterations.length,
    activeRuleIds: bundle.activeRules.map((r) => r.id),
    transcriptIncluded: bundle.transcriptIncluded,
    ...(bundle.render ? { render: bundle.render } : {}),
    ...(bundle.failure ? { failure: bundle.failure } : {}),
  });
}
