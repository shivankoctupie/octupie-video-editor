# Octupie Video Editor

A portable, deterministic AI-assisted video editing engine. Language models produce a validated edit plan; deterministic code performs probing, timing, captions, rendering, audio assembly, and QA. The edit-plan JSON is the stable contract between the planner and the renderer. The engine runs without access to any private workspace.

Proprietary and private. See `package.json` (`UNLICENSED`).

## Requirements

- Node.js 20 or newer.
- FFmpeg and FFprobe on `PATH` (or set `OVE_FFMPEG_PATH` and `OVE_FFPROBE_PATH`).
- For local transcription: Python with `faster-whisper`.
- For local frame measurements: Python with OpenCV (`cv2`) and NumPy.
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
| `agent <subcommand>` | Bounded agent: brief to validated plan, optional render, learning. |

Example:

```bash
npm run build
node dist/cli.js init --preset octupie-product-launch --out my-plan.json
node dist/cli.js validate my-plan.json
node dist/cli.js render my-plan.json
```

## Agent (brief to validated plan)

The agent turns a human brief into a validated edit plan, optionally renders it,
and remembers explicit human corrections between runs. It runs standalone: with
no model available, the built-in deterministic provider runs the whole loop
offline; when a `claude` or `codex` CLI is logged in (or a standard API env var
is set), the agent can use it. Models only ever propose data that is validated
against the edit-plan schema; nothing a model returns is executed. Human QA of
the delivered master is still required.

The agent also checks the plan against the brief. It rejects invented media:
source clips, B-roll, dialogue, music, and SFX must come from paths declared in
the brief. Claude runs with tools and session persistence disabled. Codex runs
inside a read-only sandbox.

```bash
# See which providers are available and authenticated
npm run agent -- providers

# Plan from a brief, offline, without rendering
npm run agent -- run brief.json --provider deterministic --no-render

# Save a human correction, scoped to this creator
npm run agent -- feedback --run <runId> --scope creator --creator shivank --rule "No stock footage"

# List and deactivate learned rules
npm run agent -- rules
npm run agent -- deactivate --rule <ruleId>

# Probe optional parity capabilities without claiming unverified gates
npm run agent -- capabilities --probe --json

# Analyze one contained source clip locally
OVE_ASSET_ROOT=/path/to/media npm run agent -- analyze source/clip.mov --language en --allow-model-download --frames --json

# Interpret validated sampled frames with restricted Claude vision
npm run agent -- understand output/analysis/clip/analysis.json --provider claude --allow-network --allow-media-upload --json

# Critique an already-rendered master with frame-anchored notes
npm run agent -- critique my-plan.json output/neutral-founder-reel.mp4 --provider claude --allow-network --allow-media-upload --json

# Bounded render/critique/revise loop that escalates to a human at the cap
npm run agent -- review my-plan.json --allow-network --allow-media-upload --max-rounds 2 --json
```

### Local source analysis

`agent analyze` resolves the clip under `OVE_ASSET_ROOT`, extracts a temporary mono WAV under `output/analysis/`, transcribes it with Faster Whisper, and writes:

- `analysis.json`, the validated source-analysis artifact.
- `transcript.json`, including word-level timings.
- `captions.srt` and `captions.vtt`.
- Optional sampled-frame measurements when `--frames` is set.

The local editorial pass records FFmpeg silence regions, lexical fillers, conservative crew or restart phrases, repeated-take groups, and heuristic hook candidates. OpenCV records blur, brightness, frontal-face boxes, and sampled-frame discontinuity. These are auditable measurements and heuristics. They are not semantic video understanding, expression recognition, or speaker diarization.

### Optional semantic understanding and diarization

`agent understand` is a separate, explicit remote step. It sends only validated sampled JPEG frames and timed transcript data to a restricted Claude CLI process. Both `--allow-network` and `--allow-media-upload` are required. The process uses argument arrays, `shell:false`, Read-only tools, no saved session, an empty MCP configuration, bounded input, output, runtime, and frame counts. Canonical-path checks reject symlink escapes, and JPEG signatures are checked before upload. Returned findings are schema-validated and written under `OVE_ANALYSIS_ROOT`, which defaults to `output/`.

