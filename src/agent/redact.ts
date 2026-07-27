/**
 * Secret redaction and size bounds for the agentic layer.
 *
 * Anything derived from a model reply, a brief, or a prompt is redacted before
 * it is written to an audit log, so an accidental key paste never lands on disk
 * in the clear. Sizes are bounded so a hostile or runaway input cannot exhaust
 * memory or fill the audit directory.
 */

export const MAX_SIZES = {
  /** Raw brief JSON. */
  brief: 256 * 1024,
  /** Transcript text loaded from the brief or a file. */
  transcript: 512 * 1024,
  /** A single learned rule's text. */
  rule: 4 * 1024,
  /** A single raw model reply. Clamped, not rejected. */
  modelResponse: 512 * 1024,
} as const;

const REDACTED = "[REDACTED]";

// Ordered most-specific first. Each pattern captures the secret region and
// replaces it with a fixed token, preserving surrounding structure for context.
const PATTERNS: Array<{ re: RegExp; replace: (m: RegExpMatchArray) => string }> = [
  // Bearer tokens: keep the scheme, drop the credential.
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, replace: () => `Bearer ${REDACTED}` },
  // KEY=value / KEY: value for common secret-bearing names.
  {
    re: /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[:=]\s*("?)([^\s"']{8,})\2/gi,
    replace: (m) => `${m[1]}=${REDACTED}`,
  },
  // Anthropic keys.
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: () => REDACTED },
  // OpenAI keys (classic and project-scoped).
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replace: () => REDACTED },
  // AWS access key ids.
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: () => REDACTED },
  // GitHub tokens.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => REDACTED },
  // Google API keys.
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: () => REDACTED },
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, (...args) => {
      // String.replace passes (match, ...groups, offset, string); rebuild an
      // array shaped like a RegExpMatchArray for the replacer.
      const groups = args.slice(0, -2) as string[];
      return replace(groups as unknown as RegExpMatchArray);
    });
  }
  return out;
}

/** Clamp text to a byte-ish character budget, marking that it was cut. */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  const marker = `\n...[truncated ${input.length - max} chars]`;
  const keep = Math.max(0, max - marker.length);
  return input.slice(0, keep) + marker;
}

/** Reject input that exceeds a hard limit. Used for briefs, transcripts, rules. */
export function enforceMaxSize(input: string, max: number, label: string): void {
  if (input.length > max) {
    throw new Error(`${label} too large: ${input.length} chars exceeds the ${max} char limit`);
  }
}
