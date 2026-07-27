# Octupie Video Editor

A portable, deterministic AI-assisted video editing engine. Language models produce a validated edit plan; deterministic code performs probing, timing, captions, rendering, audio assembly, and QA. The edit-plan JSON is the stable contract between the planner and the renderer. The engine runs without access to any private workspace.

Proprietary and private. See `package.json` (`UNLICENSED`).

## Requirements

- Node.js 20 or newer.
- FFmpeg and FFprobe on `PATH` (or set `OVE_FFMPEG_PATH` and `OVE_FFPROBE_PATH`).
- On first render, Remotion downloads a headless browser shell automatically.

## Quick start

```bash
npm install
npm run doctor          # verify Node, FFmpeg, FFprobe, Remotion
npm run demo            # render a short synthetic reel and QA the exact master
```

The demo writes a playable MP4 with audio, plus a QA report bound to the master's SHA-256, under `output/` (gitignored).

## CLI

The binary is `octupie-video-editor` (run `npm run build` first, or use `npm run cli -- <command>` in development).

| Command | What it does |
|---|---|
| `doctor` | Verify Node, FFmpeg, FFprobe, and Remotion. |
| `init [--preset id] [--out file]` | Write a valid starter edit plan. |
| `validate <plan.json>` | Validate an edit plan against the schema. |
| `render <plan.json>` | Render, assemble audio, mux, and QA a final master. |
| `qa <master.mp4> --plan <plan.json>` | QA an existing master against a plan. |
| `demo` | Generate and render a synthetic demo, then QA it. |

Example:

```bash
npm run build
node dist/cli.js init --preset octupie-product-launch --out my-plan.json
node dist/cli.js validate my-plan.json
node dist/cli.js render my-plan.json
```

## Presets

- `octupie-product-launch` (16:9, product-led premium film)
- `linkedin-landscape-reel` (9:16 canvas, persistent hook, landscape media slot)
- `yc-series-vertical` (9:16, strict continuity, speaker always visible)
- `neutral-founder-reel` (9:16, restrained default; used by the demo)

## The edit plan

A plan is JSON validated by a strict Zod schema (`src/schema/editPlan.ts`) with a committed JSON Schema at `schema/edit-plan.schema.json`. It describes project format, dimensions, fps, duration, brand, scenes, caption cards, optional source clips, audio, SFX cues, and output settings. The validator rejects negative times, out-of-range or overlapping scenes, unknown scene types, caption cards over three words unless the preset extends them, unsafe paths, blacklisted SFX, and the default whoosh plus riser plus impact stack.

## Real media contract

Local media lives under one asset root. The default is `assets/` under the current project directory. Set `OVE_ASSET_ROOT` to use a different directory. Every path inside a plan remains relative to that root. Absolute paths, drive letters, UNC paths, home expansion, and parent traversal are rejected. Missing files fail before rendering begins.

- Add footage to `sourceClips`, then set a scene's `sourceClipId`. Optional `sourceIn`, `mute`, and `fit` fields control playback.
- A scene-level `broll` path can supply a video or still without declaring a reusable clip ID.
- `dialoguePath` is a full-timeline dialogue track.
- `music.path` is looped under the full timeline and requires license and source metadata.
- Each SFX cue references a file and places it at `time` seconds.

Remotion reads footage and stills from this root. FFmpeg reads dialogue, music, and SFX from the same root, mixes them to stereo 48 kHz, normalizes the final timeline, and muxes without `-shortest`, so a short audio source cannot remove the approved visual tail.

## Scripts

- `npm test` runs the full suite, including the real render and QA integration.
- `npm run typecheck` runs strict TypeScript validation.
- `npm run build` compiles the Node code to `dist/`.
- `npm run schema:gen` regenerates the committed JSON Schema from the Zod source.
- `npm run dash:sweep` fails on any em or en dash in committed text.
- `npm run sfx:fetch -- --manifest <file>` runs the rights-safe SFX mechanism (dry run by default).

## Documentation

- `ARCHITECTURE.md`: the planner and renderer split, storage and job boundaries, security.
- `PRODUCTIZATION.md`: integrating the engine into Octupie and Dowd.
- `ASSET_POLICY.md`: media, licensing, and what stays out of Git.
- `STYLE_LEARNING.md`: how learned editing rules become code, schema, and tests.
- `WORKSPACE_AUDIT.md`: what was reused from internal workspaces and what was excluded.
- `CONTRIBUTING.md`: test-driven workflow and conventions.
- `skills/octupie-video-editor/SKILL.md`: the editorial grammar and pointers.
