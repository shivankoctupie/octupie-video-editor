# Octupie Video Editor

A portable, deterministic AI-assisted video editing engine. Language models produce a validated edit plan; deterministic code performs probing, timing, captions, rendering, audio assembly, and QA. The edit-plan JSON is the stable contract between the planner and the renderer. The engine runs without access to any private workspace.

Proprietary and private. See `package.json` (`UNLICENSED`).

## Requirements

- Node.js 22.5.0 or newer (the server store uses the built-in `node:sqlite` module, added in 22.5.0).
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

## Product server and browser editor

The engine also ships as a self-contained, local-first product: an authenticated multi-user REST server and a real React timeline editor (React 19 + Vite, source in `src/client/`, built into `public/`) for editing, review, and publishing. It loads nothing from a CDN. See `QUICKSTART.md` for a full walkthrough; the short version is:

```bash
# One shared on-disk database is needed so the server and worker cooperate.
export OVE_SERVER_DB=./output/server/ove.db
export OVE_SERVER_USERS='[{"id":"u1","tenantId":"t1","username":"editor","role":"editor","token":"a-long-random-editor-token"}]'

npm run dev       # build the React client, then start the server (editor + REST API) on http://127.0.0.1:8722
npm run worker    # in a second terminal: claim and render queued jobs off the request path
# npm run build && npm start   # run the compiled server instead of the tsx dev server
```

Open the printed URL, paste a token, and you get a genuine timeline editor: a media bin (upload by picker or drag, with poster thumbnails and decoded audio waveforms), a synchronized preview with play/seek and a playhead that follows playback, an inspector, and a multi-track timeline (video, overlays, captions, audio) driven by the MIT `@xzdarcy/react-timeline-editor` engine with drag-to-move, trim handles, split, ripple delete, snapping, zoom, and undo/redo. Edits map losslessly into the validated EditPlan and immutable versions, with autosave and explicit Save version, so a reload reproduces the timeline exactly. A Manage panel holds the secondary flows: render enqueue and job status, frame comments, submit/approve/reject, truthful version comparison, QA display, local generation and grant-gated materialization with provenance, and a default-disabled publish request, all gated by the token's role. Tokens and permission grants come only from the environment or an explicit config; with none configured the server still runs locally with an in-memory database, publishing disabled, and no network adapters.

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
| `serve [--port n]` | Start the local product server: the browser editor, review UI, and REST API. |
| `worker [--once]` | Run the render/QA job worker against the shared database, off the request path. |
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

# Offline local discovery returns only assets with validated rights sidecars
npm run agent -- discover-assets --intent "2026 team workshop" --source local --asset-root /path/to/assets --max-results 20 --json

# Drive and web reference discovery is opt-in and needs configured external adapters
npm run agent -- discover-assets --intent "official product launch" --source drive,web --allow-network --json

# Produce exactly three validated, renderer-ready opening plans offline
npm run agent -- hook-variants my-plan.json --objective "explain customer retention" --count 3 --provider deterministic --out output/hooks/customer-retention --json

# Optional restricted Claude text drafting needs explicit network consent
npm run agent -- hook-variants my-plan.json --objective "explain customer retention" --count 3 --provider claude --allow-network --out output/hooks/customer-retention-claude --json

# Optional official Hermes API check. Token is read only from the environment.
OCTUPIE_HERMES_API_KEY=your-local-api-server-key npm run agent -- hermes-check --endpoint http://127.0.0.1:8642 --allow-network --json

# Request bounded, data-only orchestration guidance from Hermes
OCTUPIE_HERMES_API_KEY=your-local-api-server-key npm run agent -- hermes-orchestrate --endpoint http://127.0.0.1:8642 --objective "review the opening" --stage draft-qa --allow-network --json
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

### Rights-safe asset discovery

