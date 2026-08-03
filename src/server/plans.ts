/**
 * Plan storage. A saved plan is written as pretty JSON under
 * `<storageRoot>/<tenant>/<project>/plans/<sha>.json` and identified by the SHA-256 of
 * the exact bytes written, which becomes the version's `planSha256`. Writes are atomic
 * and content-addressed, so saving an identical plan is a no-op and a plan file is never
 * overwritten with different bytes. Every path is contained under the storage root.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicWrite } from "../agent/audit.js";
import { assertContainedPath } from "../util/paths.js";
import { assertSafeSegment } from "./storage/adapter.js";

export interface SavedPlan {
  relPath: string;
  sha256: string;
}

export function planRelPath(tenantId: string, projectId: string, sha256: string): string {
  assertSafeSegment(tenantId, "tenantId");
  assertSafeSegment(projectId, "projectId");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("plan sha256 must be a 64-char hex digest");
  return `${tenantId}/${projectId}/plans/${sha256}.json`;
}

/** Serialize, hash, and atomically write a plan. Returns its relative path and digest. */
export function writePlan(storageRoot: string, tenantId: string, projectId: string, plan: unknown): SavedPlan {
  const text = JSON.stringify(plan, null, 2) + "\n";
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const relPath = planRelPath(tenantId, projectId, sha256);
  const abs = resolve(storageRoot, relPath);
  assertContainedPath(abs, resolve(storageRoot), "plan path");
  if (!existsSync(abs)) {
    mkdirSync(dirname(abs), { recursive: true });
    atomicWrite(abs, text);
  }
  return { relPath, sha256 };
}

/** Read a plan JSON by its relative path, contained under the storage root. */
export function readPlan(storageRoot: string, relPath: string): unknown {
  const abs = resolve(storageRoot, relPath);
  assertContainedPath(abs, resolve(storageRoot), "plan path");
  return JSON.parse(readFileSync(abs, "utf8"));
}
