/**
 * Schema migrations for the durable product store.
 *
 * The store is a single SQLite database driven through the built-in `node:sqlite`
 * module, so there is no native build step and no third-party dependency. Migrations
 * are ordered, idempotent, and recorded in `_migrations`; `migrate` applies only the
 * ones not yet seen, inside one transaction, so a partial upgrade can never leave the
 * schema half-built. Every table carries a `tenant_id` so tenant isolation is a WHERE
 * clause on every read, and immutable records (versions, decisions, receipts) are only
 * ever inserted, never updated.
 */

import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "initial",
    sql: `
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        token_sha256 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_users_tenant_username ON users(tenant_id, username);

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_projects_tenant ON projects(tenant_id);

      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        parent_version_id TEXT,
        plan_path TEXT NOT NULL,
        plan_sha256 TEXT NOT NULL,
        master_path TEXT,
        master_sha256 TEXT,
        status TEXT NOT NULL,
        creator TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, project_id, version)
      );
      CREATE INDEX idx_versions_project ON versions(tenant_id, project_id, version);

      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        frame INTEGER NOT NULL,
        time_sec REAL NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolved_by TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_comments_version ON comments(tenant_id, project_id, version_id);

      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        new_version_id TEXT NOT NULL,
        approved INTEGER NOT NULL,
        approver TEXT NOT NULL,
        role TEXT NOT NULL,
        notes TEXT,
        decided_at TEXT NOT NULL
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        payload TEXT NOT NULL,
        idempotency_key TEXT,
        enqueued_by TEXT NOT NULL,
        failure_detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT
      );
      CREATE UNIQUE INDEX idx_jobs_idem ON jobs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX idx_jobs_claim ON jobs(tenant_id, status, created_at);

      CREATE TABLE job_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX idx_attempts_job ON job_attempts(job_id);

      CREATE TABLE receipts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        provider_ref TEXT,
        published_by TEXT NOT NULL,
        data TEXT NOT NULL,
        published_at TEXT NOT NULL,
        UNIQUE(tenant_id, adapter_id, idempotency_key)
      );

      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        subject TEXT,
        detail TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_tenant ON audit(tenant_id, id);
    `,
  },
  {
    id: 2,
    name: "media-and-qa",
    sql: `
      CREATE TABLE media (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime TEXT NOT NULL,
        filename TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'upload',
        uploaded_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_media_project ON media(tenant_id, project_id, created_at);
      CREATE UNIQUE INDEX idx_media_key ON media(tenant_id, project_id, storage_key);

      CREATE TABLE qa_reports (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        pass INTEGER NOT NULL,
        report TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_qa_version ON qa_reports(tenant_id, project_id, version_id);
    `,
  },
  {
    id: 3,
    name: "one-decision-per-version",
    // At most one review decision per in-review source. This is the structural backstop
    // for the transactional guard in `recordDecision`: a second decision (even a racing
    // one) can never insert, so only one decision ever wins.
    sql: `CREATE UNIQUE INDEX idx_decisions_one_per_version ON decisions(tenant_id, project_id, version_id);`,
  },
  {
    id: 4,
    name: "quota-reservations",
    // Outstanding storage reservations. A reservation holds bytes against a tenant's quota
    // between the atomic check and the durable media registration, so the per-tenant quota is
    // a hard concurrent boundary: `reserveQuota` counts these plus registered media inside one
    // write transaction, `settleMedia` converts a reservation to a media row exactly once, and
    // `releaseReservation` frees it on failure. Rows are transient, never immutable history.
    sql: `
      CREATE TABLE quota_reservations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_quota_res_tenant ON quota_reservations(tenant_id);
    `,
  },
];

/** Apply every migration not already recorded, each inside its own transaction. */
export function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set<number>(
    (db.prepare("SELECT id FROM _migrations").all() as Array<{ id: number }>).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO _migrations(id, name, applied_at) VALUES(?, ?, ?)").run(
        m.id,
        m.name,
        new Date(0).toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
