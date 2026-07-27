import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import type { EditPlan } from "../schema/editPlan.js";
import { assetRoot } from "../util/assetRoot.js";

/**
 * Data-driven Remotion bridge. It bundles the composition entry, selects the
 * composition named by the plan, and renders a silent master. Audio (SFX bed and
 * tone) is assembled deterministically by the FFmpeg layer and muxed afterward,
 * so the planner/renderer split stays clean and reproducible.
 */

let cachedServeUrl: string | null = null;
let cachedPublicDir: string | null = null;

/** Locate the Remotion entry from source, working in both dev and built modes. */
function resolveEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "remotion/index.ts"), // dev (tsx): src/render/remotion
    resolve(here, "remotion/index.tsx"),
    resolve(here, "../../src/render/remotion/index.ts"), // built: dist/render -> src
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Could not locate the Remotion entry. Looked in: ${candidates.join(", ")}`);
}

export async function bundleProject(): Promise<string> {
  const publicDir = assetRoot();
  if (cachedServeUrl && cachedPublicDir === publicDir) return cachedServeUrl;
  cachedServeUrl = await bundle({
    entryPoint: resolveEntry(),
    publicDir,
    // NodeNext source uses explicit .js import specifiers; teach webpack to
    // resolve those to the real .ts/.tsx files in this repo.
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensionAlias: {
          ...(config.resolve?.extensionAlias ?? {}),
          ".js": [".tsx", ".ts", ".js"],
        },
      },
    }),
  });
  cachedPublicDir = publicDir;
  return cachedServeUrl;
}

export interface RenderResult {
  outPath: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
}

/** Render a plan to a silent H.264 master at `outPath`. */
export async function renderSilentMaster(plan: EditPlan, outPath: string): Promise<RenderResult> {
  const serveUrl = await bundleProject();
  const composition = await selectComposition({
    serveUrl,
    id: plan.composition,
    inputProps: { plan },
  });

  const concurrencyEnv = process.env.OVE_RENDER_CONCURRENCY?.trim();
  const concurrency = concurrencyEnv ? Number(concurrencyEnv) : null;

  await renderMedia({
    serveUrl,
    composition,
    codec: "h264",
    outputLocation: outPath,
    inputProps: { plan },
    pixelFormat: "yuv420p",
    imageFormat: "png",
    colorSpace: "bt709",
    muted: true,
    enforceAudioTrack: false,
    ...(concurrency ? { concurrency } : {}),
    chromiumOptions: { gl: "angle" },
  });

  return {
    outPath,
    durationInFrames: composition.durationInFrames,
    fps: composition.fps,
    width: composition.width,
    height: composition.height,
  };
}
