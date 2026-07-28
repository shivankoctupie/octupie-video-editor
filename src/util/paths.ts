/**
 * Path safety helpers. Every file path in an edit plan must be a portable,
 * relative path with no drive letters, no absolute roots, and no parent-escape
 * segments. This keeps plans reproducible across machines and prevents a plan
 * from reaching outside its project sandbox.
 */

import { isAbsolute, relative, resolve } from "node:path";

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const ABSOLUTE_POSIX = /^[\\/]/;
const UNC = /^\\\\/;

export function isSafeRelativePath(input: unknown): input is string {
  if (typeof input !== "string") return false;
  const value = input.trim();
  if (value.length === 0) return false;
  if (value.includes("\0")) return false;
  if (WINDOWS_DRIVE.test(value)) return false;
  if (UNC.test(value)) return false;
  if (ABSOLUTE_POSIX.test(value)) return false;
  // Reject `~` home expansion and any parent-directory segment.
  if (value.startsWith("~")) return false;
  const segments = value.split(/[\\/]+/);
  for (const segment of segments) {
    if (segment === "..") return false;
  }
  return true;
}

export function assertSafeRelativePath(input: unknown, label = "path"): string {
  if (!isSafeRelativePath(input)) {
    throw new Error(`Unsafe or non-portable ${label}: ${JSON.stringify(input)}`);
  }
  return input.trim();
}

/**
 * Lexical containment check: true when `childAbs` is the same as, or lives
 * under, `rootAbs`. Both must already be resolved absolute paths. Used to keep a
 * file read (analysis artifact, evidence frame, granted directory) inside an
 * approved root before anything is spawned. This is a string test on normalized
 * paths; callers that must also defeat symlinks resolve real paths first.
 */
export function isContainedPath(childAbs: string, rootAbs: string): boolean {
  const normalize = (p: string): string => resolve(p).replace(/[\\/]+$/, "");
  const root = normalize(rootAbs);
  const child = normalize(childAbs);
  if (child === root) return true;
  const rel = relative(root, child);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(/[\\/]+/).includes("..");
}

/** Throw unless `childAbs` is contained under `rootAbs`. */
export function assertContainedPath(childAbs: string, rootAbs: string, label = "path"): string {
  if (!isContainedPath(childAbs, rootAbs)) {
    throw new Error(`${label} is outside the allowed root: ${JSON.stringify(childAbs)} (root ${JSON.stringify(rootAbs)})`);
  }
  return childAbs;
}
