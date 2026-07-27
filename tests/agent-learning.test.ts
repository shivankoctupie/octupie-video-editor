import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFeedbackRule,
  listRules,
  deactivateRule,
  loadApplicableRules,
  recordRun,
  readRunRecords,
} from "../src/agent/learning.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ove-agent-"));
});

const AT = new Date("2026-07-27T10:00:00Z");

describe("learning store rules", () => {
  it("adds a global rule and lists it active", () => {
    const r = addFeedbackRule(home, { scope: "global", text: "Cut on phrase boundaries", now: AT });
    expect(r.added).toBe(true);
    const all = listRules(home);
    expect(all).toHaveLength(1);
    expect(all[0]!.active).toBe(true);
    expect(all[0]!.text).toBe("Cut on phrase boundaries");
  });

  it("deduplicates an exact repeat rule", () => {
    addFeedbackRule(home, { scope: "global", text: "Two words max", now: AT });
    const again = addFeedbackRule(home, { scope: "global", text: "Two words max", now: AT });
    expect(again.added).toBe(false);
    expect(listRules(home)).toHaveLength(1);
  });

  it("treats the same text under a different scope as distinct", () => {
    addFeedbackRule(home, { scope: "global", text: "No music", now: AT });
    const scoped = addFeedbackRule(home, { scope: "creator", creator: "shivank", text: "No music", now: AT });
    expect(scoped.added).toBe(true);
    expect(listRules(home)).toHaveLength(2);
  });

  it("requires the matching selector for a non-global scope", () => {
    expect(() => addFeedbackRule(home, { scope: "creator", text: "x", now: AT })).toThrow(/creator/i);
  });

  it("rejects an oversized rule", () => {
    expect(() =>
      addFeedbackRule(home, { scope: "global", text: "x".repeat(100000), now: AT }),
    ).toThrow(/too large/i);
  });
});

describe("loadApplicableRules scope selection", () => {
  beforeEach(() => {
    addFeedbackRule(home, { scope: "global", text: "global rule", now: AT });
    addFeedbackRule(home, { scope: "creator", creator: "shivank", text: "creator rule", now: AT });
    addFeedbackRule(home, { scope: "series", series: "founder-shorts", text: "series rule", now: AT });
    addFeedbackRule(home, { scope: "project", project: "octupie", text: "project rule", now: AT });
  });

  it("always includes global rules", () => {
    const rules = loadApplicableRules(home, {});
    expect(rules.map((r) => r.text)).toContain("global rule");
    expect(rules.map((r) => r.text)).not.toContain("creator rule");
  });

  it("includes a creator rule only for the matching creator", () => {
    expect(loadApplicableRules(home, { creator: "shivank" }).map((r) => r.text)).toContain("creator rule");
    expect(loadApplicableRules(home, { creator: "other" }).map((r) => r.text)).not.toContain("creator rule");
  });

  it("includes series and project rules only for matching selectors", () => {
    const rules = loadApplicableRules(home, { series: "founder-shorts", project: "octupie" });
    expect(rules.map((r) => r.text)).toEqual(expect.arrayContaining(["series rule", "project rule"]));
  });
});

describe("deactivateRule", () => {
  it("deactivates a rule so it no longer applies", () => {
    const r = addFeedbackRule(home, { scope: "global", text: "temp rule", now: AT });
    const id = r.rule!.id;
    expect(loadApplicableRules(home, {}).some((x) => x.id === id)).toBe(true);
    const d = deactivateRule(home, id, AT);
    expect(d.ok).toBe(true);
    expect(loadApplicableRules(home, {}).some((x) => x.id === id)).toBe(false);
    // Still listed, but marked inactive.
    expect(listRules(home).find((x) => x.id === id)!.active).toBe(false);
  });

  it("returns not ok for an unknown id", () => {
    expect(deactivateRule(home, "rule_nope", AT).ok).toBe(false);
  });
});

describe("run records", () => {
  it("appends and reads run records", () => {
    recordRun(home, { runId: "run_1", provider: "deterministic", status: "ok", iterations: 2, planValid: true, now: AT });
    recordRun(home, { runId: "run_2", provider: "claude-cli", status: "fallback", iterations: 4, planValid: true, now: AT });
    const records = readRunRecords(home);
    expect(records).toHaveLength(2);
    expect(records[0]!.runId).toBe("run_1");
    expect(records[0]!.hash).toBeTruthy();
    expect(records[0]!.at).toBeTruthy();
  });
});
