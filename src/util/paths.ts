/**
 * Path safety helpers. Every file path in an edit plan must be a portable,
 * relative path with no drive letters, no absolute roots, and no parent-escape
 * segments. This keeps plans reproducible across machines and prevents a plan
 * from reaching outside its project sandbox.
 */

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
