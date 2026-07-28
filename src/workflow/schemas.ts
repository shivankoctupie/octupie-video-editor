/**
 * Runtime-validated schemas for the human-review, versioning, queue, notification,
 * and publishing layer (parity phase 8).
 *
 * Everything here is DATA. These schemas are the trust boundary: strict objects
 * reject unknown fields, every string, array, and object is bounded so a hostile
 * or runaway artifact can neither smuggle an extra field nor exhaust memory, and
 * ids are constrained to safe filename characters. Nothing in this module writes a
 * file, runs a command, or reaches the network. Path safety, hashing, atomic
 * writes, RBAC, permission grants, and adapter gating live in the deterministic
 * services (`versions.ts`, `review.ts`, `queue.ts`, `notifications.ts`,
 * `publishing.ts`); this module only proves an artifact is well-formed and bounded.
 */

import { z } from "zod";

export const VERSION_RECORD_FORMAT = "octupie-workflow-version/v1";
export const VERSION_INDEX_FORMAT = "octupie-workflow-version-index/v1";
export const REVIEW_DECISION_FORMAT = "octupie-workflow-review-decision/v1";
export const JOB_FORMAT = "octupie-workflow-job/v1";
export const QUEUE_STATE_FORMAT = "octupie-workflow-queue/v1";
export const NOTIFICATION_FORMAT = "octupie-workflow-notification/v1";
export const DELIVERY_RECORD_FORMAT = "octupie-workflow-delivery/v1";
export const PUBLISH_REQUEST_FORMAT = "octupie-workflow-publish-request/v1";
export const PUBLISH_RECEIPT_FORMAT = "octupie-workflow-publish-receipt/v1";

/** Hard caps. */
export const MAX_ID = 96;
export const MAX_ACTOR = 200;
export const MAX_NOTES = 4000;
export const MAX_PATH = 1024;
export const MAX_SUBJECT = 300;
export const MAX_BODY = 8000;
export const MAX_TITLE = 300;
/** A payload/data object is bounded by its serialized byte length, not its shape. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_ATTEMPTS = 3;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A deterministic, bounded id: safe filename characters only. */
export const safeIdSchema = z
  .string()
  .min(1, "id is required")
  .max(MAX_ID)
  .regex(/^[A-Za-z0-9._-]+$/, "id may contain only letters, digits, '.', '_' or '-'")
  .refine((id) => id !== "." && id !== "..", "id must not be '.' or '..'");

/** A bounded, opaque JSON DATA object. Functions, special numbers, class
 * instances, undefined values, and cycles are rejected before persistence. */
function isJsonValue(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 10_000) return false;
    const ok = value.every((item) => isJsonValue(item, seen));
    seen.delete(value);
    return ok;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.values(descriptors);
  if (entries.length > 10_000) return false;
  const ok = entries.every((descriptor) =>
    "value" in descriptor && descriptor.get === undefined && descriptor.set === undefined && isJsonValue(descriptor.value, seen),
  );
  seen.delete(value);
  return ok;
}

export const boundedDataSchema = z
  .custom<Record<string, unknown>>((v) => v !== null && typeof v === "object" && !Array.isArray(v), "data must be an object")
  .refine((v) => isJsonValue(v, new Set()), { message: "data must contain plain, acyclic JSON values only" })
  .refine((v) => {
    try {
      if (!isJsonValue(v, new Set())) return false;
      return Buffer.byteLength(JSON.stringify(v), "utf8") <= MAX_PAYLOAD_BYTES;
    } catch {
      return false;
    }
  }, {
    message: `data exceeds the ${MAX_PAYLOAD_BYTES}-byte cap`,
  });

// ---------------------------------------------------------------------------
// RBAC roles and actions (see rbac.ts for the authorization function).
// ---------------------------------------------------------------------------

export const WORKFLOW_ROLES = ["viewer", "editor", "approver", "publisher", "admin"] as const;
export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

export const WORKFLOW_ACTIONS = [
  "view",
  "edit",
  "submit-review",
  "decide-review",
  "publish",
  "administer",
] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Immutable version records.
// ---------------------------------------------------------------------------

