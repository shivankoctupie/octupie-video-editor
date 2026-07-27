import type { AgentBrief } from "../brief.js";

/**
 * Provider contract. A provider turns a text request into a raw text reply.
 * Real CLI adapters use only `system` and `prompt`; the deterministic offline
 * provider uses the structured `context` so the whole loop can run with no model
 * and no network. Providers never execute anything a model returns; they return
 * text, which the loop validates as data.
 */

export type ProviderKind = "plan" | "critique";

export interface ProviderRequest {
  kind: ProviderKind;
  system: string;
  prompt: string;
  context: {
    brief: AgentBrief;
    /** The current plan, present for critique requests when available. */
    plan?: unknown;
  };
}

export interface ProviderResult {
  ok: boolean;
  /** Raw text reply. Callers redact before writing it to an audit log. */
  text: string;
  error?: string;
  meta: Record<string, unknown>;
}

export interface ProviderDiagnostic {
  id: string;
  /** The binary/runtime is present and responded. */
  available: boolean;
  /** Login/auth state. `"unknown"` when we do not probe it to avoid side effects. */
  authenticated: boolean | "unknown";
  /** Where auth comes from, for the operator. Never a Hermes private file. */
  authSource: string;
  detail: string;
  binary?: string;
}

export interface Provider {
  id: string;
  generate(req: ProviderRequest): Promise<ProviderResult>;
  diagnose(): Promise<ProviderDiagnostic>;
}
