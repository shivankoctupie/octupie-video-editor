import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 8123);

/*
 * Browser end-to-end tests. Playwright starts the built product server (scripts/e2e-server.mjs)
 * with a known admin token and drives the real editor in Chromium: upload, drag, trim, split,
 * undo, zoom, play/seek, save, reload. Run `npm run build` and `npm run e2e:install` first.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
    browserName: "chromium",
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT) },
  },
});
