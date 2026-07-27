import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * Rights-safe SFX acquisition.
 *
 * This module NEVER bundles audio. It records provenance and license for every
 * candidate and refuses to accept a cue that lacks a rights-cleared manifest
 * entry. Actual bytes are fetched only by an explicit, license-checked
 * downloader the operator runs on purpose.
 */

export interface ManifestRecord {
  asset: string; // base filename, e.g. "air_whoosh.wav"
  source: string; // human-readable source name, e.g. "Mixkit"
  sourceUrl: string;
  licenseUrl: string;
  license: string; // SPDX id or named license, e.g. "CC0-1.0" or "Mixkit Free License"
  sha256?: string;
}

export interface SfxManifest {
  purpose: string;
  blacklist: string[];
  records: ManifestRecord[];
}

const NONCOMMERCIAL = /noncommercial|\bnc\b|cc[- ]?by[- ]?nc/i;
const NODERIVATIVES = /noderiv|\bnd\b/i;

export function parseManifest(json: string): SfxManifest {
  const data = JSON.parse(json) as Partial<SfxManifest>;
  if (!Array.isArray(data.records)) {
    throw new Error("Manifest must contain a 'records' array");
  }
  return {
    purpose: data.purpose ?? "",
    blacklist: Array.isArray(data.blacklist) ? data.blacklist : [],
    records: data.records,
  };
}

export interface ManifestCheck {
  ok: boolean;
  problems: string[];
}

/** Reject NonCommercial for commercial work and treat NoDerivatives as unsafe. */
export function checkManifestRights(manifest: SfxManifest): ManifestCheck {
  const problems: string[] = [];
  for (const record of manifest.records) {
    if (!record.license) {
      problems.push(`${record.asset}: missing license`);
    }
    if (!record.sourceUrl || !record.licenseUrl) {
      problems.push(`${record.asset}: missing source or license URL`);
    }
    if (NONCOMMERCIAL.test(record.license)) {
      problems.push(`${record.asset}: NonCommercial license is not cleared for commercial work`);
    }
    if (NODERIVATIVES.test(record.license)) {
      problems.push(`${record.asset}: NoDerivatives license is unsafe for synchronization`);
    }
    if (manifest.blacklist.some((b) => b.toLowerCase() === record.asset.toLowerCase())) {
      problems.push(`${record.asset}: blacklisted asset present in manifest`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Confirm a downloaded file matches the manifest hash before use. */
export function verifyDownloadedAsset(filePath: string, record: ManifestRecord): boolean {
  if (!record.sha256) return false;
  if (!existsSync(filePath)) return false;
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return hash === record.sha256;
}
