import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEditPlan, type EditPlan } from "../src/schema/editPlan.js";
import { buildAudioAssemblyArgs, buildTimelineAudioArgs, assembleAudio } from "../src/ffmpeg/audio.js";
import { runFfmpeg } from "../src/ffmpeg/spawn.js";
import { probe, audioStream } from "../src/ffmpeg/ffprobe.js";

function plan(overrides: Record<string, unknown> = {}): EditPlan {
  const raw = {
    format: "octupie-edit-plan/v1",
    title: "Audio Test",
    preset: "neutral-founder-reel",
    composition: "FounderSocialReel",
    width: 1080,
    height: 1920,
    fps: 30,
    duration: 4,
    brand: { name: "Octupie", font: "Geist", paper: "#F7F5F0", ink: "#111111", accent: "#014CE3" },
    scenes: [{ id: "s1", type: "hook", start: 0, end: 4, heading: "Hi" }],
    output: { fileName: "output/demo.mp4" },
    ...overrides,
  };
  const r = parseEditPlan(raw);
  if (!r.ok || !r.plan) throw new Error(r.errors.join("; "));
  return r.plan;
}

describe("buildAudioAssemblyArgs", () => {
  const p = plan();
  const args = buildAudioAssemblyArgs(p, 4, {
    dialogue: "/abs/dialogue.wav",
    music: "/abs/music.wav",
    sfx: [{ abs: "/abs/whoosh.wav", timeMs: 1250, durationSeconds: 0.25 }],
  });
  const joined = args.join(" ");
  const fc = args[args.indexOf("-filter_complex") + 1]!;

  it("pins length with a silent base and an explicit output duration", () => {
    expect(joined).toContain("anullsrc");
    expect(fc).toContain("[base]");
    expect(args).toContain("-t");
    expect(joined).toContain("-t 4.000");
  });

  it("resamples to stereo 48 kHz and loudness-normalizes to the plan target", () => {
    expect(args).toContain("-ar");
    expect(args).toContain("48000");
    expect(args).toContain("-ac");
    expect(fc).toContain("aresample=48000");
    expect(fc).toContain("loudnorm=I=-16:TP=-1.5");
  });

  it("delays each SFX to its cue time and loops music under dialogue", () => {
    expect(fc).toContain("adelay=1250|1250");
    expect(fc).toContain("atrim=duration=0.250");
    expect(fc).toContain("amix=inputs=4");
    expect(joined).toContain("-stream_loop -1 -i /abs/music.wav");
    expect(args).toContain("/abs/dialogue.wav");
    expect(args).toContain("/abs/whoosh.wav");
  });

  it("never uses -shortest", () => {
    expect(args).not.toContain("-shortest");
  });
});

describe("buildTimelineAudioArgs", () => {
  const p = plan();
  const clips = [
    { abs: "/abs/hero.mp4", startMs: 0, sourceIn: 1.5, duration: 4, volume: 0.8 },
    { abs: "/abs/track.wav", startMs: 2000, sourceIn: 0, duration: 3, volume: 0.5 },
  ];
  const args = buildTimelineAudioArgs(p, 6, clips);
  const joined = args.join(" ");
  const fc = args[args.indexOf("-filter_complex") + 1]!;

  it("pins length with a silent base and an explicit output duration", () => {
    expect(joined).toContain("anullsrc");
    expect(fc).toContain("[base]");
    expect(joined).toContain("-t 6.000");
  });

  it("trims each clip to its source in-point and timeline duration", () => {
    expect(fc).toContain("atrim=start=1.500:end=5.500"); // sourceIn 1.5 .. 1.5 + 4
    expect(fc).toContain("atrim=start=0.000:end=3.000"); // sourceIn 0 .. 0 + 3
  });

  it("delays each clip to its timeline start and applies its clip volume", () => {
    expect(fc).toContain("adelay=0|0");
    expect(fc).toContain("adelay=2000|2000");
    expect(fc).toContain("volume=0.8");
    expect(fc).toContain("volume=0.5");
  });

  it("resamples to stereo 48 kHz, mixes onto the base, and loudness-normalizes to the plan target", () => {
    expect(fc).toContain("aresample=48000");
    expect(fc).toContain("amix=inputs=3"); // two clips + silent base
    expect(fc).toContain("loudnorm=I=-16:TP=-1.5");
    expect(args).toContain("/abs/hero.mp4");
    expect(args).toContain("/abs/track.wav");
  });

  it("never uses -shortest", () => {
    expect(args).not.toContain("-shortest");
  });
});

describe("assembleAudio (live)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    delete process.env.OVE_ASSET_ROOT;
  });

  async function synth(path: string, freq: number): Promise<void> {
    const res = await runFfmpeg([
      "-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000:duration=6`,
      "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", "-y", path,
    ]);
    if (res.code !== 0) throw new Error(res.stderr);
  }

  it("assembles a stereo 48 kHz WAV of the planned length from real files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ove-audio-"));
    roots.push(root);
    process.env.OVE_ASSET_ROOT = root;
    await synth(join(root, "dialogue.wav"), 220);
    await synth(join(root, "whoosh.wav"), 800);
    const p = plan({
      audio: {
        targetLufs: -16,
        truePeakDb: -1.5,
        dialoguePath: "dialogue.wav",
        sfx: [{ time: 1, asset: "whoosh.wav", family: "whoosh", intensity: "support", role: "move" }],
      },
    });
    const out = join(root, "bed.wav");
    await assembleAudio(p, 4, out);
    const probed = await probe(out);
    const a = audioStream(probed);
    expect(a?.codec_name).toBe("pcm_s16le");
    expect(Number(a?.sample_rate)).toBe(48000);
    expect(a?.channels).toBe(2);
    expect(Math.abs(Number(probed.format.duration) - 4)).toBeLessThan(0.2);
  }, 60000);

  it("falls back to the procedural bed when no external audio is declared", async () => {
    const root = mkdtempSync(join(tmpdir(), "ove-audio-"));
    roots.push(root);
    process.env.OVE_ASSET_ROOT = root;
    const p = plan(); // no dialogue, music, or sfx
    const out = join(root, "bed.wav");
    await assembleAudio(p, 3, out);
    const probed = await probe(out);
    expect(Number(probed.format.duration)).toBeGreaterThan(2.5);
  }, 60000);
});
