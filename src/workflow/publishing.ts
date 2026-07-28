/**
 * Publishing (parity phase 8). Publishing is DISABLED BY DEFAULT.
 *
 * A `PublishingAdapter` turns a validated request into a data-only result. The only
 * shipped adapter is `disabled`: it always returns blocked and does nothing, no
 * network. A publish attempt must clear EVERY gate before an adapter is ever
 * invoked:
 *
 *   1. the request is a valid, bounded artifact;
 *   2. the target version exists and is `approved`;
 *   3. RBAC: the role holds the `publish` action (publisher or admin);
 *   4. an explicit `publishing` PermissionPolicy grant is live;
 *   5. `rightsConfirmed` is true;
 *   6. `qaPassed` is true;
 *   7. the chosen adapter is configured AND not the disabled adapter;
 *   8. no receipt with the same `idempotencyKey` already exists.
 *
 * Only then is the adapter invoked. Its output is validated as data-only (no tokens
 * are ever read, logged, or required). A block or failure writes NO receipt and does
 * NOT mark the version published. Success writes one immutable receipt. The
 * approved version itself remains immutable. Idempotency blocks a duplicate publish.
 */

import { join, resolve } from "node:path";
import { PermissionDeniedError, requireGrant, type PermissionPolicy } from "../permissions/policy.js";
import { authorize } from "./rbac.js";
import {
  defaultWorkflowFs,
  writeJsonState,
  type WorkflowFs,
} from "./store.js";
import { loadVersion, type VersionStoreContext } from "./versions.js";
import {
  parseAdapterOutput,
  parsePublishRequest,
  PUBLISH_RECEIPT_FORMAT,
  type AdapterOutputValue,
  type PublishReceiptValue,
  type PublishRequestValue,
} from "./schemas.js";

/** A publishing adapter turns a request into a data-only result. */
export interface PublishingAdapter {
  readonly id: string;
  /** False for the disabled adapter and any not-yet-configured external stub. */
  readonly enabled: boolean;
  publish(request: PublishRequestValue): Promise<AdapterOutputValue>;
}

/** The default adapter: always blocked, no network, no side effect. */
export const disabledPublishingAdapter: PublishingAdapter = {
  id: "disabled",
  enabled: false,
  publish(): Promise<AdapterOutputValue> {
    return Promise.resolve({
      ok: false,
      blockedReason: "Publishing is disabled by default; no external destination is configured.",
      data: {},
    });
  },
};

/** A registry mapping adapter id -> adapter. Only `disabled` is registered by default. */
export class PublishingRegistry {
  private readonly adapters = new Map<string, PublishingAdapter>();
  constructor(adapters: readonly PublishingAdapter[] = [disabledPublishingAdapter]) {
    for (const a of adapters) this.adapters.set(a.id, a);
    if (!this.adapters.has("disabled")) this.adapters.set("disabled", disabledPublishingAdapter);
  }
  register(adapter: PublishingAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string): PublishingAdapter | undefined {
    return this.adapters.get(id);
  }
  ids(): string[] {
    return [...this.adapters.keys()];
  }
}

export type PublishStatus = "published" | "blocked" | "failed";

export interface PublishResult {
  status: PublishStatus;
  /** The gate or stage that stopped a non-published attempt. */
  gate?: string;
  reason: string;
  receipt?: PublishReceiptValue;
  receiptPath?: string;
  publishedVersionId?: string;
}

export interface PublishInput {
  request: unknown;
  store: VersionStoreContext;
  policy: PermissionPolicy;
  adapter: PublishingAdapter;
  now?: Date;
  fs?: WorkflowFs;
}

export function receiptPath(stateRoot: string, projectId: string, idempotencyKey: string): string {
  return join(resolve(stateRoot), "publish-receipts", projectId, `${idempotencyKey}.json`);
}

/**
 * Run the full publish flow. Returns a `blocked` result (with the failing gate) when
 * any gate fails BEFORE the adapter is called, so a caller can prove the adapter was
 * never invoked. Throws only on a permission denial surfaced as a decision.
 */
