/**
 * Product server configuration.
 *
 * Everything that reaches beyond the local, offline boundary is opt-in and supplied by
 * the operator: bearer tokens, permission grants, and any external adapter config come
 * from the environment or an explicit config object, never from defaults baked into the
 * repository. With no configuration the server runs locally with an in-memory database,
 * a temp workspace, publishing disabled, and no network adapters.
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AuthUserConfig } from "./auth.js";
import type { PermissionGrant } from "../permissions/policy.js";

export interface WebhookConfig {
  endpointUrl: string;
  allowedHosts: string[];
  secretEnv?: string;
}

export interface ServerConfig {
  name: string;
  version: string;
  host: string;
  port: number;
  /** SQLite path, or ":memory:" for an ephemeral store. */
  dbPath: string;
  /** Local content-addressed media/plan storage root. */
  storageRoot: string;
  /** Directory for streaming upload temp files. */
  tempDir: string;
  /** Static browser app directory. */
  publicDir: string;
  users: AuthUserConfig[];
  /** Operator-supplied permission grants (network, media-upload, publishing, code-change). */
  grants: PermissionGrant[];
  maxUploadBytes: number;
  maxJsonBytes: number;
  /** Per-tenant durable storage quota in bytes, counting uploads, imported (materialized)
   * bytes, and generated assets. Enforced before a media row is registered. */
  maxTenantBytes: number;
  webhook?: WebhookConfig;
  /** Env var NAME holding an optional Google Drive OAuth token, read at call time only. */
  driveTokenEnv?: string;
}

const PACKAGE_VERSION = "0.1.0";

/** Build a config from partial overrides, filling safe local defaults. */
export function defaultConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: "octupie-video-editor",
    version: PACKAGE_VERSION,
    host: "127.0.0.1",
    port: 8722,
    dbPath: ":memory:",
    storageRoot: resolve(overrides.storageRoot ?? join(process.cwd(), "output", "server", "storage")),
    tempDir: resolve(overrides.tempDir ?? join(tmpdir(), "octupie-uploads")),
    publicDir: resolve(overrides.publicDir ?? join(process.cwd(), "public")),
    users: [],
    grants: [],
    maxUploadBytes: 500 * 1024 * 1024,
    maxJsonBytes: 2 * 1024 * 1024,
    // 2 GiB per tenant by default: comfortably above normal single-project use, but a
    // hard bound so no tenant can exhaust the host. Operators tune it per deployment.
    maxTenantBytes: 2 * 1024 * 1024 * 1024,
    ...overrides,
  };
}

/** Parse the users JSON from an env var. Shape: [{ id, tenantId, username, role, token }]. */
export function parseUsersEnv(raw: string | undefined): AuthUserConfig[] {
  if (!raw || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OVE_SERVER_USERS is not valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("OVE_SERVER_USERS must be a JSON array.");
  return parsed.map((u, i) => {
    const o = u as Record<string, unknown>;
    for (const k of ["id", "tenantId", "username", "role", "token"]) {
      if (typeof o[k] !== "string" || (o[k] as string).length === 0) {
        throw new Error(`OVE_SERVER_USERS[${i}] is missing string field '${k}'.`);
      }
    }
    return { id: o.id as string, tenantId: o.tenantId as string, username: o.username as string, role: o.role as AuthUserConfig["role"], token: o.token as string };
  });
}

/** Parse permission grants from an env var. Shape: [{ action, grantedBy, grantedAt, expiresAt? }]. */
export function parseGrantsEnv(raw: string | undefined): PermissionGrant[] {
  if (!raw || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OVE_SERVER_GRANTS is not valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("OVE_SERVER_GRANTS must be a JSON array.");
  return parsed as PermissionGrant[];
}

/** Build a config from process.env for the CLI `serve`/`worker` commands. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const overrides: Partial<ServerConfig> = {
    users: parseUsersEnv(env.OVE_SERVER_USERS),
    grants: parseGrantsEnv(env.OVE_SERVER_GRANTS),
  };
  if (env.OVE_SERVER_HOST) overrides.host = env.OVE_SERVER_HOST;
  if (env.OVE_SERVER_PORT) overrides.port = Number(env.OVE_SERVER_PORT);
  if (env.OVE_SERVER_DB) overrides.dbPath = env.OVE_SERVER_DB;
  if (env.OVE_SERVER_STORAGE) overrides.storageRoot = env.OVE_SERVER_STORAGE;
  if (env.OVE_SERVER_TEMP) overrides.tempDir = env.OVE_SERVER_TEMP;
  if (env.OVE_SERVER_PUBLIC) overrides.publicDir = env.OVE_SERVER_PUBLIC;
  if (env.OVE_SERVER_MAX_UPLOAD) overrides.maxUploadBytes = Number(env.OVE_SERVER_MAX_UPLOAD);
  if (env.OVE_SERVER_MAX_TENANT_BYTES) overrides.maxTenantBytes = Number(env.OVE_SERVER_MAX_TENANT_BYTES);
  if (env.OVE_DRIVE_TOKEN_ENV) overrides.driveTokenEnv = env.OVE_DRIVE_TOKEN_ENV;
  if (env.OVE_WEBHOOK_URL && env.OVE_WEBHOOK_HOSTS) {
    overrides.webhook = {
      endpointUrl: env.OVE_WEBHOOK_URL,
      allowedHosts: env.OVE_WEBHOOK_HOSTS.split(",").map((h) => h.trim()).filter(Boolean),
      ...(env.OVE_WEBHOOK_SECRET_ENV ? { secretEnv: env.OVE_WEBHOOK_SECRET_ENV } : {}),
    };
  }
  return defaultConfig(overrides);
}
