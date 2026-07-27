/**
 * Loader and invariants for the parity acceptance manifest.
 *
 * `ACCEPTANCE_MANIFEST.json` at the repo root enumerates every future end-to-end
 * gate for the eight parity capabilities. This module reads and validates it and
 * enforces the honesty invariant: no gate may be marked green (`passed`) while
 * its capability is unimplemented. A gate flips to `passed` only when its real
 * executable check passes; that wiring is future work, not faked here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const ACCEPTANCE_STATUSES = ["pending", "passed", "failed", "skipped"] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

/** Statuses that assert a working capability. Reaching one demands real proof. */
const GREEN_STATUSES: readonly AcceptanceStatus[] = ["passed"];

const GateSchema = z
  .object({
    id: z.string().min(1),
    capability: z.string().min(1),
    title: z.string().min(1),
    kind: z.literal("e2e"),
    blocking: z.boolean(),
    status: z.enum(ACCEPTANCE_STATUSES),
    description: z.string().min(1),
  })
  .strict();

const ManifestSchema = z
  .object({
    format: z.literal("octupie-parity-acceptance/v1"),
    note: z.string(),
    gates: z.array(GateSchema).min(1),
  })
  .strict();

export type AcceptanceGate = z.infer<typeof GateSchema>;
export type AcceptanceManifest = z.infer<typeof ManifestSchema>;

function manifestPath(): string {
  // src/capabilities/ -> repo root is two levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "ACCEPTANCE_MANIFEST.json");
}

/** Load and validate the acceptance manifest from disk. */
export function loadAcceptanceManifest(path: string = manifestPath()): AcceptanceManifest {
  const raw = readFileSync(path, "utf8");
  const json = JSON.parse(raw) as unknown;
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid acceptance manifest: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  // Gate ids must be unique.
  const ids = parsed.data.gates.map((g) => g.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) throw new Error(`Duplicate acceptance gate ids: ${[...new Set(dupes)].join(", ")}`);
  return parsed.data;
}

/** Throw if any gate claims a green status, so the manifest can never fake completion. */
export function assertNoGreenGates(manifest: AcceptanceManifest): void {
  const green = manifest.gates.filter((g) => (GREEN_STATUSES as readonly string[]).includes(g.status));
  if (green.length) {
    throw new Error(
      `Acceptance manifest has ${green.length} gate(s) marked green (passed) with no verified backing: ${green
        .map((g) => g.id)
        .join(", ")}`,
    );
  }
}
