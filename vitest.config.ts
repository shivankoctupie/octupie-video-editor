import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Backend tests are plain .test.ts under tests/. Client reducer/mapping tests are
    // added as .test.ts / .test.tsx (pure, node env). Any test needing a DOM opts in with
    // a `// @vitest-environment jsdom` docblock. Playwright specs (tests/e2e/*.spec.ts) are
    // driven by `npm run e2e`, never by vitest.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
    environment: "node",
    // Heavy integration suites (real server + on-disk SQLite + temp-dir cleanup) need headroom
    // for their setup/teardown hooks when the whole suite runs in parallel.
    testTimeout: 30000,
    hookTimeout: 45000,
    // These suites are CPU + I/O heavy; on an 8-core machine the default worker count starves
    // each one enough to blow the hook budget. Cap concurrency so every suite gets real CPU.
    maxWorkers: 4,
  },
});
