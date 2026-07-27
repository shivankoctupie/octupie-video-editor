import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { runDemo } from "../src/demo/generate.js";

/**
 * End-to-end: exercises the REAL Remotion renderer, the FFmpeg audio assembly,
 * and the final-master QA. On first run Remotion downloads a headless browser,
 * so this uses a generous timeout. Set OVE_SKIP_RENDER_TESTS=1 to skip locally.
 */
const skip = process.env.OVE_SKIP_RENDER_TESTS === "1";

describe.skipIf(skip)("render + QA pipeline (integration)", () => {
  it(
    "renders the synthetic demo and passes every QA gate",
    async () => {
      const result = await runDemo();
      expect(existsSync(result.finalPath)).toBe(true);
      expect(result.report.pass).toBe(true);
      // Report is bound to the exact delivered bytes.
      expect(result.report.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.report.generatedFromHash).toBe(result.report.sha256);
      const failed = result.report.gates.filter((g) => !g.pass).map((g) => g.name);
      expect(failed, `failed gates: ${failed.join(", ")}`).toHaveLength(0);
    },
    240000,
  );
});