`agent discover-assets` searches an explicit local asset root offline. It returns a local file only when a strict `<asset>.rights.json` sidecar states a concrete license, attribution requirements, provenance, and either `permissive` or `local-owner` rights. Missing, invalid, unknown, and restricted rights are rejected. Paths are portable and contained by lexical and canonical checks, including symlink and junction escapes. Traversal, result counts, media extensions, and ordering are bounded and deterministic.

Drive and web discovery return references and rights metadata only. They require `--allow-network` and a separately configured official external adapter. Discovery never downloads media. Any future byte materialization uses a distinct method that also requires explicit `media-upload` permission. Public availability, an official page, or a filename is not reuse permission. A human must still verify the license and attribution before publishing.

### Complete hook variants

`agent hook-variants` returns exactly the requested number of distinct, validated edit plans or fails. The deterministic provider runs offline. It changes opening text only, preserves body scenes, media, source ranges, caption timing, and audio, and writes one complete plan per variant plus an atomic manifest under the output root. Requested counts are bounded from 1 to 10. Duplicate text, strategies, plan hashes, invented media, invalid plans, forbidden phrases, missing required keywords, and output path escapes are rejected.

The optional Claude provider is text-only and requires `--allow-network`. It receives no tools, no MCP servers, no session persistence, and bounded input, output, and runtime. Its response is strict data that passes the same complete-count, edit-plan, media, body-change, and uniqueness gates. It never silently pads a short provider result unless deterministic fallback was explicitly selected by an API caller.

Limitations: variants are renderer-ready plans, not approved deliveries. Render each requested opening, preserve the full spoken hook phrase and natural tail, then run phone-scale caption, face-coverage, audio, and manual editorial QA before publishing.

### Optional official Hermes orchestration

Hermes is optional. The editor remains standalone and offline by default. It never reads Hermes profile files, `.env`, `auth.json`, OAuth credentials, private Python modules, or internal databases.

The integration uses the documented authenticated Hermes API Server only. Enable that server separately with `API_SERVER_ENABLED=true` and a strong `API_SERVER_KEY`, then restart the Hermes gateway. The documented local endpoint is `http://127.0.0.1:8642`. The editor receives the matching token only through `OCTUPIE_HERMES_API_KEY`. Tokens in URLs and CLI flags are rejected and never printed.

Both `agent hermes-check` and `agent hermes-orchestrate` require `--allow-network`. Remote endpoints require HTTPS. Redirects, oversized responses, malformed capabilities, non-Hermes identity, malformed chat envelopes, and unvalidated orchestration data are rejected. Before any orchestration context is sent, the adapter validates `GET /v1/capabilities` as the official Hermes API Server. Orchestration output is bounded JSON data only. It is never executed, rendered, published, or treated as approval.

Without an endpoint, token, or network grant, the integration is unavailable and the existing analysis, planning, rendering, QA, discovery, and deterministic hook workflows continue unchanged.

### Approved and reversible improvements

Improvement proposals are reviewed data artifacts, never silent self-modification. A proposal contains a bounded `octupie-replace-v1` full-file replacement patch, exact prior bytes and hashes, allowlisted tests, and a rollback plan. Only `src/`, `tests/`, `skills/`, `prompts/`, `README.md`, and `AGENTS.md` can be changed. Traversal, symlink escapes, protected credential paths, binaries, stale files, duplicates, oversized patches, and shell-like test commands are rejected before source writes.

Apply requires both a separate matching human decision and the explicit `--allow-code-change` grant:

```bash
npm run agent -- improvement-apply proposal.json --decision apply-decision.json --allow-code-change --state-root output/improvements
npm run agent -- improvement-rollback proposal.json --decision rollback-decision.json --allow-code-change --state-root output/improvements
```

All operations are preflighted before the first source write. Tests run only through a `shell:false` allowlist. A source-write, test-runner, failed test, or final audit-write failure restores exact prior bytes. Successful application records hashes, exact backups, approval identity, and an integrity-stamped audit. Rollback needs a new rollback decision and grant, refuses changed files or a mismatched audit, restores exact prior bytes transactionally, and is idempotent.

