#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEditPlan } from "./schema/editPlan.js";
import { getPreset, listPresets } from "./presets/index.js";
import { makeStarterPlan } from "./presets/starter.js";
import { binaryAvailable, ffmpegBinary, ffprobeBinary } from "./ffmpeg/spawn.js";
import { runFinalMasterQa, writeQaReport } from "./ffmpeg/qa.js";
import { renderPlan } from "./pipeline.js";
import { runDemo } from "./demo/generate.js";
import { runAgentCli } from "./agent/cli.js";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
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

function log(msg: string): void {
  process.stdout.write(msg + "\n");
}

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

/**
 * Read a required numeric CLI flag. Rejects a missing flag, a bare boolean flag
 * (given without a value), and any non-numeric value, with a clear message.
 */
export function requireNumberFlag(
  flags: Record<string, string | boolean>,
  name: string,
): number {
  const raw = flags[name];
  if (raw === undefined || raw === true) {
    throw new Error(`Missing required numeric flag --${name}. Pass it as --${name} <number>.`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Flag --${name} must be a number, got "${String(raw)}".`);
  }
  return n;
}

function loadPlanFile(path: string) {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
  return parseEditPlan(raw);
}

async function cmdDoctor(): Promise<number> {
  const major = Number(process.versions.node.split(".")[0]);
  const nodeOk = major >= 20;
  const ffmpegOk = await binaryAvailable(ffmpegBinary());
  const ffprobeOk = await binaryAvailable(ffprobeBinary());
  let remotionOk = true;
  try {
    await import("@remotion/renderer");
  } catch {
    remotionOk = false;
  }
  const rows: Array<[string, boolean, string]> = [
    ["Node >= 20", nodeOk, `found v${process.versions.node}`],
    ["FFmpeg", ffmpegOk, ffmpegBinary()],
    ["FFprobe", ffprobeOk, ffprobeBinary()],
    ["@remotion/renderer", remotionOk, remotionOk ? "resolvable" : "not installed"],
  ];
  log("octupie-video-editor doctor");
  for (const [name, ok, detail] of rows) {
    log(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(20)} ${detail}`);
  }
  const allOk = rows.every((r) => r[1]);
  log(allOk ? "All checks passed." : "One or more checks failed.");
  return allOk ? 0 : 1;
}

function cmdInit(args: Args): number {
  const presetId = (args.flags.preset as string) ?? "neutral-founder-reel";
  const outPath = (args.flags.out as string) ?? "edit-plan.json";
  const preset = getPreset(presetId);
  const plan = makeStarterPlan(preset, {
    ...(args.flags.title ? { title: args.flags.title as string } : {}),
    ...(args.flags.duration ? { duration: Number(args.flags.duration) } : {}),
  });
  const parsed = parseEditPlan(plan);
  if (!parsed.ok) {
    fail(`Generated starter plan is invalid:\n${parsed.errors.join("\n")}`);
  }
  const abs = resolve(process.cwd(), outPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(plan, null, 2) + "\n", "utf8");
  log(`Wrote starter plan for preset '${preset.id}' to ${outPath}`);
  return 0;
}

function cmdValidate(args: Args): number {
  const file = args._[0];
  if (!file) fail("Usage: octupie-video-editor validate <plan.json>");
  const parsed = loadPlanFile(file);
  if (parsed.ok) {
    log(`valid: ${file}`);
    return 0;
  }
  log(`invalid: ${file}`);
  for (const err of parsed.errors) log(`  - ${err}`);
  return 1;
}

async function cmdRender(args: Args): Promise<number> {
  const file = args._[0];
  if (!file) fail("Usage: octupie-video-editor render <plan.json>");
  const parsed = loadPlanFile(file);
  if (!parsed.ok || !parsed.plan) {
    log(`invalid plan: ${file}`);
    for (const err of parsed.errors) log(`  - ${err}`);
    return 1;
  }
  const result = await renderPlan(parsed.plan, { onStep: (m) => log(`  ${m}`) });
  log(`master: ${result.finalPath}`);
  log(`sha256: ${result.report.sha256}`);
  log(`qa report: ${result.qaReportPath}`);
  log(result.report.pass ? "QA: PASS" : "QA: FAIL");
  return result.report.pass ? 0 : 1;
}

async function cmdQa(args: Args): Promise<number> {
  const file = args._[0];
  if (!file) fail("Usage: octupie-video-editor qa <master.mp4> (--plan plan.json | --width --height --fps --duration)");
  let expect;
  if (args.flags.plan) {
    const parsed = loadPlanFile(args.flags.plan as string);
    if (!parsed.ok || !parsed.plan) fail("The --plan file is invalid.");
    const p = parsed.plan;
    expect = {
      width: p.width,
      height: p.height,
      fps: p.fps,
      durationSeconds: p.duration,
      targetLufs: p.audio.targetLufs,
      truePeakDb: p.audio.truePeakDb,
    };
  } else {
    expect = {
      width: requireNumberFlag(args.flags, "width"),
      height: requireNumberFlag(args.flags, "height"),
      fps: requireNumberFlag(args.flags, "fps"),
      durationSeconds: requireNumberFlag(args.flags, "duration"),
    };
  }
  const report = await runFinalMasterQa(resolve(process.cwd(), file), expect);
  const reportPath = resolve(process.cwd(), `${file}.qa.json`);
  writeQaReport(report, reportPath);
  for (const g of report.gates) log(`  ${g.pass ? "ok  " : "FAIL"}  ${g.name.padEnd(22)} ${g.detail}`);
  log(`sha256: ${report.sha256}`);
  log(report.pass ? "QA: PASS" : "QA: FAIL");
  return report.pass ? 0 : 1;
}

async function cmdDemo(): Promise<number> {
  const result = await runDemo((m) => log(`  ${m}`));
  log(`demo master: ${result.finalPath}`);
  log(`sha256: ${result.report.sha256}`);
  log(`qa report: ${result.qaReportPath}`);
  log("QA: PASS");
  return 0;
}

function usage(): void {
  log("octupie-video-editor <command>");
  log("");
  log("Commands:");
  log("  doctor                 Verify Node, FFmpeg, FFprobe, and Remotion.");
  log("  init [--preset id]     Write a valid starter edit plan.");
  log("  validate <plan.json>   Validate an edit plan against the schema.");
  log("  render <plan.json>     Render, assemble audio, mux, and QA a master.");
  log("  qa <master.mp4>        QA an existing master (--plan or explicit flags).");
  log("  demo                   Generate and render a synthetic demo, then QA it.");
  log("  agent <subcommand>     Bounded agent: providers, run, feedback, rules, deactivate.");
  log("");
  log(`Presets: ${listPresets().map((p) => p.id).join(", ")}`);
}

export async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  // The agent layer owns its own subcommand parsing and exit codes.
  if (rawArgv[0] === "agent") {
    process.exit(await runAgentCli(rawArgv.slice(1)));
  }
  const args = parseArgs(rawArgv);
  const cmd = args._.shift();
  try {
    switch (cmd) {
      case "doctor":
        process.exit(await cmdDoctor());
        break;
      case "init":
        process.exit(cmdInit(args));
        break;
      case "validate":
        process.exit(cmdValidate(args));
        break;
      case "render":
        process.exit(await cmdRender(args));
        break;
      case "qa":
        process.exit(await cmdQa(args));
        break;
      case "demo":
        process.exit(await cmdDemo());
        break;
      case "help":
      case undefined:
        usage();
        process.exit(0);
        break;
      default:
        fail(`Unknown command: ${cmd}\nRun 'octupie-video-editor help'.`);
    }
  } catch (err) {
    fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main();
}
