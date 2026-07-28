/**
 * Deterministic, injectable filesystem surface and referenced-file validation for
 * the workflow layer (parity phase 8).
 *
 * Every state file (version records, the version index, the queue, the notification
 * outbox, publish receipts) lives under an explicit `stateRoot`, never beside the
 * source tree. Every referenced media/plan file must be a portable relative path
 * that resolves under an explicit `projectRoot`, survives BOTH a lexical and a
 * canonical (symlink-resolved) containment check, is a real regular non-symlink
 * file, and is hashed over its real bytes. The filesystem surface is injectable so
 * every failure path (missing file, symlink escape, canonical escape) is testable
 * deterministically and cross-platform, without needing OS symlink privileges.
 */

import {
  createHash,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "../agent/audit.js";
import { assertContainedPath, assertSafeRelativePath } from "../util/paths.js";

/** Minimal filesystem surface, injectable so failure paths are testable. */
export interface WorkflowFs {
  exists(absPath: string): boolean;
  /** Existence + type probe that does NOT follow the final symlink. */
  lstat(absPath: string): { exists: boolean; isFile: boolean; isSymlink: boolean };
  /** Canonical (symlink-resolved) real path. Used to defeat symlinked-parent escapes. */
  realpath(absPath: string): string;
  /** SHA-256 hex digest over the real bytes of a file. */
  hashFile(absPath: string): string;
  readText(absPath: string): string;
  /** Atomic write (temp + rename). */
  writeFile(absPath: string, data: string): void;
  ensureDir(absPath: string): void;
}

export const defaultWorkflowFs: WorkflowFs = {
  exists: (p) => existsSync(p),
  lstat: (p) => {
    if (!existsSync(p)) return { exists: false, isFile: false, isSymlink: false };
    const st = lstatSync(p);
    return { exists: true, isFile: st.isFile(), isSymlink: st.isSymbolicLink() };
  },
  realpath: (p) => realpathSync(p),
  hashFile: (p) => {
    const h = createHash("sha256");
    h.update(readFileSync(p));
    return h.digest("hex");
  },
  readText: (p) => readFileSync(p, "utf8"),
  writeFile: (p, data) => atomicWrite(p, data),
  ensureDir: (p) => mkdirSync(p, { recursive: true }),
};

/** Thrown for any store-level gate failure (containment, symlink, immutability, conflict). */
export class WorkflowStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowStoreError";
    this.code = code;
  }
}

export interface ValidatedFile {
  /** The portable relative path, exactly as declared. */
  relPath: string;
  /** The resolved, canonical absolute path (symlinks resolved). */
  canonicalPath: string;
  /** SHA-256 over the real bytes. */
  sha256: string;
}

/**
 * Validate a referenced file: portable relative path, lexical containment under
 * `projectRoot`, a real regular non-symlink file, canonical containment (so a
 * symlinked parent cannot escape), then hash the real bytes. Throws
 * {@link WorkflowStoreError} on any problem; never writes. `label` is used in
 * messages (e.g. "plan", "master").
 */
export function validateReferencedFile(
  relPath: unknown,
  projectRoot: string,
  fs: WorkflowFs,
  label: string,
): ValidatedFile {
  let rel: string;
  try {
    rel = assertSafeRelativePath(relPath, `${label} path`);
  } catch (err) {
    throw new WorkflowStoreError("bad-path", err instanceof Error ? err.message : String(err));
  }

  const canonicalRoot = fs.realpath(projectRoot);
  const absPath = resolve(projectRoot, rel);
  // Lexical containment first: a fast, symlink-independent guard.
  try {
    assertContainedPath(absPath, projectRoot, `${label} path`);
  } catch (err) {
    throw new WorkflowStoreError("escape", err instanceof Error ? err.message : String(err));
  }

  const st = fs.lstat(absPath);
  if (!st.exists) throw new WorkflowStoreError("missing-file", `${label} file does not exist: ${rel}`);
  if (st.isSymlink) throw new WorkflowStoreError("symlink", `${label} is a symlink, which is refused: ${rel}`);
  if (!st.isFile) throw new WorkflowStoreError("not-regular", `${label} is not a regular file: ${rel}`);

  // Canonical containment: resolve the real parent so a symlinked directory cannot
  // escape the root, then re-check the real file path stays inside.
  const realParent = fs.realpath(dirname(absPath));
  try {
    assertContainedPath(realParent, canonicalRoot, `canonical ${label} parent`);
  } catch (err) {
    throw new WorkflowStoreError("canonical-escape", err instanceof Error ? err.message : String(err));
  }
  const canonicalPath = join(realParent, rel.split(/[\\/]+/).pop()!);
  try {
    assertContainedPath(canonicalPath, canonicalRoot, `canonical ${label} path`);
  } catch (err) {
    throw new WorkflowStoreError("canonical-escape", err instanceof Error ? err.message : String(err));
  }

  const sha256 = fs.hashFile(canonicalPath);
  return { relPath: rel, canonicalPath, sha256 };
}

/** Read and JSON-parse a state file, or return null when it does not exist. */
export function readJsonState<T = unknown>(absPath: string, fs: WorkflowFs): T | null {
  if (!fs.exists(absPath)) return null;
  const raw = fs.readText(absPath);
  return JSON.parse(raw) as T;
}

/** Write a JSON state file atomically with a trailing newline. */
export function writeJsonState(absPath: string, value: unknown, fs: WorkflowFs): void {
  fs.ensureDir(dirname(absPath));
  fs.writeFile(absPath, JSON.stringify(value, null, 2) + "\n");
}
