import { describe, it, expect } from "vitest";
import {
  PERMISSION_ACTIONS,
  createPolicy,
  evaluatePermission,
  requireGrant,
  PermissionDeniedError,
  type PermissionGrant,
} from "../src/permissions/policy.js";

const AT = "2026-07-27T00:00:00.000Z";
const later = new Date("2026-07-28T00:00:00.000Z");

function grant(over: Partial<PermissionGrant> = {}): PermissionGrant {
  return { action: "network", grantedBy: "operator", grantedAt: AT, ...over };
}

describe("permission actions", () => {
  it("covers the four sensitive operation classes", () => {
    expect([...PERMISSION_ACTIONS].sort()).toEqual(
      ["code-change", "media-upload", "network", "publishing"].sort(),
    );
  });
});

describe("default deny", () => {
  it("denies every sensitive action with an empty policy", () => {
    const policy = createPolicy([]);
    for (const action of PERMISSION_ACTIONS) {
      const d = evaluatePermission(action, policy);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/no explicit grant/i);
    }
  });

  it("throws PermissionDeniedError from requireGrant when denied", () => {
    const policy = createPolicy([]);
    expect(() => requireGrant("publishing", policy)).toThrow(PermissionDeniedError);
    try {
      requireGrant("media-upload", policy);
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionDeniedError);
      expect((err as PermissionDeniedError).action).toBe("media-upload");
    }
  });
});

describe("explicit grants", () => {
  it("allows only the granted action, still denying the rest", () => {
    const policy = createPolicy([grant({ action: "network" })]);
    expect(evaluatePermission("network", policy).allowed).toBe(true);
    expect(evaluatePermission("publishing", policy).allowed).toBe(false);
    expect(evaluatePermission("media-upload", policy).allowed).toBe(false);
    expect(evaluatePermission("code-change", policy).allowed).toBe(false);
  });

  it("does not throw from requireGrant when granted", () => {
    const policy = createPolicy([grant({ action: "code-change" })]);
    expect(() => requireGrant("code-change", policy)).not.toThrow();
  });
});

describe("expiry", () => {
  it("treats an expired grant as no grant", () => {
    const policy = createPolicy([grant({ action: "network", expiresAt: AT })]);
    const d = evaluatePermission("network", policy, later);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/expired/i);
  });

  it("honors a still-valid grant before expiry", () => {
    const policy = createPolicy([grant({ action: "network", expiresAt: "2026-07-29T00:00:00.000Z" })]);
    expect(evaluatePermission("network", policy, later).allowed).toBe(true);
  });
});

describe("grant hygiene", () => {
  it("rejects a grant for an unknown action at policy construction", () => {
    // @ts-expect-error unknown action must be rejected by the type and at runtime.
    expect(() => createPolicy([grant({ action: "delete-everything" })])).toThrow(/unknown permission action/i);
  });
});
