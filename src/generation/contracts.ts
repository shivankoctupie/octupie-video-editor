/**
 * Provider-neutral contracts for image and text-to-speech generation.
 *
 * One interface is shared by the local, fully offline providers and the optional
 * OpenAI-compatible HTTP adapters. Both take a {@link PermissionPolicy}: the local
 * providers ignore it (they never leave the machine), while the HTTP adapters
 * require a `network` grant before any request. A provider returns raw bytes and a
 * declared mime; nothing here writes a file or validates provenance (see
 * `provenance.ts`).
 */

import type { PermissionPolicy } from "../permissions/policy.js";
import type { ImageRequest, TtsRequest } from "./schemas.js";

/** The raw output of one generation: bytes plus the mime the provider declares. */
export interface GenerateOutput {
  bytes: Uint8Array;
  mime: string;
  /** The upstream model name, when a model produced the bytes. */
  model?: string;
}

/** An image provider. `policy` gates network access; offline providers ignore it. */
export interface ImageProvider {
  readonly id: string;
  generate(req: ImageRequest, policy: PermissionPolicy): Promise<GenerateOutput>;
}

/** A text-to-speech provider. `policy` gates network access; offline providers ignore it. */
export interface TtsProvider {
  readonly id: string;
  synthesize(req: TtsRequest, policy: PermissionPolicy): Promise<GenerateOutput>;
}

/** The only image mimes the store will persist. */
export const APPROVED_IMAGE_MIME: ReadonlySet<string> = new Set(["image/svg+xml", "image/png"]);

/** The only audio mimes the store will persist. */
export const APPROVED_AUDIO_MIME: ReadonlySet<string> = new Set(["audio/wav", "audio/x-wav"]);
