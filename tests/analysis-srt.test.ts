import { describe, it, expect } from "vitest";
import { formatTimestamp, toSrt, toVtt } from "../src/analysis/srt.js";
import type { SegmentValue } from "../src/analysis/schemas.js";

const seg = (id: string, s: number, e: number, text: string): SegmentValue => ({ id, startSeconds: s, endSeconds: e, text, words: [] });

describe("formatTimestamp", () => {
  it("formats srt (comma) and vtt (dot) timecodes", () => {
    expect(formatTimestamp(3661.5, ",")).toBe("01:01:01,500");
    expect(formatTimestamp(3661.5, ".")).toBe("01:01:01.500");
    expect(formatTimestamp(0)).toBe("00:00:00,000");
  });
});

describe("toSrt / toVtt", () => {
  const segs = [seg("s0", 0, 1.2, "hello world"), seg("s1", 1.3, 2.0, "second line"), seg("s2", 2, 3, "   ")];
  it("numbers cues and skips empty segments in srt", () => {
    const srt = toSrt(segs);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,200\nhello world");
    expect(srt).toContain("2\n00:00:01,300 --> 00:00:02,000\nsecond line");
    expect(srt).not.toContain("3\n");
  });
  it("emits a WEBVTT header with dot timecodes", () => {
    const vtt = toVtt(segs);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.200");
  });
});
