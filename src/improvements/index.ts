/**
 * Public surface for reviewed improvement proposals (parity phase 7).
 *
 * Proposals are approved, auditable, reversible. A provider returns DATA;
 * deterministic code validates, gates on human approval plus a `code-change`
 * grant, applies atomically with exact backups, and restores exact prior bytes on
 * rollback. No silent self-modification.
 */

export * from "./schemas.js";
export * from "./guard.js";
export * from "./apply.js";
export * from "./rollback.js";
export * from "./provider.js";
