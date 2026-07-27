import { writeFileSync } from "node:fs";
import { runFfmpeg } from "./spawn.js";
import { probe, videoStream, audioStream, parseRate, countFrames } from "./ffprobe.js";
import { sha256File } from "../util/hash.js";

/**
 * Final-master QA. Runs the full technical battery against the exact delivered
 * bytes and writes one JSON report bound to the master's SHA-256. Writing a
 * validator is not passing QA; this must actually execute and return `pass`.
 */

export interface QaExpectations {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  durationToleranceSec?: number;
  targetLufs?: number;
  lufsToleranceLu?: number;
  truePeakDb?: number;
}

export interface QaGate {
  name: string;
  pass: boolean;
  detail: string;
}

export interface QaReport {
  file: string;
  sha256: string;
  generatedFromHash: string;
  pass: boolean;
  gates: QaGate[];
  measured: Record<string, unknown>;
  contactSheet?: string;
}

const GPS_KEY = /gps|location|geo|coordinate/i;

function gate(name: string, pass: boolean, detail: string): QaGate {
  return { name, pass, detail };
}

export async function runFinalMasterQa(
  filePath: string,
  expect: QaExpectations,
): Promise<QaReport> {
  const gates: QaGate[] = [];
  const measured: Record<string, unknown> = {};
  const sha256 = await sha256File(filePath);

  const p = await probe(filePath);
  const v = videoStream(p);
  const a = audioStream(p);

  // Stream presence.
  gates.push(gate("video-stream-present", !!v, v ? `codec ${v.codec_name}` : "no video stream"));
  gates.push(gate("audio-stream-present", !!a, a ? `codec ${a.codec_name}` : "no audio stream"));

  // Resolution.
  const w = v?.width ?? 0;
  const h = v?.height ?? 0;
  measured.width = w;
  measured.height = h;
  gates.push(
    gate(
      "resolution",
      w === expect.width && h === expect.height,
      `${w}x${h} (expected ${expect.width}x${expect.height})`,
    ),
  );

  // FPS.
  const fps = parseRate(v?.avg_frame_rate) || parseRate(v?.r_frame_rate);
  measured.fps = fps;
  gates.push(
    gate("fps", Math.abs(fps - expect.fps) < 0.05, `${fps.toFixed(3)} (expected ${expect.fps})`),
  );

  // Duration tolerance.
  const dur = Number(p.format.duration ?? v?.duration ?? NaN);
  measured.duration = dur;
  const durTol = expect.durationToleranceSec ?? 0.5;
  gates.push(
    gate(
      "duration",
      Number.isFinite(dur) && Math.abs(dur - expect.durationSeconds) <= durTol,
      `${dur.toFixed(3)}s (expected ${expect.durationSeconds}s +/- ${durTol}s)`,
    ),
  );

  // Pixel format.
  gates.push(
    gate("pixel-format", (v as { pix_fmt?: string })?.pix_fmt === "yuv420p", `pix_fmt ${(v as { pix_fmt?: string })?.pix_fmt}`),
  );

  // Full decode (all streams) with no fatal errors.
  const decode = await runFfmpeg(["-v", "error", "-i", filePath, "-map", "0", "-f", "null", "-"]);
  const decodeClean = decode.code === 0 && decode.stderr.trim().length === 0;
  measured.decodeStderr = decode.stderr.trim().slice(0, 500);
  gates.push(gate("full-decode", decodeClean, decodeClean ? "clean" : decode.stderr.trim().slice(0, 200)));

  // Decoded frame count vs expected.
  const frames = await countFrames(filePath);
  measured.frameCount = frames;
  const expectedFrames = Math.round(expect.durationSeconds * expect.fps);
  const frameTol = Math.max(2, Math.round(expect.fps * durTol));
  gates.push(
    gate(
      "frame-count",
      Number.isFinite(frames) && Math.abs(frames - expectedFrames) <= frameTol,
      `${frames} frames (expected ~${expectedFrames} +/- ${frameTol})`,
    ),
  );

  // Black-frame scan.
  const black = await runFfmpeg([
    "-i",
    filePath,
    "-vf",
    "blackdetect=d=0.1:pix_th=0.10",
    "-an",
    "-f",
    "null",
    "-",
  ]);
  const blackHits = (black.stderr.match(/black_start/g) ?? []).length;
  measured.blackIntervals = blackHits;
  gates.push(gate("no-sustained-black", blackHits === 0, `${blackHits} black interval(s) >= 0.1s`));

  // EBU R128 loudness + true peak.
  const loud = await runFfmpeg(["-i", filePath, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const iMatch = [...loud.stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  const integrated = iMatch.length ? Number(iMatch[iMatch.length - 1]![1]) : NaN;
  const peakMatch = [...loud.stderr.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g)];
  const truePeak = peakMatch.length ? Number(peakMatch[peakMatch.length - 1]![1]) : NaN;
  measured.integratedLufs = integrated;
  measured.truePeakDb = truePeak;
  const targetLufs = expect.targetLufs ?? -16;
  const lufsTol = expect.lufsToleranceLu ?? 2.5;
  gates.push(
    gate(
      "loudness",
      Number.isFinite(integrated) && Math.abs(integrated - targetLufs) <= lufsTol,
      `${integrated} LUFS (target ${targetLufs} +/- ${lufsTol})`,
    ),
  );
  const tpCeiling = expect.truePeakDb ?? -1.0;
  gates.push(
    gate(
      "true-peak",
      Number.isFinite(truePeak) && truePeak <= tpCeiling + 0.3,
      `${truePeak} dBFS (ceiling ${tpCeiling})`,
    ),
  );

  // Metadata scan: no GPS/location tags survive.
  const allTags: Record<string, string> = { ...(p.format.tags ?? {}) };
  for (const s of p.streams) Object.assign(allTags, s.tags ?? {});
  const badKeys = Object.keys(allTags).filter((k) => GPS_KEY.test(k));
  measured.tagKeys = Object.keys(allTags);
  gates.push(gate("no-location-metadata", badKeys.length === 0, badKeys.length ? `found ${badKeys.join(", ")}` : "no gps/location tags"));

  // Contact sheet (best-effort; not a blocking gate).
  const contactSheet = `${filePath}.contact.png`;
  const sampleFps = Math.max(0.001, 9 / Math.max(1, expect.durationSeconds));
  const sheet = await runFfmpeg([
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-vf",
    `fps=${sampleFps.toFixed(6)},scale=320:-1,tile=3x3`,
    "-y",
    contactSheet,
  ]);
  const sheetOk = sheet.code === 0;

  const pass = gates.every((g) => g.pass);
  const report: QaReport = {
    file: filePath,
    sha256,
    generatedFromHash: sha256,
    pass,
    gates,
    measured,
    contactSheet: sheetOk ? contactSheet : undefined,
  };
  return report;
}

export function writeQaReport(report: QaReport, reportPath: string): void {
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
}
