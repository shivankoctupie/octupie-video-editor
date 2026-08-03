/**
 * Authentication for the product server.
 *
 * Tokens come only from environment/config, never from the database and never from a
 * request. Each configured user carries a bearer token; the registry stores only the
 * SHA-256 digest of that token, and authentication compares digests with
 * `timingSafeEqual` over every entry (no early return), so a token is neither leaked by
 * timing nor by which tenant matched. Raw tokens are never stored on a principal, never
 * returned, and never logged. Weak or duplicate tokens are refused at construction.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { WORKFLOW_ROLES, type WorkflowRole } from "../workflow/schemas.js";

const MIN_TOKEN_LENGTH = 16;

export interface AuthUserConfig {
  id: string;
  tenantId: string;
  username: string;
  role: WorkflowRole;
  /** The bearer token, supplied from environment/config only. */
  token: string;
}

export interface Principal {
  userId: string;
  tenantId: string;
  username: string;
  role: WorkflowRole;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function digestOf(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export class AuthRegistry {
  private readonly entries: Array<{ digest: Buffer; principal: Principal }> = [];

  constructor(users: readonly AuthUserConfig[]) {
    const seenTokens = new Set<string>();
    const seenIds = new Set<string>();
    for (const u of users) {
      if (typeof u.token !== "string" || u.token.length < MIN_TOKEN_LENGTH) {
        throw new AuthConfigError(`Token for user '${u.id}' is missing or shorter than ${MIN_TOKEN_LENGTH} characters.`);
      }
      if (!(WORKFLOW_ROLES as readonly string[]).includes(u.role)) {
        throw new AuthConfigError(`Unknown role '${u.role}' for user '${u.id}'.`);
      }
      const hex = sha256Hex(u.token);
      if (seenTokens.has(hex)) throw new AuthConfigError("Two users share the same token; tokens must be unique.");
      if (seenIds.has(u.id)) throw new AuthConfigError(`Duplicate user id '${u.id}'.`);
      seenTokens.add(hex);
      seenIds.add(u.id);
      this.entries.push({
        digest: digestOf(u.token),
        principal: { userId: u.id, tenantId: u.tenantId, username: u.username, role: u.role },
      });
    }
  }

  /** Resolve a bearer token to its principal in constant-ish time, or null. */
  authenticate(bearer: string | undefined | null): Principal | null {
    if (typeof bearer !== "string" || bearer.length === 0) return null;
    const candidate = digestOf(bearer);
    let match: Principal | null = null;
    for (const entry of this.entries) {
      // Digests are always 32 bytes, so timingSafeEqual never throws on length.
      if (timingSafeEqual(candidate, entry.digest)) match = entry.principal;
    }
    return match;
  }

  /** The configured principals, with no token material. */
  principals(): Principal[] {
    return this.entries.map((e) => ({ ...e.principal }));
  }

  /** Distinct tenant ids across all principals, for seeding tenant rows. */
  tenantIds(): string[] {
    return [...new Set(this.entries.map((e) => e.principal.tenantId))];
  }

  /** The SHA-256 digest hex for a configured user, so a store can mirror the principal. */
  tokenHashFor(userId: string, users: readonly AuthUserConfig[]): string | null {
    const u = users.find((x) => x.id === userId);
    return u ? sha256Hex(u.token) : null;
  }
}
