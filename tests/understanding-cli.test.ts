import { beforeEach, describe, expect, it } from "vitest";
import { runAgentCli, type AgentCliDeps } from "../src/agent/cli.js";
import { evaluatePermission } from "../src/permissions/policy.js";
import type { UnderstandSourceInput, UnderstandSourceResult } from "../src/understanding/understand.js";

const result: UnderstandSourceResult = {
  understandingPath: "C:/repo/output/analysis/clip/understanding.json",
  frameDir: "C:/repo/output/analysis/clip/frames",
  frameCount: 3,
  understanding: {
    format: "octupie-semantic-understanding/v1",
    clip: { path: "source/clip.mov" },
    durationSeconds: 6,
    generatedAt: "2026-07-28T00:00:00.000Z",
    provider: { id: "claude-cli", model: "claude-code-vision" },
    findings: [
      {
        kind: "hook-moment",
        startSeconds: 0,
        endSeconds: 0.4,
        confidence: 0.8,
        rationale: "direct claim",
        evidenceFrames: [{ path: "frame_00001.jpg", atSeconds: 0 }],
      },
    ],
    segments: [{ startSeconds: 0, endSeconds: 2, description: "intro", salience: 0.7, tags: ["intro"] }],
    summary: "A short intro.",
    limitations: ["sampled frames only"],
  },
};

describe("agent understand CLI", () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
  });

  it("requires an analysis path", async () => {
    const code = await runAgentCli(["understand"], { log: (s) => out.push(s), errorLog: (s) => err.push(s) });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/analysis\.json/);
  });

  it("requires --provider to be claude", async () => {
    const code = await runAgentCli(["understand", "output/analysis/clip/analysis.json"], {
      log: (s) => out.push(s),
      errorLog: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--provider is required/);
  });

  it("rejects an unknown provider", async () => {
    const code = await runAgentCli(
      ["understand", "output/analysis/clip/analysis.json", "--provider", "gpt"],
      { log: (s) => out.push(s), errorLog: (s) => err.push(s) },
    );
    expect(code).toBe(2);
  });

  it("requires explicit network and media-upload permission", async () => {
    const code = await runAgentCli(
      ["understand", "output/analysis/clip/analysis.json", "--provider", "claude", "--allow-network"],
      { log: (s) => out.push(s), errorLog: (s) => err.push(s) },
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/both --allow-network and --allow-media-upload/);
  });

  it("passes flags through and emits machine-readable output", async () => {
    let seen: UnderstandSourceInput | undefined;
    const deps: AgentCliDeps = {
      log: (s) => out.push(s),
      errorLog: (s) => err.push(s),
      now: new Date("2026-07-28T00:00:00.000Z"),
      understand: async (input) => {
        seen = input;
        return result;
      },
    };
    const code = await runAgentCli(
      [
        "understand",
        "output/analysis/clip/analysis.json",
        "--provider",
        "claude",
        "--allow-network",
        "--allow-media-upload",
        "--out",
        "output/analysis/clip/u.json",
        "--json",
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(seen).toMatchObject({
      analysisPath: "output/analysis/clip/analysis.json",
      providerId: "claude",
      outFile: "output/analysis/clip/u.json",
    });
    expect(seen?.permissionPolicy).toBeDefined();
    expect(evaluatePermission("network", seen!.permissionPolicy!).allowed).toBe(true);
    expect(evaluatePermission("media-upload", seen!.permissionPolicy!).allowed).toBe(true);
    const payload = JSON.parse(out.join("\n"));
    expect(payload).toMatchObject({ findings: 1, segments: 1, frames: 3, provider: { id: "claude-cli" } });
    expect(err).toEqual([]);
  });

  it("returns a concise error when understanding fails", async () => {
    const code = await runAgentCli(
      [
        "understand",
        "output/analysis/clip/analysis.json",
        "--provider",
        "claude",
        "--allow-network",
        "--allow-media-upload",
      ],
      {
        log: (s) => out.push(s),
        errorLog: (s) => err.push(s),
        understand: async () => {
          throw new Error("outside the allowed root");
        },
      },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Understand failed: outside the allowed root/);
  });
});
