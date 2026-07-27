import { describe, it, expect } from "vitest";
import { extractJsonObject } from "../src/agent/json.js";
import { buildAssetManifest, renderManifestText } from "../src/agent/manifest.js";
import type { AgentBrief } from "../src/agent/brief.js";

describe("extractJsonObject", () => {
  it("parses a bare JSON object", () => {
    const r = extractJsonObject('{"a":1}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });

  it("recovers JSON from a markdown code fence", () => {
    const raw = "Here is the plan:\n```json\n{\"a\": 2, \"b\": [1,2]}\n```\nDone.";
    const r = extractJsonObject(raw);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 2, b: [1, 2] });
  });

  it("recovers the first balanced object embedded in prose", () => {
    const raw = 'blah blah {"x": {"y": 3}} trailing text';
    const r = extractJsonObject(raw);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ x: { y: 3 } });
  });

  it("ignores braces inside strings", () => {
    const r = extractJsonObject('prefix {"note": "a } brace"} suffix');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ note: "a } brace" });
  });

  it("returns an error when there is no JSON object", () => {
    const r = extractJsonObject("no json here at all");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("returns an error on malformed JSON", () => {
    const r = extractJsonObject('{"a": }');
    expect(r.ok).toBe(false);
  });
});

function brief(): AgentBrief {
  return {
    format: "octupie-agent-brief/v1",
    objective: "obj",
    audience: "aud",
    platform: "reels",
    preset: "neutral-founder-reel",
    desiredDurationSeconds: 12,
    sourceClips: [
      { id: "hero", path: "clips/hero.mp4" },
      { id: "missing", path: "clips/gone.mp4" },
    ],
    output: { fileName: "output/x.mp4" },
    constraints: [],
  } as AgentBrief;
}

describe("buildAssetManifest", () => {
  it("produces a text manifest from probed clips and never includes bytes", async () => {
    const manifest = await buildAssetManifest(brief(), {
      probe: async (id) =>
        id === "hero"
          ? { ok: true, durationSeconds: 8.3, width: 1080, height: 1920, hasAudio: true, codec: "h264" }
          : { ok: false, error: "missing file" },
    });
    expect(manifest.clips).toHaveLength(2);
    const hero = manifest.clips.find((c) => c.id === "hero")!;
    expect(hero.probed).toBe(true);
    expect(hero.durationSeconds).toBeCloseTo(8.3);
    const missing = manifest.clips.find((c) => c.id === "missing")!;
    expect(missing.probed).toBe(false);

    const text = renderManifestText(manifest);
    expect(text).toMatch(/hero/);
    expect(text).toMatch(/1080x1920/);
    expect(text).toMatch(/missing/i);
    // Textual only: no data URIs or base64 payloads.
    expect(text).not.toMatch(/base64|data:/i);
  });

  it("marks every clip unprobed when no prober is supplied", async () => {
    const manifest = await buildAssetManifest(brief(), {});
    expect(manifest.clips.every((c) => !c.probed)).toBe(true);
  });
});
