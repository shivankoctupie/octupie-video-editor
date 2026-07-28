/**
 * Offline local asset discovery (parity phase 4).
 *
 * Walks a single explicit asset root and returns rights-cleared candidate
 * references, entirely offline. The walk is deliberately narrow:
 *
 *   - lexical AND realpath containment: every file, and every symlink target, is
 *     proven to live under the real asset root before it is considered; a
 *     symlink or NTFS junction that escapes the root is skipped, never returned;
 *   - regular files only: directories are recursed, symlinked directories are
 *     not followed, devices and sockets are ignored;
 *   - bounded recursion depth and a bounded total file count, so a deep or huge
 *     tree cannot exhaust time or memory; hitting either bound is a diagnostic;
 *   - an extension allowlist (video, image, audio, font), so nothing unexpected
 *     is treated as an asset;
 *   - deterministic ordering by portable relative path;
 *   - NO hashing of file contents, NO shell, NO network.
 *
 * Rights come only from a validated sidecar (`<file>.rights.json`). The engine
 * never infers a permissive license from a filename, so a file with no sidecar,
 * an invalid sidecar, or an untrusted rights status yields no candidate. Query
 * tokens are matched lexically against the relative path and the sidecar title.
 */

import { readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { isSafeRelativePath } from "../util/paths.js";
import {
  isTrustedRightsStatus,
  parseRightsSidecar,
  type AssetCandidateValue,
  type AssetDiscoveryQueryValue,
  type DiscoveryDiagnosticValue,
  type MediaKind,
} from "./schemas.js";

/** Extension allowlist. Only these are treated as candidate assets. */
export const MEDIA_EXTENSIONS: Record<string, MediaKind> = {
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".mkv": "video",
  ".m4v": "video",
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".webp": "image",
  ".gif": "image",
  ".svg": "image",
  ".wav": "audio",
  ".mp3": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".flac": "audio",
  ".ogg": "audio",
  ".ttf": "font",
  ".otf": "font",
  ".woff": "font",
  ".woff2": "font",
};

/** Suffix that marks a rights sidecar for the file it sits beside. */
export const RIGHTS_SIDECAR_SUFFIX = ".rights.json";

export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_MAX_FILES = 5000;

/**
 * A directory entry, narrowed to what discovery needs. Injectable so tests can
 * build a virtual tree; the real adapter maps `fs.Dirent`.
 */
export interface DiscoveryDirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** Injectable filesystem surface. The default is real node:fs. */
export interface DiscoveryFs {
  readDir(absDir: string): DiscoveryDirEntry[];
  /** Resolve a path's canonical real path (defeats symlink/junction escapes). */
  realpath(absPath: string): string;
  /** True when the (real) path is a regular file. */
  isFile(absPath: string): boolean;
  /** Read a sidecar text file, or null when it does not exist. */
  readSidecar(absPath: string): string | null;
}

function realFs(): DiscoveryFs {
  return {
    readDir: (dir) =>
      readdirSync(dir, { withFileTypes: true }).map((d: Dirent) => ({
        name: d.name,
        isFile: d.isFile(),
        isDirectory: d.isDirectory(),
        isSymbolicLink: d.isSymbolicLink(),
      })),
    realpath: (p) => realpathSync(p),
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    readSidecar: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
  };
}

export interface LocalDiscoveryInput {
  query: AssetDiscoveryQueryValue;
  /** Absolute asset root the walk stays under. */
  root: string;
  /** Retrieval timestamp stamped on every candidate. */
  now: Date;
  maxDepth?: number;
  maxFiles?: number;
  fs?: DiscoveryFs;
}

export interface LocalDiscoveryResult {
  candidates: AssetCandidateValue[];
  diagnostics: DiscoveryDiagnosticValue[];
}

/** Split an intent into lowercase lexical tokens. */
export function intentTokens(intent: string): string[] {
  return intent
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function isContainedReal(realChild: string, realRoot: string): boolean {
  const rel = relative(realRoot, realChild);
  if (rel === "") return true;
  const first = rel.split(/[\\/]/)[0];
  return first !== ".." && !/^([a-zA-Z]:)?[\\/]/.test(rel);
}

/**
 * Discover rights-cleared local candidates. Fully offline and deterministic.
 * Every returned candidate carries a portable relative ref and a trusted rights
 * status; anything without a valid, trusted sidecar is skipped, not guessed.
 */
export function discoverLocalAssets(input: LocalDiscoveryInput): LocalDiscoveryResult {
  const fs = input.fs ?? realFs();
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const diagnostics: DiscoveryDiagnosticValue[] = [];
  const candidates: AssetCandidateValue[] = [];
  const tokens = intentTokens(input.query.intent);
  const retrievedAt = input.now.toISOString();

  let realRoot: string;
  try {
    realRoot = fs.realpath(resolve(input.root));
  } catch (err) {
    diagnostics.push({
      source: "local",
      level: "error",
      message: `Asset root is not accessible: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { candidates, diagnostics };
  }

  let filesSeen = 0;
  let truncated = false;

  const walk = (absDir: string, depth: number): void => {
    if (truncated) return;
    if (depth > maxDepth) {
      diagnostics.push({ source: "local", level: "warn", message: `Recursion depth ${maxDepth} reached; skipping deeper directories.` });
      return;
    }
    let entries: DiscoveryDirEntry[];
    try {
      entries = fs.readDir(absDir);
    } catch (err) {
      diagnostics.push({ source: "local", level: "warn", message: `Could not read directory: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    // Deterministic order regardless of filesystem enumeration order.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (truncated) return;
      const abs = join(absDir, entry.name);

      if (entry.isSymbolicLink) {
        // Resolve the real target and only accept a regular file contained under the root.
        let real: string;
        try {
          real = fs.realpath(abs);
        } catch {
          diagnostics.push({ source: "local", level: "warn", message: `Skipped unreadable symlink: ${entry.name}` });
          continue;
        }
        if (!isContainedReal(real, realRoot)) {
          diagnostics.push({ source: "local", level: "warn", message: `Skipped symlink escaping the asset root: ${entry.name}` });
          continue;
        }
        if (fs.isFile(real)) {
          if (considerFile(abs, real)) return;
        }
        // A symlinked directory is never followed (avoids junction escapes and cycles).
        continue;
      }

      if (entry.isDirectory) {
        walk(abs, depth + 1);
        continue;
      }

      if (entry.isFile) {
        if (considerFile(abs, abs)) return;
      }
      // Anything else (device, socket) is ignored.
    }
  };

  /** Returns true when the file-count bound was hit and the walk must stop. */
  const considerFile = (abs: string, realAbs: string): boolean => {
    const ext = extname(abs).toLowerCase();
    const mediaKind = MEDIA_EXTENSIONS[ext];
    if (mediaKind === undefined) return false; // not an allowlisted asset (also skips sidecars).

    filesSeen += 1;
    if (filesSeen > maxFiles) {
      truncated = true;
      diagnostics.push({ source: "local", level: "warn", message: `File-count bound ${maxFiles} reached; remaining files skipped.` });
      return true;
    }

    // Realpath containment on the actual file, not just its parent.
    let realFile: string;
    try {
      realFile = fs.realpath(realAbs);
    } catch {
      diagnostics.push({ source: "local", level: "warn", message: `Skipped unreadable file: ${abs}` });
      return false;
    }
    if (!isContainedReal(realFile, realRoot)) {
      diagnostics.push({ source: "local", level: "warn", message: `Skipped file resolving outside the asset root: ${abs}` });
      return false;
    }

    // Portable relative reference from the real root.
    const relRef = relative(realRoot, realFile).split(/[\\/]/).join("/");
    if (!isSafeRelativePath(relRef)) {
      diagnostics.push({ source: "local", level: "warn", message: `Skipped non-portable path: ${relRef}` });
      return false;
    }

    // Rights come ONLY from a validated sidecar. No sidecar => no candidate.
    const sidecarRaw = fs.readSidecar(realFile + RIGHTS_SIDECAR_SUFFIX);
    if (sidecarRaw === null) {
      diagnostics.push({ source: "local", level: "info", message: `Skipped '${relRef}': no rights sidecar; a permissive license is never inferred from a filename.` });
      return false;
    }
    let sidecarJson: unknown;
    try {
      sidecarJson = JSON.parse(sidecarRaw);
    } catch {
      diagnostics.push({ source: "local", level: "warn", message: `Skipped '${relRef}': rights sidecar is not valid JSON.` });
      return false;
    }
    const parsed = parseRightsSidecar(sidecarJson);
    if (!parsed.ok || !parsed.data) {
      diagnostics.push({ source: "local", level: "warn", message: `Skipped '${relRef}': invalid rights sidecar (${parsed.errors.join("; ")}).` });
      return false;
    }
    const rights = parsed.data;
    if (!isTrustedRightsStatus(rights.rightsStatus)) {
      diagnostics.push({ source: "local", level: "warn", message: `Skipped '${relRef}': rights status '${rights.rightsStatus}' is not cleared for reuse.` });
      return false;
    }

    // Lexical token match against the path and the sidecar title.
    const title = rights.title ?? relRef.split("/").pop() ?? relRef;
    const haystack = `${relRef} ${title}`.toLowerCase();
    const matched = tokens.filter((t) => haystack.includes(t));
    if (tokens.length > 0 && matched.length === 0) return false; // not relevant to the intent.
    const relevance = tokens.length === 0 ? 0.5 : matched.length / tokens.length;

    candidates.push({
      source: "local",
      ref: relRef,
      title,
      relevance,
      mediaKind,
      intentMatch: matched.length > 0 ? `matched tokens: ${matched.join(", ")}` : "no query tokens; returned by root scan",
      provenance: rights.provenance,
      license: {
        id: rights.licenseId,
        ...(rights.licenseUrl ? { url: rights.licenseUrl } : {}),
        attributionRequired: rights.attributionRequired,
        ...(rights.attributionText ? { attributionText: rights.attributionText } : {}),
      },
      rightsStatus: rights.rightsStatus,
      retrievedAt,
      bytesLocal: true,
    });
    return false;
  };

  walk(realRoot, 0);

  // Deterministic final order: relevance desc, then ref asc.
  candidates.sort((a, b) => (b.relevance - a.relevance) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { candidates, diagnostics };
}
