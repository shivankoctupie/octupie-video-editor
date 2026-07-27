import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentCli, type AgentCliDeps } from "../src/agent/cli.js";
import { createDeterministicProvider } from "../src/agent/providers/deterministic.js";
import { listRules } from "../src/agent/learning.js";
import type { AgentBrief } from "../src/agent/brief.js";

let home: string;
let work: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ove-cli-home-"));
  work = mkdtempSync(join(tmpdir(), "ove-cli-work-"));
  out = [];
  err = [];
});

const AT = new Date("2026-07-27T10:00:00Z");

function deps(over: Partial<AgentCliDeps> = {}): AgentCliDeps {
  return {
    home,
    now: AT,
    log: (s) => out.push(s),
    errorLog: (s) => err.push(s),
    provider: () => createDeterministicProvider(),
    diagnostics: async () => [
      { id: "deterministic", available: true, authenticated: true, authSource: "built-in", detail: "ok" },
      { id: "claude-cli", available: false, authenticated: "unknown", authSource: "cli login", detail: "not found" },
    ],
    ...over,
  };
}

function writeBrief(over: Partial<AgentBrief> = {}): string {
  const brief: AgentBrief = {
    format: "octupie-agent-brief/v1",
    objective: "Explain onboarding",
    audience: "founders",
    platform: "reels",
    preset: "neutral-founder-reel",
    desiredDurationSeconds: 8,
    sourceClips: [],
    transcript: { text: "We shipped onboarding fast." },
    output: { fileName: "output/agent.mp4" },
    constraints: [],
    scope: { creator: "shivank" },
    ...over,
  } as AgentBrief;
  const p = join(work, "brief.json");
  writeFileSync(p, JSON.stringify(brief), "utf8");
  return p;
}

describe("agent providers command", () => {
  it("lists provider diagnostics and exits 0", async () => {
    const code = await runAgentCli(["providers"], deps());
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toMatch(/deterministic/);
    expect(joined).toMatch(/claude-cli/);
  });
});

describe("agent run command (offline, no render)", () => {
  it("runs end-to-end and writes an audit directory", async () => {
    const brief = writeBrief();
    const code = await runAgentCli(["run", brief, "--provider", "deterministic", "--no-render"], deps());
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toMatch(/run_/);
    expect(joined).toMatch(/status/i);
    // The audit dir is under the agent home.
    const runLine = out.find((l) => /runDir|audit/i.test(l));
    expect(runLine).toBeTruthy();
  });

  it("loads a transcript path and includes its text in the planner request", async () => {
    const prompts: string[] = [];
    const base = createDeterministicProvider();
    const brief = writeBrief({ transcript: { path: "transcripts/source.txt" } });
    const code = await runAgentCli(["run", brief, "--provider", "deterministic", "--no-render"], deps({
      transcriptLoader: (path) => {
        expect(path).toBe("transcripts/source.txt");
        return "Loaded transcript words.";
      },
      provider: () => ({
        ...base,
        async generate(req) {
          prompts.push(req.prompt);
          return base.generate(req);
        },
      }),
    }));
    expect(code).toBe(0);
    expect(prompts.some((p) => p.includes("Loaded transcript words."))).toBe(true);
  });

  it("rejects an invalid brief with exit code 2", async () => {
    const bad = join(work, "bad.json");
    writeFileSync(bad, JSON.stringify({ format: "wrong" }), "utf8");
    const code = await runAgentCli(["run", bad, "--no-render"], deps());
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/invalid|brief/i);
  });

  it("rejects an unknown provider with exit code 2", async () => {
    const brief = writeBrief();
    const code = await runAgentCli(["run", brief, "--provider", "nope", "--no-render"], {
      ...deps(),
      provider: undefined,
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/provider/i);
  });

  it("errors with exit 2 when no brief path is given", async () => {
    const code = await runAgentCli(["run", "--no-render"], deps());
    expect(code).toBe(2);
  });
});

describe("agent feedback / rules / deactivate commands", () => {
  it("saves a human correction and lists it", async () => {
    const code = await runAgentCli(
      ["feedback", "--run", "run_x", "--scope", "global", "--rule", "Cut on phrase boundaries"],
      deps(),
    );
    expect(code).toBe(0);
    expect(listRules(home)).toHaveLength(1);

    const listCode = await runAgentCli(["rules"], deps());
    expect(listCode).toBe(0);
    expect(out.join("\n")).toMatch(/Cut on phrase boundaries/);
  });

  it("requires a matching selector for a scoped correction", async () => {
    const code = await runAgentCli(["feedback", "--run", "r", "--scope", "creator", "--rule", "x"], deps());
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/creator/i);
  });

  it("filters rules by scope", async () => {
    await runAgentCli(["feedback", "--run", "r", "--scope", "global", "--rule", "global one"], deps());
    await runAgentCli(
      ["feedback", "--run", "r", "--scope", "creator", "--creator", "shivank", "--rule", "creator one"],
      deps(),
    );
    out = [];
    await runAgentCli(["rules", "--scope", "creator"], deps());
    const joined = out.join("\n");
    expect(joined).toMatch(/creator one/);
    expect(joined).not.toMatch(/global one/);
  });

  it("deactivates a rule by id", async () => {
    await runAgentCli(["feedback", "--run", "r", "--scope", "global", "--rule", "temp rule"], deps());
    const id = listRules(home)[0]!.id;
    const code = await runAgentCli(["deactivate", "--rule", id], deps());
    expect(code).toBe(0);
    expect(listRules(home)[0]!.active).toBe(false);
  });

  it("returns exit 1 deactivating an unknown rule", async () => {
    const code = await runAgentCli(["deactivate", "--rule", "rule_nope"], deps());
    expect(code).toBe(1);
  });
});

describe("agent help / unknown subcommand", () => {
  it("prints help and exits 0 for help", async () => {
    const code = await runAgentCli(["help"], deps());
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/providers|run|feedback|rules|deactivate/);
  });

  it("exits 2 on an unknown subcommand", async () => {
    const code = await runAgentCli(["frobnicate"], deps());
    expect(code).toBe(2);
  });
});
