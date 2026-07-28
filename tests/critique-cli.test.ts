import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgentCli, type AgentCliDeps } from "../src/agent/cli.js";
import { evaluatePermission } from "../src/permissions/policy.js";
import type { CritiqueRenderedMasterInput, CritiqueRenderedMasterResult } from "../src/critique/critique.js";
import type { ReviewPlanInput } from "../src/critique/review.js";
import type { RevisionLoopResult } from "../src/critique/revise.js";
import type { DraftCritiqueValue } from "../src/critique/schemas.js";

const planObj = {
  format: "octupie-edit-plan/v1",
  title: "Neutral Founder Reel",
  preset: "neutral-founder-reel",
  composition: "FounderSocialReel",
  width: 1080,
  height: 1920,
  fps: 30,
  duration: 6,
  brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
  scenes: [{ id: "hook", type: "hook", start: 0, end: 6, heading: "Big claim" }],
  output: { fileName: "neutral-founder-reel.mp4" },
};

const critique: DraftCritiqueValue = {
  format: "octupie-draft-critique/v1",
  master: { path: "neutral-founder-reel.mp4" },
  durationSeconds: 6,
  generatedAt: "2026-07-28T00:00:00.000Z",
  provider: { id: "claude-cli", model: "claude-code-critique" },
  approved: false,
  notes: [{ atSeconds: 2, severity: "blocker", category: "visual", note: "black frame" }],
  summary: "one blocker",
  limitations: ["sampled frames only"],
};

const critiqueResult: CritiqueRenderedMasterResult = {
  critiquePath: "C:/repo/output/neutral-founder-reel.critique.json",
  masterPath: "C:/repo/output/neutral-founder-reel.mp4",
  frameDir: "C:/repo/output/critique-frames",
  frameCount: 3,
  durationSeconds: 6,
  critique,
};

let dir: string;
let planPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ove-critique-"));
  planPath = join(dir, "plan.json");
  writeFileSync(planPath, JSON.stringify(planObj), "utf8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("agent critique CLI", () => {
  let out: string[];
  let err: string[];
  const deps = (over: Partial<AgentCliDeps> = {}): AgentCliDeps => ({
    log: (s) => out.push(s),
    errorLog: (s) => err.push(s),
    now: new Date("2026-07-28T00:00:00.000Z"),
    ...over,
  });
  beforeEach(() => {
    out = [];
    err = [];
  });

  it("requires a plan and a master path", async () => {
    const code = await runAgentCli(["critique", planPath], deps());
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/master\.mp4/);
  });

  it("requires --provider claude", async () => {
    const code = await runAgentCli(["critique", planPath, "output/master.mp4"], deps());
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--provider is required/);
  });

  it("requires explicit network and media-upload permission", async () => {
    const code = await runAgentCli(
      ["critique", planPath, "output/master.mp4", "--provider", "claude", "--allow-network"],
      deps(),
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/both --allow-network and --allow-media-upload/);
  });

  it("passes flags through with granted permissions and emits machine-readable output", async () => {
    let seen: CritiqueRenderedMasterInput | undefined;
    const code = await runAgentCli(
      [
        "critique",
        planPath,
        "output/neutral-founder-reel.mp4",
        "--provider",
        "claude",
        "--allow-network",
        "--allow-media-upload",
        "--out",
        "output/c.json",
        "--json",
      ],
      deps({
        critique: async (input) => {
          seen = input;
          return critiqueResult;
        },
      }),
    );
    expect(code).toBe(0);
    expect(seen).toMatchObject({ masterPath: "output/neutral-founder-reel.mp4", outFile: "output/c.json" });
    expect(seen?.plan.title).toBe("Neutral Founder Reel");
    expect(evaluatePermission("network", seen!.permissionPolicy!).allowed).toBe(true);
    expect(evaluatePermission("media-upload", seen!.permissionPolicy!).allowed).toBe(true);
    const payload = JSON.parse(out.join("\n"));
    expect(payload).toMatchObject({ frames: 3, approved: false, blockers: 1, provider: { id: "claude-cli" } });
    expect(err).toEqual([]);
  });

  it("returns a concise error when critique fails", async () => {
    const code = await runAgentCli(
      ["critique", planPath, "output/master.mp4", "--provider", "claude", "--allow-network", "--allow-media-upload"],
      deps({
        critique: async () => {
          throw new Error("outside the allowed root");
        },
      }),
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Critique failed: outside the allowed root/);
  });
});

describe("agent review CLI", () => {
  let out: string[];
  let err: string[];
  const escalated: RevisionLoopResult = {
    approved: false,
    humanEscalation: true,
    rounds: 2,
    finalPlan: { title: "Neutral Founder Reel" } as never,
    finalCritique: critique,
    reason: "reached the round cap (2) without approval; escalating to a human",
    history: [],
  };
  const deps = (over: Partial<AgentCliDeps> = {}): AgentCliDeps => ({
    log: (s) => out.push(s),
    errorLog: (s) => err.push(s),
    now: new Date("2026-07-28T00:00:00.000Z"),
    ...over,
  });
  beforeEach(() => {
    out = [];
    err = [];
  });

  it("requires explicit network and media-upload permission", async () => {
    const code = await runAgentCli(["review", planPath, "--allow-network"], deps());
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/both --allow-network and --allow-media-upload/);
  });

  it("runs the bounded loop and reports human escalation at the cap", async () => {
    let seen: ReviewPlanInput | undefined;
    const code = await runAgentCli(
      ["review", planPath, "--allow-network", "--allow-media-upload", "--max-rounds", "2", "--json"],
      deps({
        review: async (input) => {
          seen = input;
          return escalated;
        },
      }),
    );
    expect(code).toBe(0);
    expect(seen?.maxRounds).toBe(2);
    expect(seen?.plan.title).toBe("Neutral Founder Reel");
    const payload = JSON.parse(out.join("\n"));
    expect(payload).toMatchObject({ approved: false, humanEscalation: true, rounds: 2 });
  });
});
