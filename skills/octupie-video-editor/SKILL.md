---
name: octupie-video-editor
description: Plan and produce founder and product videos with the portable Octupie Video Editor engine. Use when authoring an edit plan, choosing a preset (Octupie product launch, LinkedIn landscape reel, YC Y-series vertical, neutral founder reel), designing an SFX cue pass, grouping captions, rendering with Remotion, or running final-master QA. Language models write validated edit plans; deterministic code renders, assembles audio, and validates the exact master.
---

# Octupie Video Editor

A standalone, deterministic engine. The language model produces a validated edit plan; the code performs timing, captions, rendering, audio assembly, and QA. The edit-plan JSON is the stable contract between planner and renderer. The engine runs without any private workspace.

## When to use

- Author or repair an edit plan against the schema in `schema/edit-plan.schema.json`.
- Pick a preset that matches the deliverable and platform.
- Design an SFX cue pass and pass the gate before building audio.
- Group word-timed ASR into one-to-three-word caption cards.
- Render a `PremiumProductFilm` (16:9) or `FounderSocialReel` (9:16) and QA the master.

## The contract

Every plan validates before it renders. The schema rejects negative times, out-of-range or overlapping scenes, unknown scene types, caption cards over three words unless the preset extends them, unsafe paths, blacklisted SFX, and the default whoosh plus riser plus impact stack. Run `octupie-video-editor validate <plan.json>` and fix every error before rendering.

## Presets

- `octupie-product-launch`: 16:9, product-led, Geist, paper `#F7F5F0`, ink `#111111`, blue `#014CE3`. Elegant, controlled motion with zero overshoot.
- `linkedin-landscape-reel`: 9:16 canvas, persistent hook above a landscape media slot, white captions with selective orange emphasis.
- `yc-series-vertical`: stricter continuity, speaker always visible, proof in the upper region, no automatic SFX.
- `neutral-founder-reel`: restrained default, one clear idea per screen. This is the demo and starter default.

## SFX cue authoring

Before building audio, state one distinct editorial role per cue, then run the gate. Cues are story and motion, not decoration. Reserve hero stacks for the single largest payoff. `impact_ultra_serious_48k_pcm24.wav` and its derivatives are blacklisted. Never stack whoosh, riser, impact, and tick by default. See the full matrix, intensity hierarchy, whoosh-hit anatomy, and audition protocol in `../shivank-social-video-editing/references/sfx-selection-and-placement.md` and `../shivank-social-video-editing/references/dialogue-first-sfx-grammar.md`.

## Source analysis

Run `npm run agent -- analyze <relative-clip>` to inspect a contained source clip before planning. The local pipeline uses Faster Whisper for word timestamps, FFmpeg for silence and audio facts, and optional OpenCV frame measurements. It writes validated analysis JSON, transcript JSON, SRT, and VTT under `output/analysis/`. Treat filler, crew-prompt, repeated-take, and hook results as auditable heuristics. They are not semantic certainty. Named model downloads require the explicit `--allow-model-download` flag.

## Captions and phrase timing

One line, one to three words per card. Group by meaning and edit boundaries, never bridge unrelated phrases to fill three words. Build timing from real word timestamps: start at the first word onset, hold through the final word tail. Regroup any card shorter than about 0.35 seconds. Caption details: `../shivank-social-video-editing/SKILL.md` (Captions and terminology).

## Visual cadence, proof, and brand

Classify each spoken section (hook, proof, explanation, breather, payoff) before assigning visuals. Real claim-specific proof beats generic generated visuals. In YC work, B-roll must not cover the speaker. The exact-reference clean-room boundary, Octupie brand system, product-launch grammar, and visual cadence gate live in `../shivank-social-video-editing/references/` (`exact-reference-reconstruction.md`, `octupie-motion-graphics-brand-system.md`, `octupie-product-launch-teasers.md`, `visual-cadence-and-mockup-gates.md`).

## Final QA

QA runs against the exact delivered bytes and writes one JSON report bound to the master SHA-256: stream presence, resolution, fps, duration tolerance, full decode, decoded frame count, black-frame scan, EBU R128 loudness and true peak, metadata scan (no GPS or camera tags), and a contact sheet. Writing a validator is not passing QA; the report must show `pass: true`. Run `octupie-video-editor render <plan.json>` or `octupie-video-editor qa <master.mp4> --plan <plan.json>`.

## References

- Engine architecture and the planner/renderer split: `../../ARCHITECTURE.md`
- Asset and licensing policy: `../../ASSET_POLICY.md`
- How learned editing rules map into code: `../../STYLE_LEARNING.md`
- The full editorial grammar: `../shivank-social-video-editing/SKILL.md`
