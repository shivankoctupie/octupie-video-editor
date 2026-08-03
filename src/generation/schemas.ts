/**
 * Runtime-validated schemas for provider-neutral image and text-to-speech
 * generation.
 *
 * Everything here is DATA. These schemas are the trust boundary: strict objects
 * reject unknown fields, every string and integer is bounded so a hostile or
 * runaway request can neither smuggle an extra field nor exhaust memory, and the
 * provenance sidecar is forced to declare itself machine-generated. Nothing in
 * this module writes a file, runs a command, or reaches the network. Path safety,
 * hashing, atomic writes, permission grants, and HTTP gating live in the
 * deterministic services (`provenance.ts`, `httpImage.ts`, `httpTts.ts`); this
 * module only proves a request or record is well-formed and bounded.
 */

import { z } from "zod";

/** The self-describing format tag every provenance sidecar must carry. */
export const GENERATED_ASSET_FORMAT = "octupie-generated-asset/v1";

/** Hard caps, chosen to be safe on a laptop and hostile-input proof. */
export const GEN_LIMITS = {
  imagePrompt: 2000,
  minDim: 16,
  maxDim: 4096,
  maxSeed: 4_294_967_295,
  ttsText: 5000,
  voice: 120,
  minSampleRate: 8000,
  maxSampleRate: 48000,
  defaultSampleRate: 24000,
  minDurationSec: 0.1,
  maxDurationSec: 60,
  provider: 96,
  model: 200,
  mime: 128,
  requestSummary: 2000,
  label: 300,
} as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A deterministic, bounded id: safe filename characters only. */
export const safeIdSchema = z
  .string()
  .min(1, "id is required")
  .max(GEN_LIMITS.provider)
  .regex(/^[A-Za-z0-9._-]+$/, "id may contain only letters, digits, '.', '_' or '-'")
  .refine((id) => id !== "." && id !== "..", "id must not be '.' or '..'");

// ---------------------------------------------------------------------------
// Requests.
// ---------------------------------------------------------------------------

/**
 * An image generation request. The local provider renders only `svg`; the
 * OpenAI-compatible HTTP adapter may also request `png`. Dimensions are bounded
 * so a request cannot ask for an unbounded canvas.
 */
export const imageRequestSchema = z
  .object({
    prompt: z.string().min(1, "a prompt is required").max(GEN_LIMITS.imagePrompt),
    width: z.number().int().min(GEN_LIMITS.minDim).max(GEN_LIMITS.maxDim),
    height: z.number().int().min(GEN_LIMITS.minDim).max(GEN_LIMITS.maxDim),
    format: z.enum(["svg", "png"]),
    seed: z.number().int().min(0).max(GEN_LIMITS.maxSeed).optional(),
  })
  .strict();
/** The validated (output) shape. */
export type ImageRequestValue = z.infer<typeof imageRequestSchema>;
/** The accepted (input) shape a caller may pass; identical here (no defaults). */
export type ImageRequest = z.input<typeof imageRequestSchema>;

/**
 * A text-to-speech request. `sampleRate` defaults to 24000 Hz. `durationSec` is
 * optional; the local provider falls back to a short default when it is absent.
 */
export const ttsRequestSchema = z
  .object({
    text: z.string().min(1, "text is required").max(GEN_LIMITS.ttsText),
    voice: z.string().min(1).max(GEN_LIMITS.voice).optional(),
    format: z.enum(["wav"]),
    sampleRate: z.number().int().min(GEN_LIMITS.minSampleRate).max(GEN_LIMITS.maxSampleRate).default(GEN_LIMITS.defaultSampleRate),
    durationSec: z.number().min(GEN_LIMITS.minDurationSec).max(GEN_LIMITS.maxDurationSec).optional(),
  })
  .strict();
/** The validated (output) shape, with `sampleRate` always populated. */
export type TtsRequestValue = z.infer<typeof ttsRequestSchema>;
/** The accepted (input) shape a caller may pass, with `sampleRate` optional. */
export type TtsRequest = z.input<typeof ttsRequestSchema>;

// ---------------------------------------------------------------------------
// Provenance sidecar.
// ---------------------------------------------------------------------------

/**
 * The provenance record written beside every generated asset. It is forced to
 * declare `synthetic: true` and to carry a human-readable label, so a generated
 * asset can never masquerade as human-authored or sourced footage. `bytes` and
 * `sha256` describe the real file the store wrote; a caller never supplies them.
 */
export const generatedAssetSchema = z
  .object({
    format: z.literal(GENERATED_ASSET_FORMAT),
    kind: z.enum(["image", "audio"]),
    provider: safeIdSchema,
    model: z.string().min(1).max(GEN_LIMITS.model).optional(),
    mime: z.string().min(1).max(GEN_LIMITS.mime),
    bytes: z.number().int().min(0),
    sha256: z.string().regex(SHA256_HEX, "sha256 must be a 64-char lowercase hex digest"),
    requestSummary: z.string().max(GEN_LIMITS.requestSummary),
    synthetic: z.literal(true),
    label: z.string().min(1).max(GEN_LIMITS.label),
    createdAt: z.string().min(1),
  })
  .strict();
export type GeneratedAssetValue = z.infer<typeof generatedAssetSchema>;

// ---------------------------------------------------------------------------
// Parse helpers (mirror the workflow module's ParseResult contract).
// ---------------------------------------------------------------------------

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}

function parseWith<S extends z.ZodTypeAny>(schema: S, json: unknown): ParseResult<z.infer<S>> {
  const r = schema.safeParse(json);
  return r.success ? { ok: true, data: r.data, errors: [] } : { ok: false, errors: formatIssues(r.error) };
}

export const parseImageRequest = (j: unknown): ParseResult<ImageRequestValue> => parseWith(imageRequestSchema, j);
export const parseTtsRequest = (j: unknown): ParseResult<TtsRequestValue> => parseWith(ttsRequestSchema, j);
export const parseGeneratedAsset = (j: unknown): ParseResult<GeneratedAssetValue> => parseWith(generatedAssetSchema, j);
