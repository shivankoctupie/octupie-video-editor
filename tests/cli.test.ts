import { describe, it, expect } from "vitest";
import { requireNumberFlag, nodeMeetsMinimum, MIN_NODE_VERSION } from "../src/cli.js";

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

describe("nodeMeetsMinimum (node:sqlite runtime floor)", () => {
  it("pins the floor at 22.5.0 where node:sqlite lands", () => {
    expect(MIN_NODE_VERSION).toBe("22.5.0");
  });

  it("accepts 22.5.0 and any newer version", () => {
    expect(nodeMeetsMinimum("22.5.0")).toBe(true);
    expect(nodeMeetsMinimum("22.5.1")).toBe(true);
    expect(nodeMeetsMinimum("22.12.0")).toBe(true);
    expect(nodeMeetsMinimum("23.4.0")).toBe(true);
    expect(nodeMeetsMinimum("24.0.0")).toBe(true);
  });

  it("rejects anything below 22.5.0", () => {
    expect(nodeMeetsMinimum("22.4.9")).toBe(false);
    expect(nodeMeetsMinimum("22.0.0")).toBe(false);
    expect(nodeMeetsMinimum("20.19.0")).toBe(false);
    expect(nodeMeetsMinimum("18.20.0")).toBe(false);
  });

  it("ignores a prerelease suffix on the running version", () => {
    expect(nodeMeetsMinimum("22.5.0-nightly20240101abc")).toBe(true);
    expect(nodeMeetsMinimum("22.4.0-rc.1")).toBe(false);
  });
});
