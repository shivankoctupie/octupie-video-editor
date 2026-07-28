/**
 * Portable-path and protected-location guard for improvement patches.
 *
 * Every operation path in a patch must be a portable, relative, forward-slash
 * path that lands under one of a small allow-list of roots and never touches a
 * protected file. This is a pure lexical check on the path STRING; the apply
 * engine adds runtime defenses (hash preflight, lstat regular-file check, and
 * canonical containment via realpath) on top of it. Belt and suspenders: the
 * allow-list already excludes `.git`, `node_modules`, and `output`, but the
 * denylist rejects them (and credential/binary files) explicitly too.
 */

/** Directory roots a patch may write under. */
export const ALLOWED_DIR_ROOTS = ["src", "tests", "skills", "prompts"] as const;

/** Exact repo-root files a patch may write. Nothing else at the root is writable. */
export const ALLOWED_ROOT_FILES = ["README.md", "AGENTS.md"] as const;

/** Path segments that are never allowed anywhere in a path. */
const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".github",
  ".svn",
  ".hg",
  "node_modules",
  "output",
  "dist",
  "build",
  ".ssh",
  ".gnupg",
  ".vscode",
]);

/** Filename patterns for env/auth/credential material. Rejected under any root. */
const FORBIDDEN_BASENAME = [
  /^\.?env(\..*)?$/i,
  /(^|[._-])(secret|secrets|credential|credentials|password|passwd|token|apikey)([._-]|$)/i,
  /(^|[._-])id_(rsa|dsa|ecdsa|ed25519)([._-]|$)/i,
  /\.(pem|key|pfx|p12|keystore|jks|crt|cer|der)$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
];

/** Binary/asset extensions a text patch must never write. */
const FORBIDDEN_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".mp3", ".wav", ".flac", ".ogg",
  ".zip", ".gz", ".tar", ".tgz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".wasm", ".bin", ".class", ".jar",
  ".pdf", ".woff", ".woff2", ".ttf", ".otf", ".eot",
]);

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot).toLowerCase();
}

/**
 * Return an error string if `input` is not a safe, portable, allowed-root path;
 * otherwise return null. The single source of truth both {@link isPortableAllowedPath}
 * and the apply engine use, so a schema and a preflight can never disagree.
 */
export function checkPortableAllowedPath(input: unknown): string | null {
  if (typeof input !== "string") return "path must be a string";
  if (input.length === 0) return "path must not be empty";
  if (input !== input.trim()) return "path must not have leading or trailing whitespace";
  if (input.includes("\0")) return "path must not contain a NUL byte";
  if (input.includes("\\")) return "path must use forward slashes, not backslashes";
  if (WINDOWS_DRIVE.test(input)) return "path must not be an absolute drive path";
  if (input.startsWith("/")) return "path must be relative, not absolute";
  if (input.startsWith("~")) return "path must not use '~' home expansion";

  const segments = input.split("/");
  for (const seg of segments) {
    if (seg.length === 0) return "path must not contain empty segments";
    if (seg === "." || seg === "..") return "path must not contain '.' or '..' segments";
    if (FORBIDDEN_SEGMENTS.has(seg.toLowerCase())) return `path must not touch the protected location '${seg}'`;
  }

  const basename = segments[segments.length - 1]!;
  for (const pattern of FORBIDDEN_BASENAME) {
    if (pattern.test(basename)) return `path targets a protected env/auth/credential file: '${basename}'`;
  }
  if (FORBIDDEN_EXT.has(extensionOf(basename))) return `path targets a binary/asset file, which a text patch may not write: '${basename}'`;

  // Allow-list the root: an exact root file, or one of the allowed directory roots.
  if ((ALLOWED_ROOT_FILES as readonly string[]).includes(input)) return null;
  const first = segments[0]!;
  if (!(ALLOWED_DIR_ROOTS as readonly string[]).includes(first)) {
    return `path root '${first}' is not allowed; use one of: ${ALLOWED_DIR_ROOTS.join("/, ")}/ or ${ALLOWED_ROOT_FILES.join(", ")}`;
  }
  if (segments.length < 2) return `path '${input}' names a root directory, not a file`;
  return null;
}

export function isPortableAllowedPath(input: unknown): input is string {
  return checkPortableAllowedPath(input) === null;
}

export function assertPortableAllowedPath(input: unknown, label = "path"): string {
  const err = checkPortableAllowedPath(input);
  if (err) throw new Error(`Unsafe ${label}: ${err}`);
  return (input as string).trim();
}
