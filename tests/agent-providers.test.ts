import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExecFn, ExecResult } from "../src/agent/exec.js";
import { createDeterministicProvider } from "../src/agent/providers/deterministic.js";
import {
  buildClaudeArgs,
  parseClaudeOutput,
  createClaudeProvider,
} from "../src/agent/providers/claude.js";
import {
  buildCodexArgs,
  parseCodexOutput,
  createCodexProvider,
} from "../src/agent/providers/codex.js";
import type { ProviderRequest } from "../src/agent/providers/types.js";
import type { AgentBrief } from "../src/agent/brief.js";

function brief(): AgentBrief {
  return {
    format: "octupie-agent-brief/v1",
    objective: "Explain onboarding",
    audience: "founders",
    platform: "reels",
    preset: "neutral-founder-reel",
    desiredDurationSeconds: 8,
    sourceClips: [],
    output: { fileName: "output/x.mp4" },
    constraints: [],
  } as AgentBrief;
}

function planReq(): ProviderRequest {
  return { kind: "plan", system: "sys", prompt: "make a plan", context: { brief: brief() } };
}

function critiqueReq(): ProviderRequest {
  return { kind: "critique", system: "sys", prompt: "review", context: { brief: brief() } };
}

function fakeExec(result: Partial<ExecResult>): ExecFn {
  return async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...result });
}

describe("deterministic provider", () => {
  it("returns a valid edit-plan JSON for a plan request", async () => {
    const p = createDeterministicProvider();
    const res = await p.generate(planReq());
    expect(res.ok).toBe(true);
    const obj = JSON.parse(res.text);
    expect(obj.format).toBe("octupie-edit-plan/v1");
  });

  it("returns an approving critique for a critique request", async () => {
    const p = createDeterministicProvider();
    const res = await p.generate(critiqueReq());
    const obj = JSON.parse(res.text);
    expect(obj.approved).toBe(true);
  });

  it("diagnoses as available and authenticated", async () => {
    const d = await createDeterministicProvider().diagnose();
    expect(d.available).toBe(true);
    expect(d.authenticated).toBe(true);
  });
});

describe("claude-cli argument construction and parsing", () => {
  it("builds noninteractive print + json args and never puts the prompt in argv", () => {
    const args = buildClaudeArgs("SYSTEM TEXT");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args.join(" ")).toContain("SYSTEM TEXT");
    // The user prompt is delivered on stdin, not as an argument.
    expect(args).not.toContain("make a plan");
  });

  it("disables Claude tools and session persistence for data-only planning", () => {
    const args = buildClaudeArgs("SYSTEM TEXT");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--no-session-persistence");
  });

  it("extracts the result text from the Claude JSON envelope", () => {
    const raw = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"format":"x"}' });
    const parsed = parseClaudeOutput(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toBe('{"format":"x"}');
  });

  it("reports an error envelope as not ok", () => {
    const raw = JSON.stringify({ type: "result", is_error: true, result: "rate limited" });
    expect(parseClaudeOutput(raw).ok).toBe(false);
  });

  it("generate returns the parsed text and passes the prompt on stdin", async () => {
    let stdin: string | undefined;
    const exec: ExecFn = async (_bin, _args, opts) => {
      stdin = opts?.input;
      return {
        code: 0,
        stdout: JSON.stringify({ type: "result", is_error: false, result: "PLAN_JSON" }),
        stderr: "",
        timedOut: false,
      };
    };
    const p = createClaudeProvider({ exec, binary: "claude" });
    const res = await p.generate(planReq());
    expect(res.ok).toBe(true);
    expect(res.text).toBe("PLAN_JSON");
    expect(stdin).toBe("make a plan");
  });

  it("detects a missing binary cleanly", async () => {
    const exec: ExecFn = fakeExec({ code: null, spawnError: "spawn claude ENOENT" });
    const p = createClaudeProvider({ exec, binary: "claude" });
    const res = await p.generate(planReq());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not available|ENOENT/i);
  });

  it("surfaces a timeout as an error", async () => {
    const exec: ExecFn = fakeExec({ code: null, timedOut: true });
    const res = await createClaudeProvider({ exec }).generate(planReq());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timeout|timed out/i);
  });

  it("diagnose reports availability from the version probe", async () => {
    const okExec: ExecFn = fakeExec({ code: 0, stdout: "1.2.3 (Claude Code)" });
    const d = await createClaudeProvider({ exec: okExec }).diagnose();
    expect(d.available).toBe(true);

    const missingExec: ExecFn = fakeExec({ code: null, spawnError: "ENOENT" });
    const d2 = await createClaudeProvider({ exec: missingExec }).diagnose();
    expect(d2.available).toBe(false);
  });

  it("diagnose reports the standalone Claude login state", async () => {
    const exec: ExecFn = async (_binary, args) => {
      if (args[0] === "--version") {
        return { code: 0, stdout: "1.2.3", stderr: "", timedOut: false };
      }
      expect(args).toEqual(["auth", "status", "--text"]);
      return { code: 0, stdout: "Logged in", stderr: "", timedOut: false };
    };
    const d = await createClaudeProvider({ exec }).diagnose();
    expect(d.available).toBe(true);
    expect(d.authenticated).toBe(true);
  });
});

describe("codex-cli argument construction and parsing", () => {
  it("builds a noninteractive exec + json invocation", () => {
    const args = buildCodexArgs();
    expect(args[0]).toBe("exec");
    expect(args.join(" ")).toMatch(/--json/);
  });

  it("confines Codex planning to a read-only sandbox", () => {
    const args = buildCodexArgs();
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
  });

  it("extracts the final agent message from codex JSONL", () => {
    const raw = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "FINAL_PLAN" } }),
    ].join("\n");
    const parsed = parseCodexOutput(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toBe("FINAL_PLAN");
  });

  it("handles the msg-shaped codex event too", () => {
    const raw = JSON.stringify({ msg: { type: "agent_message", message: "HELLO" } });
    expect(parseCodexOutput(raw).text).toBe("HELLO");
  });

  it("generate merges system+prompt to stdin and returns parsed text", async () => {
    let stdin: string | undefined;
    const exec: ExecFn = async (_bin, _args, opts) => {
      stdin = opts?.input;
      return {
        code: 0,
        stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OUT" } }),
        stderr: "",
        timedOut: false,
      };
    };
    const res = await createCodexProvider({ exec }).generate(planReq());
    expect(res.text).toBe("OUT");
    expect(stdin).toMatch(/sys/);
    expect(stdin).toMatch(/make a plan/);
  });

  it("detects a missing binary cleanly", async () => {
    const exec: ExecFn = fakeExec({ code: null, spawnError: "spawn codex ENOENT" });
    const res = await createCodexProvider({ exec }).generate(planReq());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not available|ENOENT/i);
  });
});

describe("hermes isolation guarantee", () => {
  it("provider adapters never reference hermes auth paths", () => {
    for (const f of ["claude.ts", "codex.ts", "exec.ts"]) {
      const src = readFileSync(resolve(process.cwd(), "src/agent/providers", f === "exec.ts" ? "../exec.ts" : f), "utf8");
      expect(src.toLowerCase()).not.toMatch(/hermes/);
    }
  });
});
