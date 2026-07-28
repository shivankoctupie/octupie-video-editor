/**
 * Runtime-validated schemas for reviewed improvement proposals (parity phase 7).
 *
 * A proposal is a DATA artifact a provider drafts and a human reviews. It carries
 * a safe, structured replacement patch (`octupie-replace-v1`) serialized as JSON,
 * a non-empty allowlisted test command list, a rollback plan, and a status. These
 * schemas are the trust boundary: strict objects reject unknown fields, and every
 * string, array, and file body is bounded so a hostile or runaway artifact can
 * neither smuggle an extra flag nor exhaust memory.
 *
 * Nothing here writes a file or runs a command. Path safety, hash preflight, and
 * atomic application live in the deterministic apply/rollback engines; this module
 * only proves an artifact is well-formed and within its declared roots.
 */

import { z } from "zod";
import { isPortableAllowedPath } from "./guard.js";

export const STRUCTURED_PATCH_FORMAT = "octupie-replace-v1";
export const PROPOSAL_FORMAT = "octupie-improvement-proposal/v1";
export const DECISION_FORMAT = "octupie-improvement-decision/v1";

/** Hard caps. A single proposal may touch at most 10 files. */
export const MAX_OPERATIONS = 10;
/** Per-file body budget (before and after each capped independently). */
export const MAX_FILE_BYTES = 256 * 1024;
/** Whole-patch body budget (sum of every before+after body). */
export const MAX_PATCH_BYTES = 1024 * 1024;
export const MAX_TESTS = 20;

const MAX_ID = 64;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const MAX_ROLLBACK_PLAN = 4000;
const MAX_APPROVER = 200;
const MAX_REASON = 2000;
const MAX_PATCH_STRING = 4 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const PROPOSAL_STATUSES = [
  "proposed",
  "approved",
  "applied",
  "rolled-back",
  "rejected",
  "failed",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const DECISION_ACTIONS = ["apply", "rollback"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** A deterministic, bounded id: safe filename characters only. */
export const proposalIdSchema = z
  .string()
  .min(1, "id is required")
  .max(MAX_ID)
  .regex(/^[A-Za-z0-9._-]+$/, "id may contain only letters, digits, '.', '_' or '-'")
  .refine((id) => id !== "." && id !== "..", "id must not be '.' or '..'");

const bytesAtMost = (max: number, label: string) =>
  z.string().refine((s) => Buffer.byteLength(s, "utf8") <= max, {
    message: `${label} exceeds the ${max}-byte cap`,
  });

const noNul = (label: string) =>
  z.string().refine((s) => !s.includes("\0"), { message: `${label} must not contain a NUL byte` });

/**
 * One structured replacement operation. `beforeText` is the EXACT current bytes of
 * the file, `beforeSha256` is their hash, and `afterText` is the exact bytes to
 * write. Full-file replacement keeps the patch trivially reversible: the prior
 * bytes are `beforeText`. The path is validated as a portable, allowed-root
 * relative path (no absolute, traversal, backslash, NUL, or protected location).
 */
export const replaceOperationSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine((p) => isPortableAllowedPath(p), {
        message:
          "path must be a portable relative path under an allowed root (src/, tests/, skills/, prompts/, README.md, AGENTS.md) with no traversal, backslash, NUL, or protected location",
      }),
    beforeSha256: z.string().regex(SHA256_HEX, "beforeSha256 must be a 64-char lowercase hex digest"),
    beforeText: noNul("beforeText").and(bytesAtMost(MAX_FILE_BYTES, "beforeText")),
    afterText: noNul("afterText").and(bytesAtMost(MAX_FILE_BYTES, "afterText")),
  })
  .strict();
export type ReplaceOperationValue = z.infer<typeof replaceOperationSchema>;

