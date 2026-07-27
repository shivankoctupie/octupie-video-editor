/**
 * Robust JSON-object extraction from arbitrary model text.
 *
 * Models wrap JSON in prose, code fences, or leading commentary even when asked
 * not to. This finds the first balanced top-level object, ignoring braces that
 * appear inside strings, and parses it. It never evaluates code and never runs
 * anything the model returned; it only reads data.
 */

export interface JsonExtractResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export function extractJsonObject(input: string): JsonExtractResult {
  const stripped = stripFences(input);
  const slice = firstBalancedObject(stripped);
  if (slice === null) {
    return { ok: false, error: "no JSON object found in model output" };
  }
  try {
    return { ok: true, value: JSON.parse(slice) };
  } catch (err) {
    return { ok: false, error: `malformed JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function stripFences(input: string): string {
  const fence = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1]! : input;
}

/** Return the substring of the first balanced `{...}`, honoring string quoting. */
function firstBalancedObject(input: string): string | null {
  const start = input.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i++) {
    const ch = input[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return input.slice(start, i + 1);
      }
    }
  }
  return null;
}