export const VERSION_STATUSES = ["draft", "in-review", "approved", "rejected", "published"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/**
 * One immutable version record. `planPath`/`masterPath` are portable, relative
 * paths (validated for containment by the store, not here). `planSha256`/
 * `masterSha256` are hashes the store computes over the real file bytes; a caller
 * never supplies them.
 */
export const versionRecordSchema = z
  .object({
    format: z.literal(VERSION_RECORD_FORMAT),
    id: safeIdSchema,
    projectId: safeIdSchema,
    version: z.number().int().min(1),
    parentVersionId: safeIdSchema.nullable(),
    planPath: z.string().min(1).max(MAX_PATH),
    planSha256: z.string().regex(SHA256_HEX, "planSha256 must be a 64-char lowercase hex digest"),
    masterPath: z.string().min(1).max(MAX_PATH).optional(),
    masterSha256: z.string().regex(SHA256_HEX).optional(),
    creator: z.string().trim().min(1).max(MAX_ACTOR),
    createdAt: z.string().min(1),
    status: z.enum(VERSION_STATUSES),
  })
  .strict()
  .superRefine((rec, ctx) => {
    if ((rec.masterPath === undefined) !== (rec.masterSha256 === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "masterPath and masterSha256 must be present together or both absent",
        path: ["masterPath"],
      });
    }
  });
export type VersionRecordValue = z.infer<typeof versionRecordSchema>;

/** A compact summary kept in the project index for FIFO/lineage queries. */
export const versionSummarySchema = z
  .object({
    id: safeIdSchema,
    version: z.number().int().min(1),
    parentVersionId: safeIdSchema.nullable(),
    status: z.enum(VERSION_STATUSES),
  })
  .strict();
export type VersionSummaryValue = z.infer<typeof versionSummarySchema>;

export const versionIndexSchema = z
  .object({
    format: z.literal(VERSION_INDEX_FORMAT),
    projectId: safeIdSchema,
    latestVersion: z.number().int().min(0),
    latestVersionId: safeIdSchema.nullable(),
    revision: z.number().int().min(0),
    versions: z.array(versionSummarySchema).max(10_000),
    updatedAt: z.string().min(1),
  })
  .strict();
export type VersionIndexValue = z.infer<typeof versionIndexSchema>;

// ---------------------------------------------------------------------------
// Human review decisions.
// ---------------------------------------------------------------------------

/** Only an approver or an admin may sign a review decision. */
export const DECISION_ROLES = ["approver", "admin"] as const;

export const reviewDecisionSchema = z
  .object({
    format: z.literal(REVIEW_DECISION_FORMAT),
    versionId: safeIdSchema,
    approved: z.boolean(),
    approver: z.string().trim().min(1).max(MAX_ACTOR),
    role: z.enum(DECISION_ROLES),
    decidedAt: z.string().min(1),
    notes: z.string().max(MAX_NOTES).optional(),
  })
  .strict();
export type ReviewDecisionValue = z.infer<typeof reviewDecisionSchema>;

// ---------------------------------------------------------------------------
// File-backed job queue.
// ---------------------------------------------------------------------------

