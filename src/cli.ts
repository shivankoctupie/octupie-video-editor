#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseEditPlan } from "./schema/editPlan.js";
import { getPreset, listPresets } from "./presets/index.js";
import { makeStarterPlan } from "./presets/starter.js";
import { binaryAvailable, ffmpegBinary, ffprobeBinary } from "./ffmpeg/spawn.js";
import { runFinalMasterQa, writeQaReport } from "./ffmpeg/qa.js";
import { renderPlan } from "./pipeline.js";
import { runDemo } from "./demo/generate.js";
import { runAgentCli } from "./agent/cli.js";
import { configFromEnv, startServer, createWorkerRuntime, runWorkerOnce, runWorkerLoop } from "./server/index.js";

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

/**
 * Minimum Node runtime. The product store runs on the built-in `node:sqlite` module, which was
 * added in Node 22.5.0, so anything older cannot start the server or worker.
 */
export const MIN_NODE_VERSION = "22.5.0";

/** True when `version` (e.g. process.versions.node) is at least `min`. A prerelease suffix
 * (`-nightly...`, `-rc.1`) is ignored; only the numeric major.minor.patch is compared. */
export function nodeMeetsMinimum(version: string, min: string = MIN_NODE_VERSION): boolean {
  const parse = (v: string): number[] => v.split("-")[0]!.split(".").map((n) => Number(n) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
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
  const nodeOk = nodeMeetsMinimum(process.versions.node);
  const ffmpegOk = await binaryAvailable(ffmpegBinary());
  const ffprobeOk = await binaryAvailable(ffprobeBinary());
  let remotionOk = true;
  try {
    await import("@remotion/renderer");
  } catch {
    remotionOk = false;
  }
  const rows: Array<[string, boolean, string]> = [
    [`Node >= ${MIN_NODE_VERSION}`, nodeOk, `found v${process.versions.node} (node:sqlite needs ${MIN_NODE_VERSION})`],
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

/** Default the static UI directory to the packaged `public/` beside this module (which
 * resolves to the repo root in dev and the package root when installed) unless the
 * operator has pointed OVE_SERVER_PUBLIC elsewhere. */
function defaultPublicDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
}

async function cmdServe(args: Args): Promise<number> {
  const config = configFromEnv();
  if (!process.env.OVE_SERVER_PUBLIC) config.publicDir = defaultPublicDir();
  if (args.flags.port !== undefined) config.port = requireNumberFlag(args.flags, "port");
  if (typeof args.flags.public === "string") config.publicDir = resolve(process.cwd(), args.flags.public);
  const server = await startServer(config);
  log(`octupie-video-editor serving on ${server.url}`);
  log(`  db      = ${config.dbPath}`);
  log(`  storage = ${config.storageRoot}`);
  log(`  public  = ${config.publicDir}`);
  if (config.users.length === 0) {
    log("  note: no users configured. Set OVE_SERVER_USERS (JSON array) to enable authenticated routes.");
  } else {
    log(`  users   = ${config.users.length} (${config.users.map((u) => u.role).join(", ")})`);
  }
  log("Press Ctrl+C to stop.");
  await new Promise<void>((resolveDone) => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      log("shutting down...");
      void server.close().then(() => {
        log("stopped.");
        resolveDone();
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  return 0;
}

async function cmdWorker(args: Args): Promise<number> {
  const config = configFromEnv();
  if (config.dbPath === ":memory:") {
    fail("The worker needs a shared on-disk database. Set OVE_SERVER_DB to a file path (the same one the server uses).");
  }
  const { deps, close } = createWorkerRuntime(config, { log: (m) => log(`  ${m}`) });
  const once = args.flags.once === true || args.flags.once === "true";
  try {
    if (once) {
      const job = await runWorkerOnce(deps);
      log(job ? `ran job ${job.id} -> ${job.status}` : "queue empty; nothing to do.");
      return 0;
    }
    log(`worker polling ${config.dbPath}. Press Ctrl+C to stop.`);
    let stop = false;
    const onSignal = (): void => {
      stop = true;
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const interval = args.flags.interval !== undefined ? requireNumberFlag(args.flags, "interval") : 1000;
    await runWorkerLoop(deps, { intervalMs: interval, shouldStop: () => stop });
    log("worker stopped.");
    return 0;
  } finally {
    close();
  }
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
  log("  serve [--port n]       Start the local product server (browser editor + REST API).");
  log("  worker [--once]        Run the render/QA job worker against the shared database.");
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
      case "serve":
        process.exit(await cmdServe(args));
        break;
      case "worker":
        process.exit(await cmdWorker(args));
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
