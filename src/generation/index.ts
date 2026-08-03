/**
 * Public surface for provider-neutral image and text-to-speech generation.
 *
 * Two local, deterministic, fully offline providers (an SVG proof card and a
 * silent test-tone WAV) and two optional OpenAI-compatible HTTP adapters share
 * one interface. The HTTP adapters bundle no keys, require a `network` grant, and
 * never claim to be verified. Every generated asset is stored atomically with a
 * provenance sidecar that marks it `synthetic: true`.
 */

export * from "./schemas.js";
export * from "./contracts.js";
export * from "./localImage.js";
export * from "./localTts.js";
export * from "./provenance.js";
export * from "./httpImage.js";
export * from "./httpTts.js";
export type { HttpProviderDescription } from "./httpShared.js";
