import { describe, it, expect } from "vitest";
import {
  groupWordsIntoCards,
  shiftCards,
  type WordToken,
} from "../src/captions/grouping.js";

const words: WordToken[] = [
  { word: "We", start: 0.0, end: 0.2 },
  { word: "built", start: 0.2, end: 0.5 },
  { word: "Octupie", start: 0.5, end: 1.0 },
  // phrase boundary via punctuation
  { word: "fast.", start: 1.0, end: 1.3 },
  { word: "It", start: 1.9, end: 2.1 }, // large gap before -> new phrase
  { word: "works", start: 2.1, end: 2.5 },
];

describe("groupWordsIntoCards", () => {
  it("keeps one to three words per card", () => {
    const cards = groupWordsIntoCards(words);
    for (const card of cards) {
      const count = card.text.trim().split(/\s+/).length;
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it("breaks on punctuation phrase boundaries", () => {
    const cards = groupWordsIntoCards(words);
    // "fast." must end a card, so the next card starts with "It".
    const withFast = cards.find((c) => c.text.includes("fast"));
    expect(withFast).toBeDefined();
    expect(withFast!.text.trim().endsWith("fast.")).toBe(true);
  });

  it("preserves the final word tail as card end", () => {
    const cards = groupWordsIntoCards(words);
    const last = cards[cards.length - 1]!;
    expect(last.end).toBeCloseTo(2.5, 5);
  });

  it("rejects invalid word timings", () => {
    expect(() => groupWordsIntoCards([{ word: "bad", start: 1.0, end: 0.5 }])).toThrow();
    expect(() => groupWordsIntoCards([{ word: "neg", start: -1, end: 0.5 }])).toThrow();
  });

  it("respects an extended maxWords when the preset allows it", () => {
    const cards = groupWordsIntoCards(words, { maxWords: 5, allowExtended: true });
    expect(cards.some((c) => c.text.trim().split(/\s+/).length > 3)).toBe(true);
  });
});

describe("shiftCards", () => {
  it("shifts all card times by an offset and never goes negative", () => {
    const cards = groupWordsIntoCards(words);
    const shifted = shiftCards(cards, 1.0);
    expect(shifted[0]!.start).toBeCloseTo(cards[0]!.start + 1.0, 5);
    const clamped = shiftCards(cards, -100);
    expect(clamped.every((c) => c.start >= 0)).toBe(true);
  });
});
