# Style learning

How learned editing taste becomes portable, testable code.

## The principle

Editing feedback is evidence about why a choice works, not a template to copy. Transferable principles (hook construction, phrase timing, proof selection, sound placement, payoff structure) are encoded as schema rules, presets, gate logic, and tests. Series-specific taste stays in the presets and the skill references; it does not leak into the shared engine.

## Where each kind of rule lives

- Structural rules that must never be violated become schema refinements. Example: captions are one to three words unless the preset extends them; scenes cannot overlap or exceed the duration. See `src/schema/editPlan.ts`.
- Sound-design judgment becomes the SFX gate. Roles, families, intensities, the blacklist, near-time repetition, dense stacks, the default trailer stack, and hero spacing are all deterministic checks in `src/sfx/gates.ts`.
- Caption craft becomes the grouping algorithm: break on terminal punctuation and audible gaps, hold through the final word tail, regroup cards that are too short. See `src/captions/grouping.ts`.
- Series identity becomes a preset: typography, color, safe zones, caption rules, proof behavior, motion signature, and audio targets, with no machine paths. See `src/presets/`.
- Motion taste becomes component behavior: a single signature easing, reserved layout before reveal, intentional frame-zero content, one hero action at a time. See `src/render/remotion/components.tsx`.

## Corrections that are now enforced in code

- The `impact_ultra_serious_48k_pcm24.wav` rejection around 0:33 in a prior edit is a blocking gate, including renamed derivatives. A preserved regression fixture (`tests/fixtures/rejected-33s-stack.json`) must always fail validation.
- The default whoosh plus riser plus impact stack near one time is a blocking error, not a warning.
- One-to-three-word captions are enforced by the schema; extended cards require an explicit preset opt-in.
- Frame zero must carry content; the renderer has no blank fade wrapper.
- Deliverables strip metadata and QA asserts no location tags, so inherited GPS never ships.

## The learning loop

When a new correction lands:

1. Classify it: stable preference, series-specific rule, or one-video fix.
2. Encode a stable preference where it belongs: schema, gate, preset, or component.
3. Add a failing test first, then make it pass. For a rejection, add a fixture that must always fail.
4. Keep series taste in the preset or the skill references, not in the shared engine.
5. Regenerate the JSON Schema if the contract changed.

The full editorial grammar and its rationale live in `skills/shivank-social-video-editing/`. This engine is the subset that is safe to run deterministically for any founder or product video.
