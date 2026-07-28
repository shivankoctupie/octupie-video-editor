import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentCli } from "../src/agent/cli.js";
import { buildCapabilityProbes, improvementProposalsProbe } from "../src/capabilities/probes.js";

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function files() { const root = mkdtempSync(join(tmpdir(), "octupie-cli-improve-")); roots.push(root); const proposal = join(root, "proposal.json"); const decision = join(root, "decision.json"); writeFileSync(proposal, "{}"); writeFileSync(decision, "{}"); return { root, proposal, decision }; }

describe("improvement CLI gates", () => {
  it("blocks apply before provider invocation without explicit code-change grant", async () => {
    const f = files(); let called = 0; const errors: string[] = [];
    const code = await runAgentCli(["improvement-apply", f.proposal, "--decision", f.decision], { applyImprovement: async () => { called++; throw new Error("must not run"); }, errorLog: (s: string) => errors.push(s) });
    expect(code).toBe(2); expect(called).toBe(0); expect(errors.join(" ")).toContain("allow-code-change");
  });

  it("passes explicit artifacts and grant to apply and rollback adapters", async () => {
    const f = files(); let applied = 0; let rolled = 0;
    const codeA = await runAgentCli(["improvement-apply", f.proposal, "--decision", f.decision, "--allow-code-change", "--state-root", join(f.root, "state")], { applyImprovement: async (input) => { applied++; expect(input.stateRoot).toContain("state"); return { proposalId: "x", status: "applied", rolledBack: false, operations: [], tests: [] }; }, log: () => {} });
    const codeR = await runAgentCli(["improvement-rollback", f.proposal, "--decision", f.decision, "--allow-code-change", "--state-root", join(f.root, "state")], { rollbackImprovement: async () => { rolled++; return { proposalId: "x", status: "rolled-back", alreadyRolledBack: false, operations: [] }; }, log: () => {} });
    expect([codeA, codeR, applied, rolled]).toEqual([0, 0, 1, 1]);
  });
});

describe("improvement capability probe", () => {
  it("reports configured but never verified without gate evidence", async () => {
    expect(await improvementProposalsProbe()()).toMatchObject({ status: "configured" });
    expect(await buildCapabilityProbes()["improvement-proposals"]!()).toMatchObject({ status: "configured" });
  });
});
