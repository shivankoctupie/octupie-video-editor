import { describe, it, expect } from "vitest";
import { isSafeRelativePath, assertSafeRelativePath } from "../src/util/paths.js";

describe("path safety", () => {
  it("accepts portable relative paths", () => {
    expect(isSafeRelativePath("assets/logo.png")).toBe(true);
    expect(isSafeRelativePath("output/demo.mp4")).toBe(true);
    expect(isSafeRelativePath("a/b/c.wav")).toBe(true);
  });

  it("rejects drive letters, absolute roots, UNC, home, and parent escapes", () => {
    expect(isSafeRelativePath("C:/Users/user/x.mp4")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("\\\\server\\share\\x")).toBe(false);
    expect(isSafeRelativePath("~/secret")).toBe(false);
    expect(isSafeRelativePath("../escape")).toBe(false);
    expect(isSafeRelativePath("a/../../b")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
    expect(isSafeRelativePath(42 as unknown)).toBe(false);
  });

  it("assertSafeRelativePath throws on unsafe input", () => {
    expect(() => assertSafeRelativePath("/abs")).toThrow();
    expect(assertSafeRelativePath("ok/here.png")).toBe("ok/here.png");
  });
});
