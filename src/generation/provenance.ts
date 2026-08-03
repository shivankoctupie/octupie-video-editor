/**
 * Atomic storage plus provenance sidecars for generated assets.
 *
 * Every generated asset is written with a matching `<asset>.provenance.json`
 * sidecar that records its kind, provider, mime, byte length, SHA-256, and a
 * `synthetic: true` flag with a human-readable label. The store enforces the
 * boundary structurally: the relative path must be portable and stay inside the
 * output directory, the mime must be approved for the asset kind, the byte length
 * must be under a hard cap, and an existing asset is never overwritten. The bytes
 * and the sidecar are each written atomically (temp file, then rename) so a
 * crashed run cannot leave a half-written asset that reads as complete.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicWrite } from "../agent/audit.js";
import { assertContainedPath, assertSafeRelativePath } from "../util/paths.js";
import { APPROVED_AUDIO_MIME, APPROVED_IMAGE_MIME } from "./contracts.js";
import { GENERATED_ASSET_FORMAT, GEN_LIMITS, parseGeneratedAsset, type GeneratedAssetValue } from "./schemas.js";

/** Hard cap on any single generated asset. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

export interface WriteGeneratedAssetInput {
  /** Directory the asset must live inside. */
  outDir: string;
  /** Portable, relative path for the asset under `outDir`. */
  relPath: string;
  bytes: Uint8Array;
  mime: string;
  kind: "image" | "audio";
  provider: string;
  model?: string;
  requestSummary: string;
  /** Human-readable, machine-generated label; recorded in the sidecar. */
  label: string;
  /** Injected clock for the record timestamp. */
  now: Date;
}

export interface WriteGeneratedAssetResult {
  record: GeneratedAssetValue;
  assetPath: string;
  sidecarPath: string;
}

/** Write bytes to `path` atomically: write a sibling temp file, then rename. */
function atomicWriteBytes(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

/**
 * Persist a generated asset and its provenance sidecar. Throws on any unsafe
 * path, disallowed mime, oversized payload, or attempted overwrite BEFORE writing
 * anything. Returns the validated provenance record and the two paths written.
 */
export function writeGeneratedAsset(input: WriteGeneratedAssetInput): WriteGeneratedAssetResult {
  // 1. The relative path must be portable, and the resolved path must stay inside outDir.
  const rel = assertSafeRelativePath(input.relPath, "relPath");
  const outDirAbs = resolve(input.outDir);
  const assetPath = resolve(outDirAbs, rel);
  assertContainedPath(assetPath, outDirAbs, "generated asset path");

  // 2. The mime must be approved for the asset kind.
  const approved = input.kind === "image" ? APPROVED_IMAGE_MIME : APPROVED_AUDIO_MIME;
  if (!approved.has(input.mime)) {
    throw new Error(`mime '${input.mime}' is not approved for a '${input.kind}' asset.`);
  }

  // 3. The payload must be under the hard byte cap.
  if (input.bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`generated asset exceeds the ${MAX_ASSET_BYTES}-byte cap (${input.bytes.byteLength} bytes).`);
  }

  // 4. Never overwrite an existing asset.
  if (existsSync(assetPath)) {
    throw new Error(`refusing to overwrite an existing asset: ${JSON.stringify(input.relPath)}.`);
  }

  // 5. Hash the exact bytes the store is about to write.
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");

  // 6. Build and validate the provenance record. `synthetic: true` is forced by the schema.
  const draft = {
    format: GENERATED_ASSET_FORMAT,
    kind: input.kind,
    provider: input.provider,
    ...(input.model !== undefined ? { model: input.model } : {}),
    mime: input.mime,
    bytes: input.bytes.byteLength,
    sha256,
    requestSummary: input.requestSummary.slice(0, GEN_LIMITS.requestSummary),
    synthetic: true as const,
    label: input.label.slice(0, GEN_LIMITS.label),
    createdAt: input.now.toISOString(),
  };
  const parsed = parseGeneratedAsset(draft);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`generated asset record failed validation: ${parsed.errors.join("; ")}`);
  }

  // 7. Write the bytes, then the sidecar, each atomically.
  mkdirSync(dirname(assetPath), { recursive: true });
  atomicWriteBytes(assetPath, input.bytes);
  const sidecarPath = `${assetPath}.provenance.json`;
  atomicWrite(sidecarPath, JSON.stringify(parsed.data, null, 2) + "\n");

  return { record: parsed.data, assetPath, sidecarPath };
}