A checked-in pyannote bridge and provider probe are available for real speaker diarization. This optional path requires the packages in `python/requirements-diarization.txt`, an accepted pyannote model, and an operator-provided Hugging Face token. The token stays in the environment and is never placed in process arguments or logs. Diarization remains reported as unavailable until the real runtime and model are present. No speaker labels are invented.

The Python executable and model can be changed with `OVE_PYTHON`, `OVE_WHISPER_MODEL`, `OVE_WHISPER_DEVICE`, and `OVE_WHISPER_COMPUTE`. Named models are cached or local-only by default. Pass `--allow-model-download` explicitly when a missing named model may be downloaded. A local model path runs offline.

### Rendered-draft critique and bounded revision

`agent critique` and `agent review` judge the actually-rendered master, not just the plan. Both are separate, explicit remote steps and both require `--allow-network` and `--allow-media-upload`; with no grant the engine stays offline and denies the action.

`agent critique <plan.json> <master.mp4>` resolves the master under the output root with lexical and canonical-path containment (a symlink that escapes the root is rejected, and the master must be a regular file), samples it with FFmpeg into a separate run directory so the master is never overwritten, and reads its true duration with FFprobe. It cleans only files whose names exactly match the generated frame pattern, uses argument arrays with `shell:false`, and bounds runtime and output. The sampled JPEG frames and the plan intent go to a restricted Claude CLI process: Read-only tools, no saved session, an empty strict MCP configuration, exactly one granted frame directory, the prompt on stdin, and JPEG signatures checked before upload. Each returned note carries a source time, a severity (`info`, `suggest`, `blocker`), a category, concise text, an optional evidence frame, and optional suggested plan changes that are DATA only. Every note time is validated against the real master duration, cited evidence frames must match the frames that were actually supplied, and the engine, not the model, stamps identity, provider, timestamp, and master path. The result is written under the output root.

`agent review <plan.json>` runs a bounded loop: it renders the exact plan, critiques the exact rendered master, and stops as soon as the critique is approved with no outstanding blocker. Otherwise it asks a provider for one complete replacement plan expressed as DATA, re-validates it against the same strict edit-plan schema (and, when a brief is present, against the declared-media constraint), and only then re-renders. The loop is hard-capped by `--max-rounds`; at the cap, or when a proposal is invalid, it halts and returns a human-escalation result rather than looping unbounded or accepting an invalid plan. Nothing a provider returns is executed; the engine only validates data.

Limitations: this is assistive review, not sign-off. A `configured` provider means the Claude CLI is present, never that the capability is verified; the `draft-critique-revision` acceptance gates flip to passed only with real end-to-end evidence, which unit tests do not provide. Critique and bounded revision do not replace human editorial approval of the final master.

A brief is JSON validated by `src/agent/brief.ts` (AgentBrief v1): objective,
audience, platform, creator/style, preset, desired duration, relative source
clips, optional transcript text or path, output file, constraints, an optional
hook-variant planning hint, and a learning scope. One run currently selects one
final plan. Every path is a safe relative path.

Run records and learned rules live under `OVE_AGENT_HOME` (default
`~/.octupie-video-editor`), outside this repository. Each run writes an audit
directory (sanitized brief, text asset manifest, prompts or prompt hashes,
redacted model replies, validated plans and critiques per iteration, final plan,
provider metadata, active rule ids, and any failure detail). See
`AGENTIC_ARCHITECTURE.md` for the full design.

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
- `AGENTIC_ARCHITECTURE.md`: the standalone bounded agent, providers, learning, and audit.
- `PRODUCTIZATION.md`: integrating the engine into Octupie and Dowd.
- `ASSET_POLICY.md`: media, licensing, and what stays out of Git.
- `STYLE_LEARNING.md`: how learned editing rules become code, schema, and tests.
- `WORKSPACE_AUDIT.md`: what was reused from internal workspaces and what was excluded.
- `CONTRIBUTING.md`: test-driven workflow and conventions.
- `skills/octupie-video-editor/SKILL.md`: the editorial grammar and pointers.
