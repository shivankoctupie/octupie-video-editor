/**
 * Top-level agent run orchestration.
 *
 * Connects a validated brief, its transcript text, the FFprobe-derived asset
 * manifest, the applicable scoped human rules, and the bounded planner loop,
 * then writes the audit directory and appends a run record. Rendering is
 * optional and injectable; the deterministic pipeline is loaded lazily so an
 * offline no-render run never pulls the renderer. This layer is a bounded
 * editorial decision agent: it selects and validates data, then hands a proven
 * plan to deterministic rendering. Human QA of the final master remains required.
 */

import { join } from "node:path";
import type { AgentBrief } from "./brief.js";
import type { Provider } from "./providers/types.js";
import type { EditPlan } from "../schema/editPlan.js";
import { buildAssetManifest, renderManifestText, type ClipProbe } from "./manifest.js";
import { loadApplicableRules, recordRun } from "./learning.js";
import { runPlannerLoop } from "./planner.js";
import { writeRunAudit, type RenderRecord } from "./audit.js";
import { buildJsonSchema } from "../schema/generate.js";
import { sha256String } from "../util/hash.js";
import { enforceMaxSize, MAX_SIZES } from "./redact.js";

export interface AgentRunInput {
  brief: AgentBrief;
  provider: Provider;
  home: string;
  maxIterations?: number;
  render?: boolean;
  now?: Date;
  runId?: string;
  /** Transcript text override; otherwise resolved from the brief. */
  transcriptText?: string;
  /** Probe a source clip by id/path for the manifest. */
  probe?: (id: string, path: string) => Promise<ClipProbe>;
  /** Injectable renderer. Defaults to the deterministic pipeline. */
  renderFn?: (plan: EditPlan) => Promise<RenderRecord>;
  /** Edit-plan JSON Schema text override. */
  schemaText?: string;
}

export interface AgentRunResult {
  runId: string;
  runDir: string;
  finalPlan: EditPlan;
  accepted: boolean;
  usedFallback: boolean;
  status: string;
  rendered: boolean;
  iterations: number;
  activeRuleIds: string[];
  render?: RenderRecord;
  failure?: string;
}

function makeRunId(brief: AgentBrief, createdAt: string): string {
  const compact = createdAt.replace(/[^0-9]/g, "").slice(0, 14);
  const short = sha256String(brief.objective + createdAt).slice(0, 6);
  return `run_${compact}_${short}`;
}

export async function agentRun(input: AgentRunInput): Promise<AgentRunResult> {
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const runId = input.runId ?? makeRunId(input.brief, createdAt);
  const runDir = join(input.home, "runs", runId);

  // Asset manifest: text only, never media bytes.
  const manifest = await buildAssetManifest(
    input.brief,
    input.probe ? { probe: input.probe } : {},
  );
  const manifestText = renderManifestText(manifest);

  // Transcript: explicit override, then brief text. (Path loading is the
  // caller's job so this layer stays filesystem-light for offline runs.)
  let transcriptText = input.transcriptText ?? input.brief.transcript?.text;
  if (transcriptText !== undefined) {
    enforceMaxSize(transcriptText, MAX_SIZES.transcript, "transcript");
  }

  // Only active human rules that apply to this run's scope.
  const activeRules = loadApplicableRules(input.home, input.brief.scope ?? {});

  const schemaText = input.schemaText ?? JSON.stringify(buildJsonSchema());

  const loop = await runPlannerLoop({
    brief: input.brief,
    provider: input.provider,
    manifestText,
    ...(transcriptText !== undefined ? { transcriptText } : {}),
    rules: activeRules.map((r) => ({ id: r.id, text: r.text })),
    schemaText,
    maxIterations: input.maxIterations ?? 4,
  });

  let status = loop.accepted ? "ok" : loop.usedFallback ? "fallback" : "unapproved";
  let rendered = false;
  let render: RenderRecord | undefined;
  let failure: string | undefined;

  if (input.render) {
    try {
      const fn = input.renderFn ?? defaultRenderFn;
      render = await fn(loop.finalPlan);
      rendered = true;
      if (!render.pass) status = "render-qa-failed";
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      status = "render-failed";
    }
  }

  writeRunAudit({
    runId,
    runDir,
    createdAt,
    brief: input.brief,
    manifest,
    manifestText,
    transcriptIncluded: transcriptText !== undefined,
    providerId: input.provider.id,
    activeRules,
    iterations: loop.iterations,
    finalPlan: loop.finalPlan,
    usedFallback: loop.usedFallback,
    accepted: loop.accepted,
    status,
    ...(failure ? { failure } : {}),
    ...(render ? { render } : { render: null }),
  });

  recordRun(input.home, {
    runId,
    provider: input.provider.id,
    status,
    iterations: loop.iterations.length,
    planValid: true,
    now,
  });

  return {
    runId,
    runDir,
    finalPlan: loop.finalPlan,
    accepted: loop.accepted,
    usedFallback: loop.usedFallback,
    status,
    rendered,
    iterations: loop.iterations.length,
    activeRuleIds: activeRules.map((r) => r.id),
    ...(render ? { render } : {}),
    ...(failure ? { failure } : {}),
  };
}

/** Default renderer: the deterministic pipeline, loaded lazily. */
async function defaultRenderFn(plan: EditPlan): Promise<RenderRecord> {
  const { renderPlan } = await import("../pipeline.js");
  const result = await renderPlan(plan);
  return { finalPath: result.finalPath, qaReportPath: result.qaReportPath, pass: result.report.pass };
}
