# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

Requires Node 22.5+ (the server uses built-in `node:sqlite`; CI pins 22.17.0) and FFmpeg/FFprobe on `PATH` (or `OVE_FFMPEG_PATH` / `OVE_FFPROBE_PATH`).

```bash
npm ci
npm run doctor                     # check Node, FFmpeg, FFprobe, Remotion
npm run typecheck                  # server tsconfig.json + client tsconfig.client.json
npm test                           # vitest, all of tests/**/*.test.ts(x)
npx vitest run tests/captions.test.ts          # one file
npx vitest run -t "accepts portable relative paths"   # one test by name
OVE_SKIP_RENDER_TESTS=1 npm test   # skip the two live Remotion render suites
npm run build                      # vite build (client -> public/) + tsc (server -> dist/)
npm run schema:gen                 # regenerate schema/edit-plan.schema.json from Zod
npm run dash:sweep                 # fails on any em or en dash in committed text
npm run e2e                        # Playwright specs in tests/e2e (not run by vitest)
npm run demo                       # synthetic render + QA of the exact master
npm run cli -- <command>           # CLI via tsx (doctor, init, validate, render, qa, serve, worker, agent ...)
npm run local                      # one-command local editor (Mac/Linux): deps, build, server + worker, token in output/local/
npm run dev                        # build client, then serve editor + REST API on 127.0.0.1:8722
npm run worker                     # render/QA job worker; needs the same OVE_SERVER_DB file as the server
```

CI (`.github/workflows/ci.yml`) runs, in order: dash sweep, typecheck, schema drift check (`schema:gen` then `git diff --exit-code`), build, doctor, test. Any change to `src/schema/editPlan.ts` must be followed by `npm run schema:gen` and the regenerated JSON committed.

The render integration tests (`tests/pipeline.integration.test.ts`, `tests/timeline-render-integration.test.ts`) make Remotion download a headless Chromium from `remotion.media` on first run; they fail in sandboxes that block that host.

## Architecture

The core is a pure function `edit-plan.json -> (master.mp4, qa-report.json)`. Planning (LLM, probabilistic) and execution (deterministic) are separated by the Zod contract in `src/schema/editPlan.ts` (`format: octupie-edit-plan/v1`, all objects `.strict()`, cross-field refinements). Nothing a model returns is executed; it is parsed as plan data and rejected if invalid.

Execution path (`src/pipeline.ts`): validate plan -> `src/render/` bundles the Remotion project once per process and renders a silent master from compositions in `src/render/remotion/` (registered in `Root.tsx`; frame-driven, deterministic) -> `src/ffmpeg/audio.ts` assembles dialogue/music/SFX with loudnorm and muxes with an explicit duration (never `-shortest`) -> `src/ffmpeg/qa.ts` runs the full QA battery and writes a report bound to the master's SHA-256.

Supporting engine modules: `src/presets/` (editorial identities as data; a new preset needs a test that its `makeStarterPlan` validates), `src/captions/grouping.ts` (1 to 3 word cards), `src/sfx/gates.ts` (cue gating and blacklist), `src/util/paths.ts` + `assetRoot.ts` (portable relative-path validation and containment under `OVE_ASSET_ROOT`), `src/ffmpeg/spawn.ts` (all process spawning, argument arrays, `shell: false`).

Layers built on top of the engine, each additive and opt-in:
- `src/agent/`: brief -> validated plan via a bounded planner/reviewer loop. Providers in `src/agent/providers/` (`deterministic` runs offline, plus `claude` and `codex` CLIs). `src/agent/cli.ts` implements the `agent` subcommands; `analysis/`, `understanding/`, `critique/`, `discovery/`, `hooks/`, `hermes/`, `improvements/`, `generation/`, `materialize/` back those subcommands. Anything that sends data off-machine requires explicit `--allow-network` / `--allow-media-upload` grants; see `AGENTIC_ARCHITECTURE.md` and `FULL_PARITY_ARCHITECTURE.md`.
- `src/capabilities/` plus `ACCEPTANCE_MANIFEST.json` / `PRODUCT_ACCEPTANCE.json`: capability registry and acceptance gates. Gates are only marked passed with real end-to-end evidence; tests check the manifests.
- `src/server/`: authenticated multi-tenant REST server (`node:http`, SQLite repository in `db/`, content-addressed storage in `storage/` with local and injectable S3 adapters, render queue consumed by `worker.ts`). Users/tokens come only from `OVE_SERVER_USERS`; see `.env.example` for all `OVE_SERVER_*` settings. `src/workflow/` holds RBAC, immutable versions, review, and publishing logic.
- `src/client/`: React 19 + Vite timeline editor built into `public/` and served by the server. Editor state lives in `src/client/state/` (reducer, snapping); `editPlanMap.ts` maps the timeline losslessly to and from the optional `timeline` field of the EditPlan.

Python helpers in `python/` (faster-whisper, OpenCV frame metrics, pyannote) are invoked as subprocesses via `OVE_PYTHON` and are optional.

## Conventions not covered by AGENTS.md

- No em dashes or en dashes anywhere in committed text (enforced by `npm run dash:sweep` in CI).
- Tests live flat in `tests/` named `<area>-<topic>.test.ts`; DOM tests opt in with a `// @vitest-environment jsdom` docblock.
- Code is cross-platform: path checks reject Windows drive letters and UNC as well as POSIX absolutes, and the only platform branch is the `.cmd` suffix for spawning npm-style bins on Windows (`src/agent/cli.ts`). Keep it that way.
