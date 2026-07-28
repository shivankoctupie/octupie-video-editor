import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPolicy } from "../src/permissions/policy.js";
import { sha256String } from "../src/util/hash.js";
import { applyProposal, auditRecordPath, defaultImprovementFs, type ImprovementFs } from "../src/improvements/apply.js";
import { rollbackProposal } from "../src/improvements/rollback.js";
import { isAllowedTestCommand, parseStructuredPatch } from "../src/improvements/schemas.js";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "octupie-improve-")); roots.push(root);
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "a.ts"), "before-a\n"); writeFileSync(join(root, "src", "b.ts"), "before-b\n");
  const state = join(root, "state");
  const operations = [
    { path: "src/a.ts", beforeSha256: sha256String("before-a\n"), beforeText: "before-a\n", afterText: "after-a\n" },
    { path: "src/b.ts", beforeSha256: sha256String("before-b\n"), beforeText: "before-b\n", afterText: "after-b\n" },
  ];
  const patch = JSON.stringify({ format: "octupie-replace-v1", operations });
  const proposal = { format: "octupie-improvement-proposal/v1", id: "safe-change", title: "Safe", description: "Reviewed", patch, tests: ["npm run typecheck"], rollbackPlan: "Restore exact prior bytes", createdAt: NOW.toISOString(), status: "proposed" };
  const applyDecision = { format: "octupie-improvement-decision/v1", proposalId: proposal.id, approved: true, approver: "Shivank", decidedAt: NOW.toISOString(), action: "apply" };
  const rollbackDecision = { ...applyDecision, action: "rollback" };
  const policy = createPolicy([{ action: "code-change", grantedBy: "test", grantedAt: NOW.toISOString() }]);
  const noPolicy = createPolicy([]);
  const runner = async (command: string) => ({ command, ok: true, detail: "passed" });
  return { root, state, operations, proposal, applyDecision, rollbackDecision, policy, noPolicy, runner };
}

describe("improvement proposal gates", () => {
  it("rejects traversal, protected paths, duplicate paths, and command injection", () => {
    const f = fixture();
    for (const path of ["../x", "/tmp/x", "src/.env", "src/key.pem", "output/x.ts", "src\\x.ts"]) {
      const op = { ...f.operations[0], path };
      expect(parseStructuredPatch({ format: "octupie-replace-v1", operations: [op] }).ok).toBe(false);
    }
    expect(parseStructuredPatch({ format: "octupie-replace-v1", operations: [f.operations[0], f.operations[0]] }).ok).toBe(false);
    expect(isAllowedTestCommand("npm test; rm -rf .")).toBe(false);
    expect(isAllowedTestCommand("npm test -- --run tests/x.test.ts && whoami")).toBe(false);
  });

  it.each([
    ["missing approval", undefined],
    ["false approval", { format: "octupie-improvement-decision/v1", proposalId: "safe-change", approved: false, approver: "S", decidedAt: NOW.toISOString(), action: "apply" }],
    ["mismatched approval", { format: "octupie-improvement-decision/v1", proposalId: "other", approved: true, approver: "S", decidedAt: NOW.toISOString(), action: "apply" }],
  ])("blocks %s before writes or tests", async (_name, decision) => {
    const f = fixture(); let calls = 0;
    await expect(applyProposal({ proposal: f.proposal, decision, policy: f.policy, projectRoot: f.root, stateRoot: f.state, testRunner: async (c) => { calls++; return f.runner(c); }, now: NOW })).rejects.toThrow();
    expect(readFileSync(join(f.root, "src/a.ts"), "utf8")).toBe("before-a\n"); expect(calls).toBe(0);
  });

  it("blocks missing and expired code-change grants", async () => {
    const f = fixture();
    await expect(applyProposal({ proposal: f.proposal, decision: f.applyDecision, policy: f.noPolicy, projectRoot: f.root, stateRoot: f.state, testRunner: f.runner, now: NOW })).rejects.toThrow(/code-change/);
    const expired = createPolicy([{ action: "code-change", grantedBy: "test", grantedAt: NOW.toISOString(), expiresAt: "2026-07-28T11:00:00.000Z" }]);
    await expect(applyProposal({ proposal: f.proposal, decision: f.applyDecision, policy: expired, projectRoot: f.root, stateRoot: f.state, testRunner: f.runner, now: NOW })).rejects.toThrow(/expired/i);
    expect(readFileSync(join(f.root, "src/a.ts"), "utf8")).toBe("before-a\n");
  });

  it("preflights every operation before the first source write", async () => {
    const f = fixture(); writeFileSync(join(f.root, "src/b.ts"), "changed\n");
    await expect(applyProposal({ proposal: f.proposal, decision: f.applyDecision, policy: f.policy, projectRoot: f.root, stateRoot: f.state, testRunner: f.runner, now: NOW })).rejects.toThrow(/changed/);
    expect(readFileSync(join(f.root, "src/a.ts"), "utf8")).toBe("before-a\n");
  });
});

