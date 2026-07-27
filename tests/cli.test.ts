import { describe, it, expect } from "vitest";
import { requireNumberFlag } from "../src/cli.js";

describe("requireNumberFlag", () => {
  it("returns the parsed number for a valid flag", () => {
    expect(requireNumberFlag({ width: "1080" }, "width")).toBe(1080);
    expect(requireNumberFlag({ fps: "29.97" }, "fps")).toBeCloseTo(29.97);
  });

  it("throws a clear message when the flag is missing", () => {
    expect(() => requireNumberFlag({}, "width")).toThrow(/--width/);
  });

  it("throws a clear message when the flag is a bare boolean", () => {
    expect(() => requireNumberFlag({ height: true }, "height")).toThrow(/--height/);
  });

  it("throws a clear message when the flag is non-numeric", () => {
    expect(() => requireNumberFlag({ duration: "soon" }, "duration")).toThrow(/--duration.*number/i);
  });
});
