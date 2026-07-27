import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { EditPlan } from "./schema/editPlan.js";
import { renderSilentMaster } from "./render/index.js";
import { assembleAudio, muxFinalMaster } from "./ffmpeg/audio.js";
import { resolvePlanMedia } from "./render/preflight.js";
import { runFinalMasterQa, writeQaReport, type QaReport } from "./ffmpeg/qa.js";

export interface PipelineResult {
  finalPath: string;
  qaReportPath: string;
  report: QaReport;
}

export function outputDir(): string {
  const dir = process.env.OVE_OUTPUT_DIR?.trim() || "output";
  return resolve(process.cwd(), dir);
}

/**
 * Full deterministic pipeline: render (Remotion) -> assemble audio (FFmpeg) ->
 * mux final master -> QA the exact delivered bytes -> write one bound report.
 */
export async function renderPlan(
  plan: EditPlan,
  opts: { dir?: string; onStep?: (msg: string) => void } = {},
): Promise<PipelineResult> {
  const dir = opts.dir ?? outputDir();
  mkdirSync(dir, { recursive: true });
  const step = opts.onStep ?? (() => {});

  const base = basename(plan.output.fileName).replace(/\.mp4$/i, "");
  const silentPath = join(dir, `${base}.silent.mp4`);
  const bedPath = join(dir, `${base}.bed.wav`);
  const finalPath = join(dir, `${base}.mp4`);

  // Fail fast: every local media path must resolve (and exist) under the asset
  // root before any render work begins.
  step("preflight: resolving plan media under the asset root");
  resolvePlanMedia(plan);

  step("render: bundling and rendering silent master");
  const render = await renderSilentMaster(plan, silentPath);

  step("audio: assembling loudness-normalized track");
  const seconds = render.durationInFrames / render.fps;
  await assembleAudio(plan, seconds, bedPath);

  step("mux: assembling final master with metadata stripped");
  await muxFinalMaster(plan, silentPath, bedPath, finalPath, seconds);

  step("qa: validating the exact delivered master");
  const report = await runFinalMasterQa(finalPath, {
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    durationSeconds: seconds,
    durationToleranceSec: 0.6,
    targetLufs: plan.audio.targetLufs,
    lufsToleranceLu: 3,
    truePeakDb: plan.audio.truePeakDb,
  });

  const qaReportPath = join(dir, `${base}.qa.json`);
  writeQaReport(report, qaReportPath);
  step(`qa: ${report.pass ? "PASS" : "FAIL"} (report ${qaReportPath})`);

  return { finalPath, qaReportPath, report };
}
