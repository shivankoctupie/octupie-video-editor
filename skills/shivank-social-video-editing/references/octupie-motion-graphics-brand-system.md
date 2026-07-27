# Octupie motion-graphics brand system

Use this reference when a Reel, explainer, title sequence, proof card, or end card must look native to Octupie rather than merely carrying the logo.

## Source-of-truth order

1. Audit the live `www.octupie.com` page at the time of the edit.
2. Inspect the local Octupie website tokens, font declarations, and official logo files when available.
3. Use this document as the established baseline, not as a substitute for a current audit.
4. Treat an external reference as motion and information-structure guidance. Do not inherit its palette, type personality, corner language, or footer treatment by default.

## Established baseline

| Role | Treatment |
|---|---|
| Paper | `#F7F5F0` |
| Secondary paper | `#EDEAE3` |
| Ink | `#111111` |
| Muted ink | `#6B6965` |
| Accent | `#014CE3`, used selectively |
| Sans | Geist |
| Micro labels | Geist Mono or tracked Geist |
| Rules | Thin neutral hairlines |
| Structure | Generous whitespace and subtle vertical grid lines |
| Cards and labels | Square or nearly square, thin borders |
| Emphasis | Blue italic Geist, blue blocks, or hard black offset shadows |
| Wordmark | Official icon plus lower-case `octupie` |

## Adaptation recipe

1. Preserve the approved script, phrase timing, scene order, and narration unless the user asks for editorial changes.
2. Replace borrowed visual skin completely:
   - remove unrelated accent colors;
   - remove decorative serif identity;
   - remove rounded pills, soft cards, and generic gradients;
   - replace them with Geist, paper and ink, restrained blue, hairlines, grid structure, square labels, and hard offset shadows.
3. Keep blue purposeful. It should mark the hook, a key term, an active state, or the payoff. Do not flood every paper scene with blue.
4. Use black sections sparingly for hierarchy or the final brand card.
5. Recolor original illustrations to the Octupie blue and ink system. Do not recolor third-party logos that need their real brand colors.
6. For Octupie motion-graphics remakes, place the official icon plus lower-case wordmark in the top-right by default. Use a measured inset and keep it clear of hooks, headings, tables, and platform UI. Verify contrast on both paper and blue scenes. Do not use a bottom-left logo treatment unless the user requests it, and do not add `www.octupie.com` in the opposite corner.
7. Do not add top-corner process labels such as `OCTUPIE / BRAND SYSTEM`, `LOGO TYPE`, or similar production annotations. The top-right logo is branding, not a license to add extra system text.
8. Preserve the final spoken message as the ending. Hide the corner logo during the final payoff by default. Do not replace the payoff with an Octupie logo card, website-style footer card, or extra product line unless requested.

## Mixed-style text spacing

Inline emphasis is a layout problem, especially when Geist italic, different weights, blue emphasis, or negative tracking appear inside one sentence.

- Do not rely on JSX spaces around styled spans.
- Wrap sentence parts in an `inline-flex` or flex container with explicit numeric `gap`.
- Use `flexWrap: "wrap"` for longer multi-part lines.
- Keep logical chunks together, for example `about the`, `Story`, `and`, `Meaning`, `behind you.`
- Inspect exact rendered frames for every mixed-style sentence. Source markup that looks correct can still render as `isauselessshape` or collapse `StoryandMeaning` at phone scale.
- After a spacing fix, verify both the isolated exact frame and a half-second final-composite contact sheet.

## Motion language

- Use direct phrase-boundary state changes and short, clean reveals.
- A website-like reveal starts about 6 px below and settles with restrained easing.
- Avoid blur-heavy entries once the edit is being translated into the Octupie system.
- Hard shadows should land as structural UI emphasis, not float behind every element.
- Preserve the reference's useful rhythm without cloning its decorative identity.
- In a conditional Remotion timeline, make each branch boundary equal the child reveal's `from` time. A branch that begins at `7.45s` while its reveal begins at `7.72s` produces an unintended blank flash even though both components are individually valid.
- Inspect every transition boundary in the final composite, not only scene midpoints. Sample the first frame after each branch switch and include a half-second contact sheet.
- For progressively filled tables, calendars, card stacks, or comparison lists, inspect both a mid-fill frame and the fully populated final state. A single early sample can make a correct animation look incomplete, while a single late sample can hide a broken progression.
- In `bad phrase → better phrase` comparison graphics, reveal the source phrase first, then reveal the Octupie-blue replacement card. Only mute and strike the source phrase after its replacement appears. Keep row positions stable as the list accumulates so the viewer can compare without reorienting.
- Treat visible reference copy as evidence when ASR is uncertain. Reconcile narration, exact frames, and semantic pairing before persisting the script. For example, a visually confirmed `Unique → Exceptional` pair should override an implausible ASR result such as `you need → exception`.
- For final audio remuxes, omit `-shortest` when it truncates rendered video frames. Probe decoded frame count after muxing and preserve the full intended visual hold even when the audio stream ends a few milliseconds earlier.

## Phone-scale minimums for 1080 x 1920

- Central phrase text: usually at least 52 px.
- Compact multi-state captions: usually at least 56 px when space allows.
- Micro labels: around 24 px. A 14 px label on the 1080 master becomes too small on a phone.
- Footer wordmark: around 28 px with an icon around 36 px.
- Inspect long phrases for wrapping after increasing type. Never assume a global size increase is safe.

These are starting points, not fixed coordinates. Verify the actual rendered pixels.

## Input and revision discipline

- When the user reattaches a prior render, compare its checksum with the known output before rebuilding. This confirms whether the request is a visual revision of the same timeline or a new source.
- Preserve the attached media unchanged.
- If timing and audio are approved, render the revised visual stream and remux the approved audio without re-encoding it when compatible.
- Reusing narration, music, or third-party graphics still requires the user's authorization or appropriate rights.

## QA gates

1. Confirm the full reference palette has been translated, not just the logo.
2. Inspect exact frames for the hook, hierarchy diagram, graphic examples, color system, illustration, key conceptual terms, payoff, and end card.
3. Generate a half-second contact sheet. One-second sampling can miss a short stale color or state.
4. Verify no unintended legacy accent survives. Real colors inside third-party logos are not a failure.
5. Confirm Geist loaded rather than falling back.
6. Confirm no unrequested top-corner labels, bottom-corner URL, or extra branded end card remains.
7. Inspect every mixed-style phrase at an exact frame for collisions, missing gaps, and awkward wrapping.
8. Validate frame count, dimensions, frame rate, audio stream, loudness, metadata stripping, full decode, and final checksum.
9. Tell the user what to eyeball inside Instagram, especially phrase spacing and interface cropping.