Limitations: this phase validates and applies a proposal supplied by a human or external provider. It does not let a model apply its own output. The local integrity hash detects accidental or simple audit edits, but the state directory should still be protected by operating-system access controls.

### Local workflow, review, and publishing controls

The workflow layer is local-first and data-only. It provides default-deny RBAC for viewer, editor, approver, publisher, and admin roles. Plans and optional masters are recorded as immutable, monotonically numbered versions with real SHA-256 hashes. Editors submit a draft by creating a new in-review version. Approvers create a separate approved or rejected version. Existing version records are never mutated.

The file-backed queue stores bounded analyze, plan, render, QA, and publish jobs. It applies FIFO claims, explicit transitions, idempotency keys, and a three-attempt cap. Job payloads are JSON data and are never executed. The default notification adapter writes a bounded local outbox only.

Publishing is disabled by default. The shipped `disabled` adapter cannot reach a network and always blocks. A configured external adapter is invoked only after an approved version, publisher or admin role, explicit `publishing` grant, confirmed rights, passed QA, matching adapter, and unused idempotency key have all passed. Adapter output is strict bounded JSON data. Success writes one immutable receipt without mutating the approved version. Failed and blocked attempts write no receipt.

```bash
npm run agent -- workflow-authorize publisher publish
npm run agent -- workflow-publish request.json --allow-publish --state-root output/workflow --project-root .
```

The commands above drive the file-backed agent workflow store. The same guarantees are also exposed by the product server (`npm run dev`) over a transactional SQLite database with unique idempotency constraints, a concurrency-safe FIFO job claim, and content-addressed storage, with the browser app providing the frame-level review UI and truthful visual version comparison over those immutable records. The product server ships one optional publishing adapter, an HTTPS webhook that is off by default and enabled only when the operator configures an endpoint and an allowlist; SSRF and DNS-rebinding defenses run before any byte is sent. See `PRODUCTIZATION.md` and `SECURITY.md` for the boundary and `PRODUCT_ACCEPTANCE.json` for the local gates that are executable-verified.

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

- `npm test` runs the full suite, including the real render and QA integration and the product acceptance and browser smoke tests.
- `npm run typecheck` runs strict TypeScript validation.
- `npm run build` compiles the Node code to `dist/`.
- `npm run dev` starts the local product server from source (browser editor + REST API).
- `npm start` runs the compiled product server from `dist/` (build first).
- `npm run worker` runs the render/QA job worker against the shared database.
- `npm run schema:gen` regenerates the committed JSON Schema from the Zod source.
- `npm run dash:sweep` fails on any em or en dash in committed text.
- `npm run sfx:fetch -- --manifest <file>` runs the rights-safe SFX mechanism (dry run by default).

## Documentation

- `ARCHITECTURE.md`: the planner and renderer split, storage and job boundaries, security.
- `AGENTIC_ARCHITECTURE.md`: the standalone bounded agent, providers, learning, and audit.
- `PRODUCTIZATION.md`: the local product server and how the engine integrates into Octupie and Dowd.
- `QUICKSTART.md`: run the product server, sign in, and walk the full editor and review flow.
- `SECURITY.md`: the trust boundary, auth, RBAC, permission grants, SSRF defenses, and secret handling.
- `FULL_PARITY_ARCHITECTURE.md`: the eight parity capabilities and what is verified, configured, or intentionally unverified.
- `ACCEPTANCE_MANIFEST.json`: the external-provider parity gates (pending until backed by real evidence).
- `PRODUCT_ACCEPTANCE.json`: the local-product gates, each executable-verified by the test suite.
- `ASSET_POLICY.md`: media, licensing, and what stays out of Git.
- `STYLE_LEARNING.md`: how learned editing rules become code, schema, and tests.
- `WORKSPACE_AUDIT.md`: what was reused from internal workspaces and what was excluded.
- `CONTRIBUTING.md`: test-driven workflow and conventions.
- `skills/octupie-video-editor/SKILL.md`: the editorial grammar and pointers.
