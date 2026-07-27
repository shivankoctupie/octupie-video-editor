/**
 * Provider-neutral capability contracts for the eight parity areas.
 *
 * These are TYPE-LEVEL promises only. Nothing here is implemented; each area is
 * reported `unavailable` by the registry until a real provider backs it and an
 * acceptance gate passes. The contracts are deliberately provider-neutral: a
 * local model, a CLI, a cloud API, or an MCP surface can each satisfy an
 * interface without the rest of the engine knowing which.
 *
 * Two invariants hold across every contract:
 *   1. Providers return DATA. The deterministic engine validates and executes;
 *      nothing a provider returns is run directly (mirrors AGENTIC_ARCHITECTURE).
 *   2. Any boundary-crossing action (network, media upload, publish, code change)
 *      names the `PermissionAction` it requires, and is denied without a grant.
 */

import type { PermissionAction } from "../permissions/policy.js";

/** Shared shape: a portable, relative asset reference the engine already trusts. */
export interface AssetRef {
  /** Portable relative path, validated by the existing path guard. */
  path: string;
  /** Optional stable id for cross-referencing in a plan. */
  id?: string;
}

/** A timecode range in seconds on a source clip. */
export interface TimeRange {
  startSeconds: number;
  endSeconds: number;
}

/** Every contract method that can reach outside the offline boundary declares its cost. */
export interface PermissionedOperation {
  readonly requiresPermissions: readonly PermissionAction[];
}

// 1. Direct semantic video understanding -------------------------------------

export interface SemanticSegment extends TimeRange {
  /** What is happening, in plain language. */
  description: string;
  /** Model-assigned salience 0..1 for editorial ranking. */
  salience: number;
  tags: string[];
}

export interface VideoUnderstanding {
  clip: AssetRef;
  durationSeconds: number;
  segments: SemanticSegment[];
  /** High-level summary of the footage for the planner manifest. */
  summary: string;
}

export interface VideoUnderstandingProvider extends PermissionedOperation {
  understand(clip: AssetRef): Promise<VideoUnderstanding>;
}

// 2. Automatic transcription + editorial analysis ----------------------------

export interface Word {
  text: string;
  startSeconds: number;
  endSeconds: number;
  /** Diarized speaker label, e.g. "S1". */
  speaker?: string;
  confidence?: number;
}

export interface FillerMark extends TimeRange {
  kind: "filler" | "silence" | "crew-prompt";
  text?: string;
}

export interface TakeMark extends TimeRange {
  /** Grouping id: repeated attempts at the same line share a takeGroup. */
  takeGroup: string;
  /** Provider's pick of the best take within the group, if it has an opinion. */
  preferred?: boolean;
}

export interface TranscriptionResult {
  clip: AssetRef;
  words: Word[];
  speakers: string[];
  /** Filler words, dead silence, and off-camera crew prompts to consider cutting. */
  marks: FillerMark[];
  takes: TakeMark[];
}

export interface TranscriptionProvider extends PermissionedOperation {
  transcribe(clip: AssetRef): Promise<TranscriptionResult>;
}

// 3. Rendered-draft multimodal critique and bounded revision -----------------

export interface DraftCritiqueNote {
  /** Frame or time the note anchors to. */
  atSeconds: number;
  severity: "info" | "suggest" | "blocker";
  note: string;
}

export interface DraftCritique {
  master: AssetRef;
  approved: boolean;
  notes: DraftCritiqueNote[];
}

export interface RevisionProposal {
  /** A new edit plan, expressed as data. Validated by the existing schema before use. */
  editPlan: unknown;
  rationale: string;
  /** Bounded: how many revision rounds remain before human escalation. */
  roundsRemaining: number;
}

export interface DraftCritiqueProvider extends PermissionedOperation {
  critique(master: AssetRef): Promise<DraftCritique>;
  /** Propose a bounded revision. Returns data only; the engine re-validates and re-renders. */
  revise(master: AssetRef, critique: DraftCritique): Promise<RevisionProposal>;
}

