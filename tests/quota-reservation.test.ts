import { afterEach, describe, expect, it } from "vitest";
import { createRepository, type Repository } from "../src/server/db/index.js";

/*
 * Transactional per-tenant quota reservation. The check ("is there room?") and the
 * accounting (a reservation row) happen inside ONE write transaction, so two callers can
 * never both cross the tenant boundary. A reservation is settled into a durable media row
 * exactly once, released on failure, and is strictly per tenant.
 */

let t = Date.parse("2026-08-01T00:00:00.000Z");
const clock = { now: () => new Date((t += 1000)).toISOString() };

const repos: Repository[] = [];
afterEach(() => { for (const r of repos.splice(0)) r.close(); });
function repo(): Repository { const r = createRepository(":memory:", clock); repos.push(r); return r; }

function media(over: { id: string; tenantId: string; storageKey: string; size: number }) {
  return { id: over.id, tenantId: over.tenantId, projectId: "p1", storageKey: over.storageKey, sha256: "a".repeat(64), size: over.size, mime: "video/mp4", filename: "a.mp4", origin: "upload", uploadedBy: "u" };
}

describe("Repository quota reservation", () => {
  it("refuses a second reservation that would cross the boundary, counting outstanding reservations", () => {
    const r = repo();
    expect(r.reserveQuota({ id: "r1", tenantId: "t1", bytes: 40, maxBytes: 64 }).ok).toBe(true);
    // The second reservation must see the first outstanding one (40 + 40 = 80 > 64).
    expect(r.reserveQuota({ id: "r2", tenantId: "t1", bytes: 40, maxBytes: 64 }).ok).toBe(false);
  });

  it("settles a reservation into a media row exactly once, keeping the accounting consistent", () => {
    const r = repo();
    expect(r.reserveQuota({ id: "r1", tenantId: "t1", bytes: 40, maxBytes: 64 }).ok).toBe(true);
    r.settleMedia({ reservationId: "r1", media: media({ id: "m1", tenantId: "t1", storageKey: "t1/p1/a", size: 40 }) });
    // After settle the media holds 40 and the reservation is gone: usage is 40, not 80.
    expect(r.tenantStorageBytes("t1")).toBe(40);
    // The remaining 24 fits; 25 does not.
    expect(r.reserveQuota({ id: "r2", tenantId: "t1", bytes: 24, maxBytes: 64 }).ok).toBe(true);
    expect(r.reserveQuota({ id: "r3", tenantId: "t1", bytes: 25, maxBytes: 64 }).ok).toBe(false);
  });

  it("releases a reservation so its bytes become available again", () => {
    const r = repo();
    expect(r.reserveQuota({ id: "r1", tenantId: "t1", bytes: 60, maxBytes: 64 }).ok).toBe(true);
    expect(r.reserveQuota({ id: "r2", tenantId: "t1", bytes: 60, maxBytes: 64 }).ok).toBe(false);
    r.releaseReservation("r1");
    expect(r.reserveQuota({ id: "r3", tenantId: "t1", bytes: 60, maxBytes: 64 }).ok).toBe(true);
  });

  it("keeps reservations strictly per tenant", () => {
    const r = repo();
    expect(r.reserveQuota({ id: "r1", tenantId: "t1", bytes: 64, maxBytes: 64 }).ok).toBe(true);
    // t2 has its own budget; t1 being full does not affect it.
    expect(r.reserveQuota({ id: "r2", tenantId: "t2", bytes: 64, maxBytes: 64 }).ok).toBe(true);
    // t1 is full.
    expect(r.reserveQuota({ id: "r3", tenantId: "t1", bytes: 1, maxBytes: 64 }).ok).toBe(false);
  });

  it("settling deduplicated content releases the reservation without double counting", () => {
    const r = repo();
    r.settleMedia({ media: media({ id: "m1", tenantId: "t1", storageKey: "t1/p1/a", size: 40 }) });
    expect(r.tenantStorageBytes("t1")).toBe(40);
    // Reserve then settle the SAME storage key: registration is idempotent, so usage stays 40.
    expect(r.reserveQuota({ id: "r2", tenantId: "t1", bytes: 40, maxBytes: 100 }).ok).toBe(true);
    r.settleMedia({ reservationId: "r2", media: media({ id: "m2", tenantId: "t1", storageKey: "t1/p1/a", size: 40 }) });
    expect(r.tenantStorageBytes("t1")).toBe(40);
  });
});