export async function publish(input: PublishInput): Promise<PublishResult> {
  const fs = input.fs ?? defaultWorkflowFs;
  const now = input.now ?? new Date();
  const storeCtx: VersionStoreContext = { ...input.store, ...(input.fs ? { fs } : {}), now };

  // Gate 1: the request is a valid, bounded artifact.
  const parsed = parsePublishRequest(input.request);
  if (!parsed.ok || !parsed.data) {
    return { status: "blocked", gate: "request", reason: `Invalid publish request: ${parsed.errors.join("; ")}` };
  }
  const req = parsed.data;

  // Gate 2: the target version exists and is approved.
  let version;
  try {
    version = loadVersion(storeCtx, req.projectId, req.versionId);
  } catch (err) {
    return { status: "blocked", gate: "version", reason: err instanceof Error ? err.message : String(err) };
  }
  if (version.status !== "approved") {
    return { status: "blocked", gate: "approval", reason: `Version '${req.versionId}' is '${version.status}', not approved.` };
  }

  // Gate 3: RBAC. The requesting role must hold the publish action.
  if (!authorize(req.role, "publish")) {
    return { status: "blocked", gate: "rbac", reason: `Role '${req.role}' is not authorized to publish.` };
  }

  // Gate 4: an explicit, live publishing grant.
  try {
    requireGrant("publishing", input.policy, now);
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      return { status: "blocked", gate: "permission", reason: err.message };
    }
    throw err;
  }

  // Gate 5 and 6: rights and QA.
  if (req.rightsConfirmed !== true) {
    return { status: "blocked", gate: "rights", reason: "rightsConfirmed must be true to publish." };
  }
  if (req.qaPassed !== true) {
    return { status: "blocked", gate: "qa", reason: "qaPassed must be true to publish." };
  }

  // Gate 7: a configured, non-disabled adapter that matches the requested id.
  if (input.adapter.id !== req.adapterId) {
    return { status: "blocked", gate: "adapter", reason: `Requested adapter '${req.adapterId}' does not match the provided adapter '${input.adapter.id}'.` };
  }
  if (input.adapter.enabled !== true || input.adapter.id === "disabled") {
    return { status: "blocked", gate: "adapter-disabled", reason: `Adapter '${input.adapter.id}' is disabled; publishing is unavailable by default.` };
  }

  // Gate 8: idempotency. A prior receipt for this key blocks a duplicate publish.
  const rPath = receiptPath(storeCtx.stateRoot, req.projectId, req.idempotencyKey);
  if (fs.exists(rPath)) {
    return { status: "blocked", gate: "idempotency", reason: `A publish receipt for key '${req.idempotencyKey}' already exists.` };
  }

  // Every gate passed: invoke the adapter. Its output is data only.
  let output: AdapterOutputValue;
  try {
    output = await input.adapter.publish(req);
  } catch (err) {
    return { status: "failed", gate: "adapter", reason: `Adapter threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  const validated = parseAdapterOutput(output);
  if (!validated.ok || !validated.data) {
    // Malformed provider data is rejected; no receipt is written.
    return { status: "failed", gate: "adapter-output", reason: `Adapter returned malformed data: ${validated.errors.join("; ")}` };
  }
  if (validated.data.ok !== true) {
    return { status: "blocked", gate: "adapter-blocked", reason: validated.data.blockedReason ?? "Adapter blocked the publish." };
  }

  // Success: write one immutable receipt. Do not mutate or append version state,
  // which avoids a cross-file partial transaction between receipt and version data.
  const receipt: PublishReceiptValue = {
    format: PUBLISH_RECEIPT_FORMAT,
    receiptId: `receipt-${req.idempotencyKey}`,
    versionId: req.versionId,
    projectId: req.projectId,
    adapterId: input.adapter.id,
    idempotencyKey: req.idempotencyKey,
    ...(validated.data.providerRef !== undefined ? { providerRef: validated.data.providerRef } : {}),
    publishedBy: req.requestedBy,
    publishedAt: now.toISOString(),
    data: validated.data.data,
  };
  if (fs.exists(rPath)) {
    return { status: "blocked", gate: "idempotency", reason: `A publish receipt for key '${req.idempotencyKey}' already exists.` };
  }
  writeJsonState(rPath, receipt, fs);

  return {
    status: "published",
    reason: `Published version '${req.versionId}' via adapter '${input.adapter.id}'.`,
    receipt,
    receiptPath: rPath,
  };
}

export { PermissionDeniedError };
