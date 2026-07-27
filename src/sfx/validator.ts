import { readFileSync } from "node:fs";
import { validateCues, type GateResult, type RawCue } from "./gates.js";

/**
 * Load a cue sheet from disk. Accepts either a top-level array or an object
 * with a `cues` array, matching the committed sfx-cue-sheet template.
 */
export function loadCueSheet(filePath: string): RawCue[] {
  const data: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  const cues = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { cues?: unknown }).cues)
      ? (data as { cues: unknown[] }).cues
      : null;
  if (!cues) {
    throw new Error("Cue sheet must be a list or an object with a 'cues' list");
  }
  return cues as RawCue[];
}

export function validateCueSheetFile(filePath: string): GateResult & { count: number } {
  const cues = loadCueSheet(filePath);
  const result = validateCues(cues);
  return { ...result, count: cues.length };
}

export { validateCues };
