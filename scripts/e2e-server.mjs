/*
 * Launches the built product server for browser end-to-end tests and manual dogfooding.
 * A single admin user with a known token is configured so a test can sign in; storage lives
 * in a scratch dir under output/ (gitignored) and the database is in-memory, so each run is
 * clean and nothing is left staged. Run after `npm run build` (it imports from dist/).
 */
import { rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { startServer, defaultConfig } from "../dist/server/index.js";

const root = resolve(process.cwd(), "output", "e2e");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const config = defaultConfig({
  host: "127.0.0.1",
  port: Number(process.env.E2E_PORT || 8123),
  dbPath: ":memory:",
  storageRoot: resolve(root, "storage"),
  tempDir: resolve(root, "temp"),
  publicDir: resolve(process.cwd(), "public"),
  users: [{ id: "u-admin", tenantId: "t1", username: "admin", role: "admin", token: process.env.E2E_TOKEN || "e2e-admin-token-0123456789abcdef" }],
});

const server = await startServer(config);
process.stdout.write(`e2e server on ${server.url}\n`);
const shutdown = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