export const JOB_TYPES = ["analyze", "plan", "render", "qa", "publish"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobSchema = z
  .object({
    format: z.literal(JOB_FORMAT),
    id: safeIdSchema,
    type: z.enum(JOB_TYPES),
    status: z.enum(JOB_STATUSES),
    attempts: z.number().int().min(0).max(MAX_ATTEMPTS),
    maxAttempts: z.number().int().min(1).max(MAX_ATTEMPTS),
    /** DATA only. Bounded. The queue never interprets or executes it. */
    payload: boundedDataSchema,
    idempotencyKey: safeIdSchema.optional(),
    enqueuedBy: z.string().trim().min(1).max(MAX_ACTOR),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    failureDetail: z.string().max(MAX_NOTES).optional(),
  })
  .strict();
export type JobValue = z.infer<typeof jobSchema>;

export const queueStateSchema = z
  .object({
    format: z.literal(QUEUE_STATE_FORMAT),
    seq: z.number().int().min(0),
    jobs: z.array(jobSchema).max(100_000),
  })
  .strict();
export type QueueStateValue = z.infer<typeof queueStateSchema>;

// ---------------------------------------------------------------------------
// Notifications.
// ---------------------------------------------------------------------------

export const notificationSchema = z
  .object({
    format: z.literal(NOTIFICATION_FORMAT),
    id: safeIdSchema,
    kind: z.string().trim().min(1).max(64),
    subject: z.string().trim().min(1).max(MAX_SUBJECT),
    body: z.string().max(MAX_BODY),
    audienceRole: z.enum(WORKFLOW_ROLES).optional(),
    data: boundedDataSchema.optional(),
    createdAt: z.string().min(1),
  })
  .strict();
export type NotificationValue = z.infer<typeof notificationSchema>;

export const NOTIFICATION_CHANNELS = ["file"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const deliveryRecordSchema = z
  .object({
    format: z.literal(DELIVERY_RECORD_FORMAT),
    id: safeIdSchema,
    notificationId: safeIdSchema,
    channel: z.enum(NOTIFICATION_CHANNELS),
    status: z.literal("delivered"),
    deliveredAt: z.string().min(1),
  })
  .strict();
export type DeliveryRecordValue = z.infer<typeof deliveryRecordSchema>;

// ---------------------------------------------------------------------------
// Publishing.
// ---------------------------------------------------------------------------

export const publishRequestSchema = z
  .object({
    format: z.literal(PUBLISH_REQUEST_FORMAT),
    versionId: safeIdSchema,
    projectId: safeIdSchema,
    adapterId: safeIdSchema,
    requestedBy: z.string().trim().min(1).max(MAX_ACTOR),
    role: z.enum(WORKFLOW_ROLES),
    rightsConfirmed: z.boolean(),
    qaPassed: z.boolean(),
    idempotencyKey: safeIdSchema,
    requestedAt: z.string().min(1),
    /** Optional bounded, data-only adapter parameters (e.g. a caption). Never executed. */
    params: boundedDataSchema.optional(),
  })
  .strict();
export type PublishRequestValue = z.infer<typeof publishRequestSchema>;

/** The shape a publishing adapter must return: data only, no tokens, bounded. */
export const adapterOutputSchema = z
  .object({
    ok: z.boolean(),
    providerRef: z.string().max(MAX_ID).optional(),
    blockedReason: z.string().max(MAX_NOTES).optional(),
    data: boundedDataSchema,
  })
  .strict();
export type AdapterOutputValue = z.infer<typeof adapterOutputSchema>;

export const publishReceiptSchema = z
  .object({
    format: z.literal(PUBLISH_RECEIPT_FORMAT),
    receiptId: safeIdSchema,
    versionId: safeIdSchema,
    projectId: safeIdSchema,
    adapterId: safeIdSchema,
    idempotencyKey: safeIdSchema,
    providerRef: z.string().max(MAX_ID).optional(),
    publishedBy: z.string().trim().min(1).max(MAX_ACTOR),
    publishedAt: z.string().min(1),
    data: boundedDataSchema,
  })
  .strict();
export type PublishReceiptValue = z.infer<typeof publishReceiptSchema>;

// ---------------------------------------------------------------------------
// Parse helpers (mirror the improvements module's ParseResult contract).
// ---------------------------------------------------------------------------

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

function parseWith<T>(schema: z.ZodType<T>, json: unknown): ParseResult<T> {
  const r = schema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

export const parseReviewDecision = (j: unknown) => parseWith(reviewDecisionSchema, j);
export const parsePublishRequest = (j: unknown) => parseWith(publishRequestSchema, j);
export const parseAdapterOutput = (j: unknown) => parseWith(adapterOutputSchema, j);
export const parseNotification = (j: unknown) => parseWith(notificationSchema, j);
export const parseVersionRecord = (j: unknown) => parseWith(versionRecordSchema, j);
export const parseVersionIndex = (j: unknown) => parseWith(versionIndexSchema, j);
export const parseQueueState = (j: unknown) => parseWith(queueStateSchema, j);
