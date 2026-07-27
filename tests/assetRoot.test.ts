import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assetRoot, resolveAssetPath, resolveExistingAssetPath } from "../src/util/assetRoot.js";

const ORIGINAL = process.env.OVE_ASSET_ROOT;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OVE_ASSET_ROOT;
  else process.env.OVE_ASSET_ROOT = ORIGINAL;
});

describe("asset root contract", () => {
  it("defaults to <cwd>/assets", () => {
    delete process.env.OVE_ASSET_ROOT;
    expect(assetRoot()).toBe(resolve(process.cwd(), "assets"));
  });

  it("honors OVE_ASSET_ROOT", () => {
    const dir = mkdtempSync(join(tmpdir(), "ove-root-"));
    process.env.OVE_ASSET_ROOT = dir;
    expect(assetRoot()).toBe(resolve(dir));
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a safe relative path under the root", () => {
    delete process.env.OVE_ASSET_ROOT;
    expect(resolveAssetPath("clips/a.mp4")).toBe(resolve(process.cwd(), "assets", "clips/a.mp4"));
  });

  it("rejects escaping and absolute paths", () => {
    expect(() => resolveAssetPath("../secret.mp4")).toThrow();
    expect(() => resolveAssetPath("C:/Users/user/x.mp4")).toThrow();
    expect(() => resolveAssetPath("/etc/passwd")).toThrow();
  });

  it("resolveExistingAssetPath throws when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ove-root-"));
    process.env.OVE_ASSET_ROOT = dir;
    expect(() => resolveExistingAssetPath("nope.wav", "sfx")).toThrow(/Missing sfx/);
    writeFileSync(join(dir, "there.wav"), "x");
    expect(resolveExistingAssetPath("there.wav", "sfx")).toBe(resolve(dir, "there.wav"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a junction that resolves outside the asset root", () => {
    const root = mkdtempSync(join(tmpdir(), "ove-root-"));
    const outside = mkdtempSync(join(tmpdir(), "ove-outside-"));
    writeFileSync(join(outside, "secret.wav"), "x");
    symlinkSync(outside, join(root, "escape"), "junction");
    process.env.OVE_ASSET_ROOT = root;
    expect(() => resolveExistingAssetPath("escape/secret.wav", "sfx")).toThrow(/outside the asset root/);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
