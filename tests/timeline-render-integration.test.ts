import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toEditPlan } from "../src/client/state/editPlanMap.js";
import { emptyDoc, makeClip, makeTrack } from "../src/client/state/factory.js";
import type { TimelineDoc } from "../src/client/state/types.js";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import { renderPlan } from "../src/pipeline.js";
import { runFfmpeg } from "../src/ffmpeg/spawn.js";
import { probe, audioStream } from "../src/ffmpeg/ffprobe.js";

/*
 * LIVE final-master fidelity: a real uploaded MP4 (video + audio) on the video track, a solid
 * overlay image on a second track, and a styled caption on a third. This exercises the REAL
 * Remotion timeline render, the FFmpeg timeline-audio assembly, the mux, and QA. It proves the
 * TIMELINE content reached the master, not just its resolution: the overlay is timeline-only
 * content the legacy scene/caption projection cannot produce, so finding the overlay's color at
 * the composition center is decisive evidence the timeline render path ran. Expensive (Remotion
 * downloads a headless browser on first run); set OVE_SKIP_RENDER_TESTS=1 to skip locally.
 */
const skip = process.env.OVE_SKIP_RENDER_TESTS === "1";

const W = 1080;
const H = 1920;
const FPS = 30;
const DUR = 3;

let root: string;
let outDir: string;

async function ff(args: string[]): Promise<void> {
  const res = await runFfmpeg(args);
  if (res.code !== 0) throw new Error(`ffmpeg failed: ${res.stderr.trim().slice(0, 400)}`);
}

/** Read the average RGB of a small crop of one frame at `t` seconds (deterministic, via a raw
 * 1x1 rgb24 file so no binary passes through a string stdout). */
async function sampleRgb(file: string, t: number, crop: string): Promise<[number, number, number]> {
  const raw = join(outDir, `px-${crop.replace(/[^0-9]/g, "_")}-${Math.round(t * 100)}.rgb`);
  await ff(["-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `${crop},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-y", raw]);
  const b = readFileSync(raw);
  return [b[0]!, b[1]!, b[2]!];
}

function timelineDoc(): TimelineDoc {
  const doc = emptyDoc({ title: "Timeline Master", duration: DUR, width: W, height: H, fps: FPS, composition: "FounderSocialReel" });
  doc.tracks = [makeTrack("video", "tk-v", "Video"), makeTrack("overlay", "tk-o", "Overlay"), makeTrack("caption", "tk-c", "Captions")];
  doc.clips = [
    makeClip({ id: "v", trackId: "tk-v", start: 0, duration: DUR, mediaId: "vid", sourceIn: 0, sourceDuration: DUR, volume: 1 }),
    // A centered magenta overlay at 60% scale: the timeline-only content the legacy path can't emit.
    makeClip({ id: "o", trackId: "tk-o", start: 0, duration: DUR, mediaId: "ovl", transform: { x: 0, y: 0, scale: 0.6, rotation: 0, opacity: 1 } }),
    makeClip({ id: "c", trackId: "tk-c", start: 0, duration: DUR, text: "live proof", captionStyle: { fontSize: 64, color: "#F5F5F5", background: "#000000", align: "center", bold: true } }),
  ];
  return doc;
}

beforeAll(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), "oct-tl-root-"));
  outDir = mkdtempSync(join(tmpdir(), "oct-tl-out-"));
  // A real "uploaded" MP4 with a video and an audio stream.
  await ff([
    "-f", "lavfi", "-i", `testsrc=size=${W}x${H}:rate=${FPS}:duration=${DUR}`,
    "-f", "lavfi", "-i", `sine=frequency=330:sample_rate=48000:duration=${DUR}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", join(root, "hero.mp4"),
  ]);
  // A full-frame magenta overlay image (255,0,255).
  await ff(["-f", "lavfi", "-i", `color=c=magenta:size=${W}x${H}`, "-frames:v", "1", "-y", join(root, "overlay.png")]);
}, 120000);

afterAll(() => {
  for (const p of [root, outDir]) if (p) rmSync(p, { recursive: true, force: true });
  delete process.env.OVE_ASSET_ROOT;
});

describe.skipIf(skip)("timeline final-master fidelity (live render)", () => {
  it(
    "renders the whole timeline (video + overlay + caption), passes QA, and the overlay reaches the master",
    async () => {
      // Build the plan the way the editor does: mediaId locally, mediaPath resolved on save.
      const resolve = (id: string): string | null => (id === "vid" ? "hero.mp4" : id === "ovl" ? "overlay.png" : null);
      const parsed = parseEditPlan(toEditPlan(timelineDoc(), resolve));
      expect(parsed.ok, parsed.errors.join("; ")).toBe(true);
      const plan = parsed.plan as EditPlan;
      // The timeline (with resolved media paths) is what will drive the render.
      expect(plan.timeline).toBeDefined();
      expect(plan.timeline!.clips.find((c) => c.id === "o")!.mediaPath).toBe("overlay.png");
      expect(plan.timeline!.clips.find((c) => c.id === "v")!.mediaPath).toBe("hero.mp4");

      process.env.OVE_ASSET_ROOT = root;
      const result = await renderPlan(plan, { dir: outDir });

      // Master exists and every QA gate passed against the exact delivered bytes.
      const failed = result.report.gates.filter((g) => !g.pass).map((g) => `${g.name}: ${g.detail}`);
      expect(failed, `failed gates: ${failed.join("; ")}`).toHaveLength(0);
      expect(result.report.pass).toBe(true);

      // The delivered master carries a real audio stream sourced from the timeline video clip.
      const probed = await probe(result.finalPath);
      expect(audioStream(probed)).toBeTruthy();
      // Geometry and length come from the timeline.
      expect(Math.abs(Number(probed.format.duration) - DUR)).toBeLessThan(0.6);

      // DECISIVE: the composition center shows the overlay's magenta (timeline-only content), and
      // a corner shows the video beneath it (real compositing, not a single flattened layer).
      const [cr, cg, cb] = await sampleRgb(result.finalPath, DUR / 2, `crop=40:40:(iw-40)/2:(ih-40)/2`);
      expect(cr, `center r=${cr}`).toBeGreaterThan(170);
      expect(cb, `center b=${cb}`).toBeGreaterThan(170);
      expect(cg, `center g=${cg}`).toBeLessThan(110);
      const [tr, tg, tb] = await sampleRgb(result.finalPath, DUR / 2, `crop=40:40:0:0`);
      const cornerIsMagenta = tr > 170 && tb > 170 && tg < 110;
      expect(cornerIsMagenta, `corner rgb=${tr},${tg},${tb} should not be the overlay color`).toBe(false);
    },
    300000,
  );
});
