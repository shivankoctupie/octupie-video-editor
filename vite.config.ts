import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/*
 * Client build for the Octupie Video Editor timeline app.
 *
 * The React client lives under src/client and builds into public/, which the product
 * server already serves as its static root. Output filenames are pinned to app.js and
 * styles.css (no content hash) so the server's simple no-cache static serving and the
 * existing "served locally, no CDN" acceptance gates keep working. Source maps are off
 * for production. Nothing is loaded from a CDN: React, the timeline engine, and styles
 * are all bundled into the two local files.
 */

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const clientRoot = resolve(rootDir, "src/client");
const publicOut = resolve(rootDir, "public");

export default defineConfig({
  root: clientRoot,
  base: "/",
  plugins: [react()],
  build: {
    outDir: publicOut,
    emptyOutDir: true,
    sourcemap: false,
    // Single entry, no code-splitting: everything static-imported lands in app.js so the
    // shell needs exactly one script and one stylesheet, both same-origin.
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (info): string => {
          const name = (info.names && info.names[0]) || info.name || "";
          if (name.endsWith(".css")) return "styles.css";
          return "assets/[name][extname]";
        },
      },
    },
  },
  server: {
    port: 5178,
    // Standalone `vite` dev server proxies the API to the product server (`npm run dev:server`).
    proxy: { "/api": "http://127.0.0.1:8722" },
  },
});
