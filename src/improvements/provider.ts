/**
 * The `ImprovementProposalProvider` contract (parity phase 7).
 *
 * A provider DRAFTS improvement proposals as data: it interprets an objective and
 * repository context and returns a proposal artifact (title, description, a
 * structured `octupie-replace-v1` patch, allowlisted tests, a rollback plan). It
 * never writes a file, runs a command, or applies anything. Deterministic code
 * (the apply/rollback engines) owns validation, approval, permission enforcement,
 * atomic application, and reversal.
 *
 * In this phase no model-backed provider is wired: proposal content is never
 * generated automatically. The interface exists so a reviewed, human-approved
 * provider can be added later without loosening any gate.
 */

import type { ImprovementProposalValue } from "./schemas.js";

export interface ImprovementProposalDraftRequest {
  /** What the improvement should achieve. Bounded, sanitized by the caller. */
  objective: string;
  /** Absolute source-tree root the provider may reason about (read-only). */
  projectRoot: string;
  /** Optional bound on how many files the proposal may touch (<= 10). */
  maxOperations?: number;
}

export interface ImprovementProposalProvider {
  readonly id: string;
  /**
   * Draft a proposal as DATA. The returned value is validated by the engine before
   * anything is applied; a provider that returns malformed data simply fails
   * validation and nothing is written.
   */
  draft(request: ImprovementProposalDraftRequest): Promise<ImprovementProposalValue>;
}
