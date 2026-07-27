import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { editPlanSchema } from "./editPlan.js";

/**
 * Regenerate the committed JSON Schema from the Zod source of truth.
 * Cross-field refinements (overlap, caption limits, SFX stacks) live in the Zod
 * layer and are documented in the schema description; JSON Schema captures the
 * structural contract.
 */
export function buildJsonSchema(): unknown {
  const schema = zodToJsonSchema(editPlanSchema, {
    name: "OctupieEditPlan",
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  schema.$schema = "http://json-schema.org/draft-07/schema#";
  schema.title = "Octupie Edit Plan";
  schema.description =
    "The stable contract between the planning layer and the deterministic renderer. " +
    "Structural rules are enforced here; cross-field rules (no overlapping scenes, " +
    "scenes and cues within duration, one-to-three-word captions unless the preset " +
    "extends them, no blacklisted SFX, no default whoosh+riser+impact stack) are " +
    "enforced by the Zod validator and CLI 'validate' command.";
  return schema;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, "../../schema/edit-plan.schema.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(buildJsonSchema(), null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote ${outPath}\n`);
}

// tsx runs this file directly; guard so importing buildJsonSchema is side-effect free.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("generate.ts")) {
  main();
}
