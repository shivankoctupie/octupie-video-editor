#!/usr/bin/env tsx
/**
 * Rights-safe SFX fetch mechanism. This repository bundles NO audio binaries.
 *
 * This script only acts on an explicit, license-checked manifest. It:
 *   1. loads a manifest (path via --manifest or the OVE_SFX_MANIFEST_URL env),
 *   2. rejects NonCommercial and NoDerivatives licenses and blacklisted assets,
 *   3. prints a dry-run plan by default and refuses to write anything without
 *      an explicit --confirm flag.
 *
 * Actual download transport is intentionally left to the operator: point each
 * record's sourceUrl at a rights-cleared source and wire your own fetch behind
 * the --confirm gate. Nothing here reaches the network on its own.
 */
import { readFileSync } from "node:fs";
import { parseManifest, checkManifestRights } from "../src/sfx/manifest.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  const manifestPath = arg("manifest") ?? process.env.OVE_SFX_MANIFEST_URL;
  if (!manifestPath) {
    process.stderr.write(
      "No manifest. Pass --manifest <file.json> or set OVE_SFX_MANIFEST_URL.\n" +
        "This tool refuses to fetch anything without a license-checked manifest.\n",
    );
    return 2;
  }
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  const check = checkManifestRights(manifest);

  process.stdout.write(`Manifest: ${manifestPath}\n`);
  process.stdout.write(`Records: ${manifest.records.length}\n`);
  if (!check.ok) {
    process.stderr.write("Rights check FAILED:\n");
    for (const p of check.problems) process.stderr.write(`  - ${p}\n`);
    return 1;
  }
  process.stdout.write("Rights check: PASS (all records commercially usable)\n");

  const confirm = process.argv.includes("--confirm");
  if (!confirm) {
    process.stdout.write("\nDry run. These records are cleared to fetch:\n");
    for (const r of manifest.records) {
      process.stdout.write(`  ${r.asset}  [${r.license}]  ${r.sourceUrl}\n`);
    }
    process.stdout.write("\nRe-run with --confirm and wire an operator-approved transport to fetch.\n");
    return 0;
  }

  process.stdout.write(
    "\n--confirm set, but no transport is wired in this repository by design.\n" +
      "Implement the fetch behind this gate with your own rights-cleared source.\n",
  );
  return 0;
}

process.exit(main());
