# Octupie Video Editor

## Goal
Build a portable, deterministic AI-assisted video editing engine that can run outside Shivank's current workspaces and later become a service inside Octupie and Dowd.

## Product boundary
- Language models create validated edit plans and editorial decisions.
- Deterministic code performs probing, timing, captions, rendering, audio assembly, and QA.
- The edit-plan JSON is the stable contract between planner and renderer.
- This repository must work without access to private local workspaces or user-specific absolute paths.

## Required commands
- `npm test`: all unit tests.
- `npm run typecheck`: TypeScript validation.
- `npm run build`: production build.
- `npm run demo`: generate and render a synthetic demo, then QA the exact MP4.
- `npm run doctor`: verify Node, FFmpeg, FFprobe, and runtime requirements.

## Engineering rules
- Use strict TypeScript and portable relative paths.
- Follow test-driven development. Add a failing behavior test before production code.
- Never invoke shell commands with untrusted string interpolation. Use argument arrays.
- Validate all JSON and all file paths before use.
- Never overwrite source media.
- Keep media, paid assets, credentials, model outputs, and final renders out of Git.
- Strip inherited metadata from deliverables.
- Preserve source-quality masters. Messaging copies are separate outputs.
- Run full decode, stream probe, frame-count, black-frame, loudness, metadata, and checksum checks on the exact delivered master.

## Editorial rules
- Real claim-specific proof beats generic generated visuals.
- Captions use one to three words per card unless the chosen format explicitly overrides it.
- Cuts land on phrase boundaries and preserve natural word tails.
- B-roll must not cover the speaker in YC series work.
- Octupie uses Geist, paper `#F7F5F0`, ink `#111111`, and selective blue `#014CE3`.
- SFX must have a stated editorial role. Do not stack whoosh, riser, heavy impact, and tick by default.
- `impact_ultra_serious_48k_pcm24.wav` and derivatives are blacklisted.

## Repository policy
- This is proprietary and private. Package metadata uses `UNLICENSED`.
- Do not copy private footage, client media, third-party reference media, paid packs, or source workspace output files.
- Reusable ideas should be implemented as original code, schemas, tests, presets, or internal skills.
- Third-party assets are fetched only through explicit download scripts with source and license manifests.
