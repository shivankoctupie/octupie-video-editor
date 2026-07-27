import type { Provider, ProviderRequest, ProviderResult, ProviderDiagnostic } from "./types.js";
import { buildDeterministicPlan } from "../plan.js";

/**
 * The offline provider. It runs the whole loop with no model and no network by
 * synthesizing a valid plan from the brief and always approving it. It is the
 * default in tests and the reference for a bounded end-to-end run.
 */
export function createDeterministicProvider(): Provider {
  return {
    id: "deterministic",
    async generate(req: ProviderRequest): Promise<ProviderResult> {
      if (req.kind === "plan") {
        const built = buildDeterministicPlan(req.context.brief);
        if (!built.ok || !built.plan) {
          return { ok: false, text: "", error: built.errors.join("; "), meta: { provider: "deterministic" } };
        }
        return { ok: true, text: JSON.stringify(built.plan), meta: { provider: "deterministic", kind: "plan" } };
      }
      // Critique: a deterministic plan always satisfies the schema and rubric.
      return {
        ok: true,
        text: JSON.stringify({ approved: true, issues: [], notes: "deterministic offline approval" }),
        meta: { provider: "deterministic", kind: "critique" },
      };
    },
    async diagnose(): Promise<ProviderDiagnostic> {
      return {
        id: "deterministic",
        available: true,
        authenticated: true,
        authSource: "built-in (no external auth)",
        detail: "built-in offline provider; no binary or login required",
      };
    },
  };
}