// 4. Rights-safe asset discovery (local / Drive / web) -----------------------

export type AssetSourceKind = "local" | "drive" | "web";

export interface AssetCandidate {
  source: AssetSourceKind;
  /** For local: a portable relative path. For remote: a reference, not bytes. */
  ref: string;
  title: string;
  /** License must be present and permissive; discovery never returns unlicensed bytes. */
  license: { id: string; url?: string; attributionRequired: boolean };
  relevance: number;
}

export interface AssetDiscoveryQuery {
  intent: string;
  sources: AssetSourceKind[];
  maxResults: number;
}

export interface AssetDiscoveryProvider extends PermissionedOperation {
  /** local search is offline; drive/web require `network` (and downloads require `media-upload` review). */
  discover(query: AssetDiscoveryQuery): Promise<AssetCandidate[]>;
}

// 5. Complete hook-variant production ----------------------------------------

export interface HookVariant {
  id: string;
  style: string;
  text: string;
  /** The variant expressed as a plan fragment the renderer can consume. */
  planFragment: unknown;
}

export interface HookVariantRequest {
  objective: string;
  count: number;
  transcriptText?: string;
}

export interface HookVariantProducer extends PermissionedOperation {
  produce(req: HookVariantRequest): Promise<HookVariant[]>;
}

// 6. Optional Hermes integration via official surfaces -----------------------

export type HermesSurface = "mcp" | "api" | "plugin";

export interface HermesIntegrationConfig {
  surface: HermesSurface;
  /** Endpoint or plugin id. Never a private credential file path. */
  endpoint: string;
}

export interface HermesIntegration extends PermissionedOperation {
  /** True only when standalone operation still holds with this integration absent. */
  readonly standalonePreserved: true;
  connect(config: HermesIntegrationConfig): Promise<{ ok: boolean; detail: string }>;
}

// 7. Reviewed improvement proposals (never silent self-modification) ---------

export interface ImprovementProposal {
  id: string;
  title: string;
  /** Human-readable description of the change to code, skills, or prompts. */
  description: string;
  /** Unified diff or structured patch; applied only after explicit approval. */
  patch: string;
  /** Tests that must accompany and pass with the change. */
  tests: string[];
  /** How to revert if the change regresses. */
  rollbackPlan: string;
}

export interface ProposalDecision {
  proposalId: string;
  approved: boolean;
  approver: string;
}

export interface ImprovementProposalProvider extends PermissionedOperation {
  /** Draft a proposal. Requires `code-change` before anything is applied. */
  propose(context: string): Promise<ImprovementProposal>;
  /** Apply an APPROVED proposal only; must be reversible via its rollbackPlan. */
  apply(proposal: ImprovementProposal, decision: ProposalDecision): Promise<{ applied: boolean; rolledBack: boolean }>;
}

// 8. Human review and publishing ---------------------------------------------

export interface FrameComment {
  atSeconds: number;
  author: string;
  body: string;
  resolved: boolean;
}

export interface ReviewVersion {
  versionId: string;
  master: AssetRef;
  createdAt: string;
}

export type ReviewRole = "viewer" | "commenter" | "approver" | "publisher" | "admin";

export interface PublishTarget {
  id: string;
  kind: string; // e.g. "youtube", "instagram", "drive-folder"
}

export interface ReviewPublishingProvider extends PermissionedOperation {
  addComment(versionId: string, comment: FrameComment): Promise<void>;
  approve(versionId: string, approver: string): Promise<{ approved: boolean }>;
  compareVersions(a: string, b: string): Promise<{ diffSummary: string }>;
  /** Publishing requires `publishing` (and often `media-upload`) grants and an approver role. */
  publish(versionId: string, target: PublishTarget, role: ReviewRole): Promise<{ published: boolean; detail: string }>;
}
