/**
 * Durable product store: a transactional SQLite repository over the built-in
 * `node:sqlite` module. No native build, no third-party dependency. See
 * `repository.ts` for the invariants and `migrations.ts` for the schema.
 */

export * from "./migrations.js";
export * from "./repository.js";
