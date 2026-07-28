import { describe, expect, it } from "vitest";
import { isCaptionCardActive } from "../src/render/remotion/components.js";

describe("caption card timing", () => {
  it("never renders outgoing and incoming cards together at an exact word boundary", () => {
    const outgoing = { text: "One clear", start: 0, end: 0.6 };
    const incoming = { text: "promise", start: 0.6, end: 1.2 };
    const boundaryFrame = 18;

    expect([
      isCaptionCardActive(boundaryFrame, outgoing, 30),
      isCaptionCardActive(boundaryFrame, incoming, 30),
    ].filter(Boolean)).toHaveLength(1);
  });

  it("uses half-open caption ranges and keeps the first frame visible", () => {
    const card = { text: "real proof", start: 1.2, end: 2.8 };
    expect(isCaptionCardActive(35, card, 30)).toBe(false);
    expect(isCaptionCardActive(36, card, 30)).toBe(true);
    expect(isCaptionCardActive(83, card, 30)).toBe(true);
    expect(isCaptionCardActive(84, card, 30)).toBe(false);
  });
});