/** The structured patch. 1..10 operations, all paths distinct, total body bounded. */
export const structuredPatchSchema = z
  .object({
    format: z.literal(STRUCTURED_PATCH_FORMAT),
    operations: z.array(replaceOperationSchema).min(1, "a patch needs at least one operation").max(MAX_OPERATIONS),
  })
  .strict()
  .superRefine((patch, ctx) => {
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const op of patch.operations) {
      const key = op.path.trim();
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate path in patch: ${JSON.stringify(op.path)}`, path: ["operations"] });
      }
      seen.add(key);
      totalBytes += Buffer.byteLength(op.beforeText, "utf8") + Buffer.byteLength(op.afterText, "utf8");
    }
    if (totalBytes > MAX_PATCH_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `patch body total ${totalBytes} bytes exceeds the ${MAX_PATCH_BYTES}-byte cap`, path: ["operations"] });
    }
  });
export type StructuredPatchValue = z.infer<typeof structuredPatchSchema>;

/**
 * The test command allowlist. Exact commands, plus the focused pattern
 * `npm test -- --run tests/<safe-path>[ <safe-path>...]`. Every command is space
 * tokenized and matched literally; nothing is ever interpreted by a shell.
 */
export const EXACT_TEST_COMMANDS = ["npm test", "npm run typecheck", "npm run build", "npm run dash:sweep"] as const;

const FOCUSED_PATH = /^tests\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** True when `command` is an allowlisted, injection-free test invocation. */
export function isAllowedTestCommand(command: string): boolean {
  if (typeof command !== "string") return false;
  if (command !== command.trim()) return false;
  if ((EXACT_TEST_COMMANDS as readonly string[]).includes(command)) return true;
  const tokens = command.split(" ");
  if (tokens.length < 5) return false;
  if (tokens[0] !== "npm" || tokens[1] !== "test" || tokens[2] !== "--" || tokens[3] !== "--run") return false;
  const paths = tokens.slice(4);
  if (paths.length === 0) return false;
  return paths.every((p) => FOCUSED_PATH.test(p) && !p.includes(".."));
}

/** Split an allowlisted command into an argv array for a shell:false runner. */
export function testCommandArgv(command: string): string[] {
  if (!isAllowedTestCommand(command)) {
    throw new Error(`Refusing to tokenize a non-allowlisted test command: ${JSON.stringify(command)}`);
  }
  return command.split(" ");
}

const testCommandSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((c) => isAllowedTestCommand(c), {
    message: `test command must be one of [${EXACT_TEST_COMMANDS.join(", ")}] or 'npm test -- --run tests/<file>'`,
  });

/**
 * A reviewed improvement proposal. STRICT and bounded. `patch` is the structured
 * patch serialized as a JSON string; it is parsed and fully validated by
 * {@link parseStructuredPatchString}. `tests` must be non-empty and allowlisted.
 */
export const improvementProposalSchema = z
  .object({
    format: z.literal(PROPOSAL_FORMAT),
    id: proposalIdSchema,
    title: z.string().trim().min(1, "title is required").max(MAX_TITLE),
    description: z.string().trim().min(1, "description is required").max(MAX_DESCRIPTION),
    patch: z.string().min(1, "patch is required").max(MAX_PATCH_STRING),
    tests: z.array(testCommandSchema).min(1, "at least one allowlisted test command is required").max(MAX_TESTS),
    rollbackPlan: z.string().trim().min(1, "a rollback plan is required").max(MAX_ROLLBACK_PLAN),
    createdAt: z.string().min(1),
    status: z.enum(PROPOSAL_STATUSES),
  })
  .strict();
export type ImprovementProposalValue = z.infer<typeof improvementProposalSchema>;

/**
 * A human approval/rejection decision. `proposalId` must exactly match the
 * proposal it decides. `action` distinguishes an apply decision from a rollback
 * decision (default: apply). Application requires `approved === true`.
 */
export const improvementDecisionSchema = z
  .object({
    format: z.literal(DECISION_FORMAT),
    proposalId: proposalIdSchema,
    approved: z.boolean(),
    approver: z.string().trim().min(1, "an approver is required").max(MAX_APPROVER),
    decidedAt: z.string().min(1),
    action: z.enum(DECISION_ACTIONS).default("apply"),
    reason: z.string().trim().max(MAX_REASON).optional(),
  })
  .strict();
export type ImprovementDecisionValue = z.infer<typeof improvementDecisionSchema>;

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

export function parseImprovementProposal(json: unknown): ParseResult<ImprovementProposalValue> {
  const r = improvementProposalSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

export function parseImprovementDecision(json: unknown): ParseResult<ImprovementDecisionValue> {
  const r = improvementDecisionSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

export function parseStructuredPatch(json: unknown): ParseResult<StructuredPatchValue> {
  const r = structuredPatchSchema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

/** Parse the JSON string a proposal carries in `patch`, then validate the structure. */
export function parseStructuredPatchString(patch: string): ParseResult<StructuredPatchValue> {
  let json: unknown;
  try {
    json = JSON.parse(patch);
  } catch (err) {
    return { ok: false, errors: [`patch is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return parseStructuredPatch(json);
}
