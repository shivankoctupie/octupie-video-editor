# Architecture

## Product boundary

The engine has two layers separated by a stable data contract.

1. Planning layer (language models). Reads a brief, chooses a preset, and emits an edit plan. This layer makes editorial decisions: hook, scene order, caption grouping, proof selection, SFX intent. It never renders.
2. Execution layer (deterministic code). Validates the plan, renders frames, assembles audio, muxes the master, and runs QA. It makes no editorial choices; it executes the plan exactly and proves the result.

The edit-plan JSON is the contract. Anything the renderer needs is in the plan, and anything the planner decides is expressed as plan data. This lets the two layers evolve independently and lets a plan be reviewed, diffed, and replayed.

```
brief --> [planner: LLM] --> edit-plan.json --> [validate] --> [render] --> [audio] --> [mux] --> master.mp4 --> [QA] --> report.json
```

## Modules

- `src/schema/editPlan.ts`: the Zod contract and cross-field refinements. `src/schema/generate.ts` emits the committed JSON Schema.
- `src/presets/`: portable editorial identities (dimensions, typography, color, safe zones, caption rules, proof behavior, motion signature, audio targets). No machine paths.
- `src/captions/grouping.ts`: word-timed ASR into one-to-three-word cards on phrase boundaries, with retiming helpers.
- `src/sfx/gates.ts`: the cue gate engine (role, family, intensity, blacklist, repetition, dense stack, trailer stack, hero spacing). `validator.ts` loads cue sheets; `manifest.ts` is the rights-safe acquisition mechanism.
- `src/render/`: the data-driven Remotion bridge. `remotion/` holds original reusable components and the two compositions. `index.ts` bundles and renders a silent master.
- `src/ffmpeg/`: deterministic spawn wrappers (`spawn.ts`), probing (`ffprobe.ts`), real and procedural audio assembly plus mux (`audio.ts`), and final-master QA (`qa.ts`).
- `src/pipeline.ts`: orchestrates render, audio, mux, and QA.
- `src/cli.ts`: the `octupie-video-editor` command.

## Planner and renderer separation

The renderer is pure with respect to the plan: given the same plan and the same code, it produces the same frames. Remotion motion is frame-driven (`useCurrentFrame`), uses a single signature easing, and reserves layout before revealing text so centered copy does not reflow. Frame zero carries intentional content; there is no blank fade wrapper.

The planner is free to be probabilistic. Its only obligation is to emit a plan that validates. A plan that fails validation never reaches the renderer.

## Storage and job boundaries

- Inputs (source clips, supplied assets) are referenced by portable relative paths and are never overwritten.
- Intermediates (`*.silent.mp4`, `*.bed.wav`) and final masters live under the output directory (`OVE_OUTPUT_DIR`, default `output/`), which is gitignored.
- A render is one job: bundle once, render, assemble audio, mux, QA. The QA report is written next to the master and is bound to its SHA-256, so a report can never be mistaken for a different master.
- The engine holds no database. A host service (see `PRODUCTIZATION.md`) owns job queues, storage, and retention; the engine is a pure function from plan to master plus report.

## Audio assembly

Audio is assembled deterministically by FFmpeg. A plan may provide a full-timeline dialogue track, a licensed looping music bed, and timed SFX. The mixer keeps dialogue above SFX and music, resamples to stereo 48 kHz, pins the timeline to the visual duration, and normalizes it to the plan's loudness target with `loudnorm` (EBU R128). When no files are declared, the demo uses procedural lavfi sources. The final mux uses an explicit visual duration and never `-shortest`.

## Determinism and security

- No shell interpolation. Every FFmpeg and FFprobe call uses an explicit argument array with `shell: false`.
- Every path in a plan is validated as a portable relative path: no drive letters, absolute roots, UNC, home expansion, or parent-directory escapes.
- All plan JSON is validated before use. Unknown keys are rejected (`.strict()`).
- Deliverables strip inherited metadata (`-map_metadata -1 -map_metadata:s -1`); QA asserts no GPS or location tags survive.
- The engine makes no network calls of its own. Remotion downloads a headless browser on first render; the SFX downloader never fetches without an explicit, license-checked manifest and an operator confirm.

## Final-master QA

QA runs the full battery against the exact delivered bytes and writes one JSON report bound to the master hash: stream presence, resolution, fps, duration tolerance, full decode with no fatal errors, decoded frame count, black-frame scan, EBU R128 integrated loudness and true peak, metadata scan, SHA-256, and a contact sheet. `pass` is true only when every blocking gate passes. Writing a validator is not passing QA; the report must show a pass.
