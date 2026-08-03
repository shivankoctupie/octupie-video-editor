import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import { resolvePlanMedia } from "../src/render/preflight.js";

/*
 * The render preflight resolves every local media path a plan references under the asset root
 * and confirms it exists, so a missing or escaping asset fails before any render work. It must
 * now cover timeline media too (the whole timeline reaches the master), and it must fail closed
 * on a media-backed timeline clip that resolved no path.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  delete process.env.OVE_ASSET_ROOT;
});

function root(): string {
  const d = mkdtempSync(join(tmpdir(), "oct-pf-"));
  roots.push(d);
  process.env.OVE_ASSET_ROOT = d;
  return d;
}

function planWithTimeline(clip: Record<string, unknown>): EditPlan {
  const raw = {
    format: "octupie-edit-plan/v1",
    title: "Preflight",
    preset: "neutral-founder-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 6,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes: [{ id: "s1", type: "hook", start: 0, end: 6, heading: "Hi" }],
    output: { fileName: "output/demo.mp4" },
    timeline: {
      version: 1,
      width: 1080,
      height: 1920,
      fps: 30,
      duration: 6,
      tracks: [{ id: "tk-v", kind: "video", name: "Video", muted: false, locked: false }],
      clips: [
        {
          id: "tc1",
          trackId: "tk-v",
          start: 0,
          duration: 6,
          mediaId: "m1",
          sourceIn: 0,
          sourceDuration: null,
          text: "",
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          volume: 1,
          captionStyle: null,
          name: "clip",
          ...clip,
        },
      ],
    },
  };
  const r = parseEditPlan(raw);
  if (!r.ok || !r.plan) throw new Error(r.errors.join("; "));
  return r.plan;
}

describe("resolvePlanMedia: timeline media", () => {
  it("resolves a timeline clip's media file when it exists under the asset root", () => {
    const dir = root();
    writeFileSync(join(dir, "hero.mp4"), "video-bytes");
    const plan = planWithTimeline({ mediaPath: "hero.mp4" });
    expect(() => resolvePlanMedia(plan)).not.toThrow();
  });

  it("throws when a timeline clip's media file is missing under the asset root", () => {
    root();
    const plan = planWithTimeline({ mediaPath: "missing.mp4" });
    expect(() => resolvePlanMedia(plan)).toThrow();
  });

  it("fails closed on a media-backed timeline clip that carries no path", () => {
    root();
    const plan = planWithTimeline({ mediaId: "m1", mediaPath: undefined });
    expect(() => resolvePlanMedia(plan)).toThrow(/tc1|resolved media path|no media/i);
  });
});
