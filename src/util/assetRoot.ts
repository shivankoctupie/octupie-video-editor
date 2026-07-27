/**
 * Portable asset-root contract.
 *
 * Every local media path in an edit plan (source clips, dialogue, music, SFX)
 * resolves under one root directory. The root defaults to `<project cwd>/assets`
 * and can be overridden with the `OVE_ASSET_ROOT` environment variable. Paths
 * from the plan are always safe relative paths (validated by the schema); this
 * layer resolves them to absolute paths and re-checks containment so a plan can
 * never reach outside the configured root, even across symlinks or odd
 * normalization. It reuses the same safe-path helper the schema uses.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { assertSafeRelativePath } from "./paths.js";

/** Absolute path of the configured asset root. */
export function assetRoot(): string {
  const dir = process.env.OVE_ASSET_ROOT?.trim() || "assets";
  return resolve(process.cwd(), dir);
}

/**
 * Resolve a plan-supplied relative path to an absolute path under the asset
 * root. Throws on any non-portable path or any path that escapes the root.
 */
export function resolveAssetPath(relPath: unknown, label = "asset"): string {
  const safe = assertSafeRelativePath(relPath, label);
  const root = assetRoot();
  const abs = resolve(root, safe);
  const rel = relative(root, abs);
  const firstSegment = rel.split(/[\\/]/)[0];
  if (firstSegment === ".." || isAbsolute(rel)) {
    throw new Error(`${label} escapes the asset root: ${JSON.stringify(relPath)}`);
  }
  return abs;
}

/**
 * Resolve a path under the asset root and confirm the file exists. Used before
 * render so missing or escaping media fails fast rather than mid-pipeline.
 */
export function resolveExistingAssetPath(relPath: unknown, label = "asset"): string {
  const abs = resolveAssetPath(relPath, label);
  if (!existsSync(abs)) {
    throw new Error(
      `Missing ${label} under asset root: ${JSON.stringify(relPath)} (looked in ${assetRoot()})`,
    );
  }

  // Lexical checks stop `..` and absolute paths. Real-path containment also
  // stops a symlink inside the asset directory from pointing to a private file.
  const realRoot = realpathSync(assetRoot());
  const realAsset = realpathSync(abs);
  const rel = relative(realRoot, realAsset);
  const firstSegment = rel.split(/[\\/]/)[0];
  if (firstSegment === ".." || isAbsolute(rel)) {
    throw new Error(`${label} resolves outside the asset root: ${JSON.stringify(relPath)}`);
  }
  if (!statSync(realAsset).isFile()) {
    throw new Error(`${label} must resolve to a file: ${JSON.stringify(relPath)}`);
  }
  return realAsset;
}
