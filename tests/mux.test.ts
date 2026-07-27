import { describe, it, expect } from "vitest";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import { buildMuxArgs } from "../src/ffmpeg/audio.js";

function plan(): EditPlan {
  const raw = {
    format: "octupie-edit-plan/v1",
    title: "Mux Test",
    preset: "neutral-founder-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 4,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes: [{ id: "s1", type: "hook", start: 0, end: 4, heading: "Hi" }],
    output: { fileName: "output/demo.mp4" },
  };
  const r = parseEditPlan(raw);
  if (!r.ok || !r.plan) throw new Error(r.errors.join("; "));
  return r.plan;
}

describe("buildMuxArgs", () => {
  const p = plan();
  const args = buildMuxArgs(p, "v.silent.mp4", "a.bed.wav", "out.mp4", 4);
  const joined = args.join(" ");

  it("never truncates the visual tail with -shortest", () => {
    expect(args).not.toContain("-shortest");
  });

  it("preserves the full planned duration with explicit -t duration control", () => {
    expect(args).toContain("-t");
    expect(joined).toContain("-t 4.000");
  });

  it("maps the silent video and assembled audio and strips metadata", () => {
    expect(joined).toContain("-map 0:v:0");
    expect(joined).toContain("-map 1:a:0");
    expect(joined).toContain("-c:v copy");
    expect(joined).toContain("-map_metadata -1");
  });
});
