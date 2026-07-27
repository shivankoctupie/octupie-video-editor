/**
 * Caption grouping and retiming.
 *
 * Builds one-to-three-word caption cards from word-timed ASR tokens, breaking on
 * phrase boundaries (terminal punctuation and audible gaps) rather than filling
 * a fixed word count. Card timing comes from real word timestamps: a card starts
 * at its first word onset and holds through the final word tail. Invalid word
 * timings are rejected rather than silently smoothed.
 */

export interface WordToken {
  word: string;
  start: number;
  end: number;
}

export interface CaptionCard {
  text: string;
  start: number;
  end: number;
}

export interface GroupOptions {
  /** Hard word cap per card. Default 3; only exceed with allowExtended. */
  maxWords?: number;
  /** Preset opt-in to cards longer than three words. */
  allowExtended?: boolean;
  /** Gap (seconds) that counts as a phrase boundary. */
  gapBoundary?: number;
  /** Minimum hold; shorter cards are merged when the word cap allows. */
  minHold?: number;
}

const TERMINAL = /[.!?,;:]$/;

function validateTokens(tokens: readonly WordToken[]): void {
  let prevEnd = -Infinity;
  tokens.forEach((t, i) => {
    if (typeof t.start !== "number" || typeof t.end !== "number") {
      throw new Error(`word token ${i} has non-numeric timing`);
    }
    if (t.start < 0 || t.end < 0) {
      throw new Error(`word token ${i} ("${t.word}") has negative timing`);
    }
    if (t.end <= t.start) {
      throw new Error(`word token ${i} ("${t.word}") ends at or before it starts`);
    }
    if (t.start < prevEnd - 1e-6) {
      throw new Error(`word token ${i} ("${t.word}") starts before the previous word ended`);
    }
    prevEnd = t.end;
  });
}

export function groupWordsIntoCards(
  tokens: readonly WordToken[],
  options: GroupOptions = {},
): CaptionCard[] {
  validateTokens(tokens);
  const requested = options.maxWords ?? 3;
  const maxWords = options.allowExtended ? requested : Math.min(requested, 3);
  const gapBoundary = options.gapBoundary ?? 0.6;
  const minHold = options.minHold ?? 0.35;

  const groups: WordToken[][] = [];
  let current: WordToken[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    current.push(token);
    const atCap = current.length >= maxWords;
    const punctuationBreak = TERMINAL.test(token.word.trim());
    const next = tokens[i + 1];
    const gapBreak = next ? next.start - token.end >= gapBoundary : false;
    if (atCap || punctuationBreak || gapBreak || !next) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  let cards = groups.map(toCard);
  cards = mergeShortCards(cards, groups, maxWords, minHold);
  return cards;
}

function toCard(group: WordToken[]): CaptionCard {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  return {
    text: group.map((g) => g.word).join(" "),
    start: first.start,
    end: last.end, // preserve the natural final word tail
  };
}

/** Merge a too-short card into a neighbor when the combined word count fits. */
function mergeShortCards(
  cards: CaptionCard[],
  groups: WordToken[][],
  maxWords: number,
  minHold: number,
): CaptionCard[] {
  const wordCounts = groups.map((g) => g.length);
  const out: CaptionCard[] = [];
  const counts: number[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    const count = wordCounts[i]!;
    const holds = card.end - card.start >= minHold;
    const prev = out[out.length - 1];
    const prevCount = counts[counts.length - 1];
    if (!holds && prev && prevCount !== undefined && prevCount + count <= maxWords) {
      out[out.length - 1] = {
        text: `${prev.text} ${card.text}`,
        start: prev.start,
        end: card.end,
      };
      counts[counts.length - 1] = prevCount + count;
    } else {
      out.push(card);
      counts.push(count);
    }
  }
  return out;
}

/** Shift every card by a delta (seconds), clamping starts at zero. */
export function shiftCards(cards: readonly CaptionCard[], deltaSeconds: number): CaptionCard[] {
  return cards.map((c) => ({
    text: c.text,
    start: Math.max(0, c.start + deltaSeconds),
    end: Math.max(0, c.end + deltaSeconds),
  }));
}

/** Retime cards onto a new dialogue base by scaling then shifting. */
export function retimeCards(
  cards: readonly CaptionCard[],
  opts: { scale?: number; offset?: number } = {},
): CaptionCard[] {
  const scale = opts.scale ?? 1;
  const offset = opts.offset ?? 0;
  return cards.map((c) => ({
    text: c.text,
    start: Math.max(0, c.start * scale + offset),
    end: Math.max(0, c.end * scale + offset),
  }));
}
