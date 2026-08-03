/**
 * Storage adapters: a content-addressed contract with a verified local filesystem
 * implementation and an S3-compatible config/contract adapter (no credentials at
 * startup, unavailable until a real client is injected).
 */

export * from "./adapter.js";
export * from "./local.js";
export * from "./s3.js";