describe("apply and rollback", () => {
  it("applies multiple files, records audit, and restores exact bytes", async () => {
    const f = fixture(); const commands: string[] = [];
    const applied = await applyProposal({ proposal: f.proposal, decision: f.applyDecision, policy: f.policy, projectRoot: f.root, stateRoot: f.state, testRunner: async (c) => { commands.push(c); return f.runner(c); }, now: NOW });
    expect(applied.status).toBe("applied"); expect(commands).toEqual(["npm run typecheck"]); expect(readFileSync(join(f.root, "src/a.ts"), "utf8")).toBe("after-a\n");
    expect(JSON.parse(readFileSync(auditRecordPath(f.state, f.proposal.id), "utf8")).integrity).toMatch(/^[0-9a-f]{64}$/);
    const rolled = await rollbackProposal({ proposal: f.proposal, decision: f.rollbackDecision, policy: f.policy, projectRoot: f.root, stateRoot: f.state, now: NOW });
    expect(rolled.alreadyRolledBack).toBe(false); expect(readFileSync(join(f.root, "src/a.ts"), "utf8")).toBe("before-a\n"); expect(readFileSync(join(f.root, "src/b.ts"), "utf8")).toBe("before-b\n");
    const again = await rollbackProposal({ proposal: f.proposal, decision: f.rollbackDecision, policy: f.policy, projectRoot: f.root, stateRoot: f.state, now: NOW });
    expect(again.alreadyRolledBack).toBe(true);
  });

  it("restores all source bytes when a test fails or throws", async () => {
    for (const mode of ["false", "throw"] as const) {
      const f = fixture();
      const result = await applyProposal({ proposal: f.proposal, decision: f.applyDecision, policy: f.policy, projectRoot: f.root, stateRoot: f.state, testRunner: async (c) => { if (mode === "throw") throw new Error("boom"); return { command: c, ok: false, detail: "failed" }; }, now: NOW });
      expect(result.status).toBe("failed"); expect(result.rolledBack).toBe(true); expect(readFileSync(join(f.root, "src/a.ts"), "utf8")).toBe("before-a\n"); expect(readFileSync(join(f.root, "src/b.ts"), "utf8")).toBe("before-b\n");
    }
  });

  it("restores all files when a later source write fails", async () => {
    const f = fixture(); let failed = false;
    const fs: ImprovementFs = { ...defaultImprovementFs, writeFile(path, data) { if (!failed && path.endsWith("b.ts") && data === "after-b\n") { failed = true; throw new Error("disk"); } defaultImprovementFs.writeFile(path, data); } };
    const result = await applyProposal({ proposal: f.proposal, decision: f.applyDecision, policy: f.policy, projectRoot: f.root, stateRoot: f.state, testRunner: f.runner, fs, now: NOW });
    expect(result.rolledBack).toBe(true); expect(readFileSync(join(f.root, "src/a.ts"), "utf8")).toBe("before-a\n"); expect(readFileSync(join(f.root, "src/b.ts"), "utf8")).toBe("before-b\n");
  });

  it("rejects a tampered audit or changed applied file", async () => {
    const f = fixture(); await applyProposal({ proposal: f.proposal, decision: f.applyDecision, policy: f.policy, projectRoot: f.root, stateRoot: f.state, testRunner: f.runner, now: NOW });
    const auditPath = auditRecordPath(f.state, f.proposal.id); const audit = JSON.parse(readFileSync(auditPath, "utf8")); audit.operations[0].afterSha256 = "0".repeat(64); writeFileSync(auditPath, JSON.stringify(audit));
    await expect(rollbackProposal({ proposal: f.proposal, decision: f.rollbackDecision, policy: f.policy, projectRoot: f.root, stateRoot: f.state, now: NOW })).rejects.toThrow(/tampered|audit/i);
    const g = fixture(); await applyProposal({ proposal: g.proposal, decision: g.applyDecision, policy: g.policy, projectRoot: g.root, stateRoot: g.state, testRunner: g.runner, now: NOW }); writeFileSync(join(g.root, "src/a.ts"), "manual\n");
    await expect(rollbackProposal({ proposal: g.proposal, decision: g.rollbackDecision, policy: g.policy, projectRoot: g.root, stateRoot: g.state, now: NOW })).rejects.toThrow(/changed/);
  });
});
