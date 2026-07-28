import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { createPolicy } from "../src/permissions/policy.js";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import { critiqueRenderedMaster, type CritiqueRenderedMasterInput } from "../src/critique/critique.js";
import type { DraftReviewProvider, CritiqueInput } from "../src/critique/claudeCritique.js";
import type { DraftCritiqueValue } from "../src/critique/schemas.js";
import type { SampleMasterResult } from "../src/critique/sampleMaster.js";

const ROOT = resolve("output");
const MASTER = resolve(ROOT, "neutral-founder-reel.mp4");
const FRAME_DIR = join(ROOT, "critique-frames");

const PERMISSIONS = createPolicy([
  { action: "network", grantedBy: "test", grantedAt: "2026-07-28T00:00:00.000Z" },
  { action: "media-upload", grantedBy: "test", grantedAt: "2026-07-28T00:00:00.000Z" },
]);

function makePlan(): EditPlan {
  const parsed = parseEditPlan({
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
  });
  if (!parsed.ok || !parsed.plan) throw new Error(parsed.errors.join("; "));
  return parsed.plan;
}

const sampleResult: SampleMasterResult = {
  masterPath: MASTER,
  frameDir: FRAME_DIR,
  frames: [
    { absPath: join(FRAME_DIR, "critique_frame_00001.jpg"), atSeconds: 0 },
    { absPath: join(FRAME_DIR, "critique_frame_00002.jpg"), atSeconds: 2 },
  ],
};

function fakeProvider(capture?: (inp: CritiqueInput) => void): DraftReviewProvider {
  return {
    id: "claude-cli",
    critique: async (inp): Promise<DraftCritiqueValue> => {
      capture?.(inp);
      return {
        format: "octupie-draft-critique/v1",
        master: inp.master,
        durationSeconds: inp.durationSeconds,
        generatedAt: "2026-07-28T00:00:00.000Z",
        provider: { id: "claude-cli", model: "claude-code-critique" },
        approved: false,
        notes: [{ atSeconds: 2, severity: "blocker", category: "visual", note: "black frame" }],
        summary: "one blocker",
        limitations: ["sampled frames only"],
      };
    },
  };
}

function base(over: Partial<CritiqueRenderedMasterInput> = {}): CritiqueRenderedMasterInput {
  return {
    plan: makePlan(),
    masterPath: MASTER,
    outputRoot: ROOT,
    permissionPolicy: PERMISSIONS,
    sample: async () => sampleResult,
    probeDuration: async () => 6,
    provider: fakeProvider(),
    writeFile: () => {},
    ensureDir: () => {},
    now: new Date("2026-07-28T00:00:00.000Z"),
    ...over,
  };
}

describe("critiqueRenderedMaster", () => {
  it("denies network and media upload by default before sampling or spawning", async () => {
    let sampled = false;
    await expect(
      critiqueRenderedMaster(base({ permissionPolicy: undefined, sample: async () => { sampled = true; return sampleResult; } })),
    ).rejects.toThrow(/Permission denied for 'network'/);
    expect(sampled).toBe(false);
  });

  it("requires a separate media-upload grant", async () => {
    const networkOnly = createPolicy([{ action: "network", grantedBy: "t", grantedAt: "2026-07-28T00:00:00.000Z" }]);
    await expect(critiqueRenderedMaster(base({ permissionPolicy: networkOnly }))).rejects.toThrow(/Permission denied for 'media-upload'/);
  });

  it("samples, probes the real duration, critiques, and writes a validated artifact under the root", async () => {
    let seen: CritiqueInput | undefined;
    const writes: Array<{ path: string; data: string }> = [];
    const res = await critiqueRenderedMaster(
      base({ provider: fakeProvider((inp) => (seen = inp)), writeFile: (p, d) => writes.push({ path: p, data: d }) }),
    );
    expect(seen?.durationSeconds).toBe(6);
    expect(seen?.frames).toHaveLength(2);
    expect(seen?.master.path).toBe("neutral-founder-reel.mp4"); // portable relative to the root
    expect(res.frameCount).toBe(2);
    expect(res.durationSeconds).toBe(6);
    expect(res.critiquePath).toContain(".critique.json");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.data).format).toBe("octupie-draft-critique/v1");
  });

  it("refuses an output path outside the root", async () => {
    await expect(critiqueRenderedMaster(base({ outFile: "../escape.json" }))).rejects.toThrow(/outside the allowed root/);
  });
});
