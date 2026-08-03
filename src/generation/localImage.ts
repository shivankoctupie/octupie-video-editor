/**
 * Local, deterministic, offline image provider (id `local-svg`).
 *
 * It renders an Octupie-branded proof/title card as an SVG: paper background,
 * ink title, and a single selective-blue rule. The output is a byte-identical
 * function of the request, so the same request always yields the same bytes. The
 * card is clearly a generated placeholder, never a photograph, and the prompt is
 * XML-escaped so no request text can break out of the markup. This provider is
 * fully offline: it ignores the permission policy and never reaches the network.
 */

import type { GenerateOutput, ImageProvider } from "./contracts.js";
import { parseImageRequest, type ImageRequest, type ImageRequestValue } from "./schemas.js";

/** Octupie brand tokens: paper, ink, and the selective blue accent. */
const PAPER = "#F7F5F0";
const INK = "#111111";
const BLUE = "#014CE3";

/** Escape the five XML metacharacters so request text stays inert inside markup. */
export function xmlEscape(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Deterministically render the branded proof card for a validated request. */
function renderCard(req: ImageRequestValue): string {
  const { width, height, prompt } = req;
  const promptText = xmlEscape(prompt);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="AI-generated proof card">`,
    `  <rect width="${width}" height="${height}" fill="${PAPER}"/>`,
    `  <rect x="0" y="0" width="${width}" height="8" fill="${BLUE}"/>`,
    `  <text x="32" y="64" font-family="Georgia, 'Times New Roman', serif" font-size="30" font-weight="bold" fill="${INK}">AI-generated proof card</text>`,
    `  <text x="32" y="104" font-family="Georgia, 'Times New Roman', serif" font-size="18" fill="${INK}">Octupie Video Editor, synthetic placeholder (not a photograph)</text>`,
    `  <text x="32" y="150" font-family="Georgia, 'Times New Roman', serif" font-size="16" fill="${INK}">${promptText}</text>`,
    "</svg>",
    "",
  ].join("\n");
}

/** The local, offline SVG proof-card provider. */
export const localImageProvider: ImageProvider = {
  id: "local-svg",
  async generate(req: ImageRequest): Promise<GenerateOutput> {
    const parsed = parseImageRequest(req);
    if (!parsed.ok || !parsed.data) {
      throw new Error(`Invalid image request: ${parsed.errors.join("; ")}`);
    }
    const value = parsed.data;
    if (value.format !== "svg") {
      throw new Error(`local-svg renders only 'svg'; requested '${value.format}'.`);
    }
    const bytes = new TextEncoder().encode(renderCard(value));
    return { bytes, mime: "image/svg+xml" };
  },
};
