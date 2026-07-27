/**
 * Deterministic editorial analysis over a word-timed transcript.
 *
 * Everything here is an explicit, auditable heuristic, not a semantic judgement.
 * Filler detection is a fixed lexicon match. Crew-prompt / restart detection is a
 * fixed phrase list. Repeated-take grouping is token-set (Jaccard) similarity of
 * adjacent segments. Candidate-hook scoring is a small set of weighted signals,
 * and every candidate carries the exact reasons that fired. None of this claims
 * to understand meaning; it flags patterns a human editor still decides on.
 *
 * The functions are pure and operate on validated schema values, so they are
 * fully unit-testable offline with no process or media.
 */

import type {
  TranscriptValue,
  SegmentValue,
  WordValue,
  MarkValue,
  TakeGroupValue,
  CandidateHookValue,
  AudioFactsValue,
} from "./schemas.js";

/** Single-token fillers. Matched case-insensitively after stripping punctuation. */
export const FILLER_TOKENS: readonly string[] = [
  "um", "umm", "uh", "uhh", "er", "err", "ah", "ahh", "hmm", "mm", "mhm", "eh",
];

/** Multi-word filler phrases. Matched over consecutive normalized word tokens. */
export const FILLER_PHRASES: readonly string[][] = [
  ["you", "know"],
  ["i", "mean"],
  ["sort", "of"],
  ["kind", "of"],
];

/**
 * Off-camera crew prompts and restart cues. Matched as a normalized substring of a
 * segment's text. Deliberately conservative: these are strong "this is not part of
 * the take" signals, not every hesitation.
 */
export const RESTART_PHRASES: readonly string[] = [
  "take two", "take three", "take four", "one more time", "from the top",
  "let's go again", "lets go again", "start again", "let me restart", "let me start over",
  "can we redo", "can we cut", "rolling", "and action", "reset", "sorry let me",
  "from the beginning", "do that again",
];

export function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9']/g, "");
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(text: string): string[] {
  return normalizeText(text).split(" ").filter(Boolean);
}

