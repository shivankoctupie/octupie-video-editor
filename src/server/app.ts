/**
 * Application wiring: turn a ServerConfig into a running product server.
 *
 * Wires the durable repository, the local content-addressed storage, the token
 * registry, the RBAC router, and the publishing adapters, then seeds the configured
 * tenants and users. Publishing is disabled unless the operator configured an adapter
 * and a `publishing` grant. Network and DNS for the optional webhook adapter are
 * injectable so tests stay fully offline.
 */

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import { createPolicy } from "../permissions/policy.js";
import { disabledPublishingAdapter, type PublishingAdapter } from "../workflow/publishing.js";
import { createWebhookPublishingAdapter } from "../workflow/webhookPublishing.js";
import { createNodeFetch } from "../util/pinnedFetch.js";
import type { FetchLike } from "../util/fetchLike.js";
import type { HostResolver } from "../util/ssrf.js";
import { AuthRegistry, sha256Hex } from "./auth.js";
import { createRepository, type RepoClock, type Repository } from "./db/repository.js";
import { createLocalStorage } from "./storage/local.js";
import type { StorageAdapter } from "./storage/adapter.js";
import { Router } from "./http.js";
import { registerRoutes, type RouteDeps } from "./routes.js";
import type { ServerConfig } from "./config.js";

export interface AppOptions {
  clock?: RepoClock;
  /** Injected fetch for the webhook adapter (defaults to the global fetch). */
  fetch?: FetchLike;
  /** Injected DNS resolver for SSRF checks (defaults to a real all-records lookup). */
  resolve?: HostResolver;
  /** Override the storage adapter (defaults to a local content-addressed store). */
  storage?: StorageAdapter;
}

export interface App {
  repo: Repository;
  storage: StorageAdapter;
  auth: AuthRegistry;
  router: Router;
  config: ServerConfig;
  adapters: Map<string, PublishingAdapter>;
}

async function realResolver(host: string): Promise<string[]> {
  try {
    const records = await dnsPromises.lookup(host, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

/** Build the app (repository, storage, auth, router) without listening. */
export function createApp(config: ServerConfig, opts: AppOptions = {}): App {
  const clock: RepoClock = opts.clock ?? { now: () => new Date().toISOString() };
  const repo = createRepository(config.dbPath, clock);
  const storage = opts.storage ?? createLocalStorage(config.storageRoot);
  const auth = new AuthRegistry(config.users);

  // Seed tenants and users so audit and version rows have a real principal to reference.
  for (const tenantId of auth.tenantIds()) {
    if (!repo.getTenant(tenantId)) repo.createTenant({ id: tenantId, name: tenantId });
  }
  for (const user of config.users) {
    const hash = sha256Hex(user.token);
    if (!repo.getUserByTokenHash(hash)) {
      repo.createUser({ id: user.id, tenantId: user.tenantId, username: user.username, role: user.role, tokenSha256: hash });
    }
  }

  // The production transport pins each connection to the SSRF-validated public IP, so a
  // rebinding record cannot move a socket onto a private address after validation. Tests
  // inject their own offline fetch.
  const defaultFetch: FetchLike = createNodeFetch();

  const adapters = new Map<string, PublishingAdapter>();
  adapters.set(disabledPublishingAdapter.id, disabledPublishingAdapter);
  if (config.webhook) {
    const adapter = createWebhookPublishingAdapter({
      id: "webhook",
      endpointUrl: config.webhook.endpointUrl,
      allowedHosts: config.webhook.allowedHosts,
      fetch: opts.fetch ?? defaultFetch,
      resolve: opts.resolve ?? realResolver,
      ...(config.webhook.secretEnv ? { secretEnv: config.webhook.secretEnv } : {}),
    });
    adapters.set(adapter.id, adapter);
  }

  const policy = createPolicy(config.grants);
  const fetchImpl: FetchLike = opts.fetch ?? defaultFetch;
  const resolveImpl: HostResolver = opts.resolve ?? realResolver;
  const router = new Router(auth, config.publicDir);
  const deps: RouteDeps = {
    repo,
    storage,
    config,
    policy,
    adapters,
    fetch: fetchImpl,
    resolve: resolveImpl,
    driveTokenEnv: config.driveTokenEnv ?? "OVE_DRIVE_TOKEN",
    now: () => clock.now(),
    id: () => randomUUID(),
  };
  registerRoutes(router, deps);

  return { repo, storage, auth, router, config, adapters };
}

export interface RunningServer extends App {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Build the app and start listening. Pass port 0 for an ephemeral test port. */
export function startServer(config: ServerConfig, opts: AppOptions = {}): Promise<RunningServer> {
  const app = createApp(config, opts);
  const server = createServer(app.router.listener());
  return new Promise<RunningServer>((resolve, reject) => {
    server.on("error", reject);
    server.listen(config.port, config.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : config.port;
      resolve({
        ...app,
        server,
        port,
        url: `http://${config.host}:${port}`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              app.repo.close();
              res();
            });
            // Graceful close waits for open connections. Clients using HTTP keep-alive (e.g. the
            // Node/undici global fetch, or a browser) keep a pooled socket warm after their last
            // request, which would hold the server open. Drop idle sockets first, then close any
            // remaining active sockets because close() is the explicit terminal shutdown path.
            // This keeps teardown bounded even if a client leaves a response stream open.
            server.closeIdleConnections();
            server.closeAllConnections();
          }),
      });
    });
  });
}