/** Jaccard similarity over the token sets of two texts. 0..1. */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = new Set(tokens(a));
  const sb = new Set(tokens(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Flag filler tokens and phrases as marks, each with the matched token as its reason. */
export function detectFillers(words: readonly WordValue[]): MarkValue[] {
  const marks: MarkValue[] = [];
  const norm = words.map((w) => normalizeToken(w.text));

  for (let i = 0; i < words.length; i++) {
    if (FILLER_TOKENS.includes(norm[i]!)) {
      marks.push({
        kind: "filler",
        startSeconds: words[i]!.startSeconds,
        endSeconds: words[i]!.endSeconds,
        text: words[i]!.text,
        reason: `filler word: ${norm[i]}`,
      });
    }
  }

  for (const phrase of FILLER_PHRASES) {
    for (let i = 0; i + phrase.length <= words.length; i++) {
      let hit = true;
      for (let k = 0; k < phrase.length; k++) {
        if (norm[i + k] !== phrase[k]) { hit = false; break; }
      }
      if (hit) {
        marks.push({
          kind: "filler",
          startSeconds: words[i]!.startSeconds,
          endSeconds: words[i + phrase.length - 1]!.endSeconds,
          text: phrase.join(" "),
          reason: `filler phrase: ${phrase.join(" ")}`,
        });
      }
    }
  }

  return marks.sort((a, b) => a.startSeconds - b.startSeconds);
}

/** Flag segments whose text contains a crew-prompt or restart cue. */
export function detectCrewPrompts(segments: readonly SegmentValue[]): MarkValue[] {
  const marks: MarkValue[] = [];
  for (const seg of segments) {
    const text = normalizeText(seg.text);
    for (const phrase of RESTART_PHRASES) {
      if (text.includes(phrase)) {
        marks.push({
          kind: "crew-prompt",
          startSeconds: seg.startSeconds,
          endSeconds: seg.endSeconds,
          text: seg.text,
          reason: `restart/crew cue: "${phrase}"`,
        });
        break;
      }
    }
  }
  return marks;
}

/** Convert acoustic silence regions into silence marks. */
export function silenceMarks(audio: AudioFactsValue): MarkValue[] {
  return audio.silences.map((s) => ({
    kind: "silence" as const,
    startSeconds: s.startSeconds,
    endSeconds: s.endSeconds,
    reason: `dead air >= ${audio.minSilenceSeconds}s below ${audio.silenceThresholdDb}dB`,
  }));
}

export interface TakeGroupOptions {
  /** Adjacent segments at or above this Jaccard similarity are grouped. Default 0.6. */
  similarityThreshold?: number;
}

/**
 * Group consecutive segments that are repeated attempts at the same line. Two
 * adjacent segments join when their token-set similarity clears the threshold.
 * The fullest take (most words) is offered as the preferred one; a human still
 * decides. Only runs of two or more segments are emitted.
 */
export function groupRepeatedTakes(
  segments: readonly SegmentValue[],
  opts: TakeGroupOptions = {},
): TakeGroupValue[] {
  const threshold = opts.similarityThreshold ?? 0.6;
  const groups: TakeGroupValue[] = [];
  let current: SegmentValue[] = [];
  let groupIdx = 0;

  const flush = () => {
    if (current.length >= 2) {
      const preferred = [...current].sort((a, b) => tokens(b.text).length - tokens(a.text).length)[0]!;
      groups.push({
        id: `take${groupIdx++}`,
        segmentIds: current.map((s) => s.id),
        preferredSegmentId: preferred.id,
        reason: `repeated take: adjacent segments >= ${threshold} Jaccard similarity`,
      });
    }
    current = [];
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (current.length === 0) {
      current = [seg];
      continue;
    }
    const prev = current[current.length - 1]!;
    if (jaccardSimilarity(prev.text, seg.text) >= threshold) {
      current.push(seg);
    } else {
      flush();
      current = [seg];
    }
  }
  flush();
  return groups;
}

const QUESTION_OPENERS = ["how", "why", "what", "when", "who", "where", "which"];
const STRONG_OPENERS = ["stop", "if you", "here's", "heres", "the truth", "nobody", "most people", "everyone"];

export interface HookOptions {
  /** How many candidates to return. Default 5. */
  max?: number;
  /** Only consider segments starting before this time. Default 20s. */
  windowSeconds?: number;
}

/**
 * Score early segments as candidate hooks from timed words. Signals are additive
 * and weighted; every candidate lists exactly which signals fired. This is a
 * ranking aid, not a claim that a segment is a good hook.
 */
export function scoreCandidateHooks(transcript: TranscriptValue, opts: HookOptions = {}): CandidateHookValue[] {
  const max = opts.max ?? 5;
  const windowSeconds = opts.windowSeconds ?? 20;
  const candidates: CandidateHookValue[] = [];

  for (const seg of transcript.segments) {
    if (seg.startSeconds > windowSeconds) continue;
    const text = normalizeText(seg.text);
    const wordCount = tokens(seg.text).length;
    if (wordCount === 0) continue;

    const reasons: string[] = [];
    let score = 0;

    const earliness = Math.max(0, 1 - seg.startSeconds / windowSeconds);
    if (earliness > 0) { score += 0.35 * earliness; reasons.push(`early-start(${seg.startSeconds.toFixed(1)}s)`); }

    if (QUESTION_OPENERS.some((q) => text.startsWith(q + " ")) || text.includes("?")) {
      score += 0.2; reasons.push("question-frame");
    }
    if (STRONG_OPENERS.some((s) => text.startsWith(s))) { score += 0.2; reasons.push("strong-opener"); }
    if (/\d/.test(text)) { score += 0.15; reasons.push("has-number"); }
    if (wordCount >= 4 && wordCount <= 16) { score += 0.15; reasons.push(`tight-length(${wordCount}w)`); }

    const firstTok = normalizeToken(seg.words[0]?.text ?? "");
    if (FILLER_TOKENS.includes(firstTok)) { score -= 0.15; reasons.push("filler-open-penalty"); }

    score = Math.max(0, Math.min(1, score));
    if (score > 0) {
      candidates.push({
        startSeconds: seg.startSeconds,
        endSeconds: seg.endSeconds,
        text: seg.text,
        score: Math.round(score * 1000) / 1000,
        reasons,
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, max);
}

export interface EditorialAnalysis {
  marks: MarkValue[];
  takes: TakeGroupValue[];
  candidateHooks: CandidateHookValue[];
}

/** Full deterministic editorial pass: fillers + crew prompts + silence, takes, hooks. */
export function analyzeEditorial(
  transcript: TranscriptValue,
  audio: AudioFactsValue,
  opts: { take?: TakeGroupOptions; hook?: HookOptions } = {},
): EditorialAnalysis {
  const marks = [
    ...detectFillers(transcript.words),
    ...detectCrewPrompts(transcript.segments),
    ...silenceMarks(audio),
  ].sort((a, b) => a.startSeconds - b.startSeconds);

  return {
    marks,
    takes: groupRepeatedTakes(transcript.segments, opts.take),
    candidateHooks: scoreCandidateHooks(transcript, opts.hook),
  };
}
