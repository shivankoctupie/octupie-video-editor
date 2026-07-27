# Productization

How the engine becomes a service inside Octupie and Dowd.

## Shape of the integration

The engine is a pure function: `edit-plan.json -> (master.mp4, qa-report.json)`. A product wraps it with three things it deliberately does not own:

1. A planner that turns a user brief into a validated edit plan.
2. A job runner that renders plans off the request path.
3. Storage and retention for inputs, masters, and reports.

```
user brief
   |
   v
[planner service] --(edit-plan.json)--> [validate] --reject--> back to planner
   |                                        | accept
   |                                        v
   |                                   [job queue] --> [worker: render + audio + mux + QA]
   |                                        |
   v                                        v
[review UI] <--(master + qa report + contact sheet)-- [object storage]
```

## Planner integration

The repository ships a reference planner: the bounded agent in `src/agent/`
(see `AGENTIC_ARCHITECTURE.md`). It is standalone and zero-key by default. It
turns an AgentBrief into a validated plan through a capped planner/reviewer loop,
uses the deterministic offline provider or an existing Claude/Codex CLI login,
and preserves a deterministic fallback so a run always yields a valid plan. A
product can adopt it directly or replace it, as long as the plan still validates
server-side before enqueuing. Its learning store and audit directories are file
based under `OVE_AGENT_HOME`; a host service can point that at per-tenant storage.

- The planner emits plans against `schema/edit-plan.schema.json`. Give the model the schema and the preset list; constrain its output to a validating plan.
- Always run `parseEditPlan` server-side before enqueuing. A plan that fails validation is a planner bug, not a render job. Return the errors to the planner loop.
- Presets carry the editorial identity. The planner selects a preset and fills scenes, captions, and SFX intent; it does not restate typography or color.
- Caption grouping and SFX gating can run inside the planner loop (`src/captions/grouping.ts`, `src/sfx/gates.ts`) so the model gets feedback before a plan is finalized.

## Job and worker boundary

- Rendering is CPU and memory heavy and downloads a browser on first use. Run it in a worker pool, never on the web request path.
- One job equals one plan. Workers are stateless: they receive a plan and an output location, call `renderPlan`, and upload the master, the QA report, and the contact sheet.
- Gate delivery on `report.pass`. A failing QA report blocks publish and routes to review with the failed gates attached.
- Bundle caching: `bundleProject` caches the Remotion serve URL per process. In a warm worker, reuse it across jobs.

## Storage boundary

- Inputs are content-addressed or namespaced per tenant and are read-only to the engine.
- Each worker mounts or downloads one job's inputs into an isolated asset directory and sets `OVE_ASSET_ROOT` to that directory. Plan paths stay relative.
- Masters and reports are written under a per-job prefix. The report is bound to the master SHA-256, so storage can verify integrity on read.
- Retention and cleanup of intermediates are the host's responsibility. The engine only writes under the configured output directory.

## Octupie

Octupie already owns the brand system encoded in the `octupie-product-launch` preset and the shared editorial grammar in `skills/`. The integration path is: expose the planner behind the existing product surface, enqueue validated plans, and surface the QA report and contact sheet in the existing review step. Reuse the Octupie facts registry for any on-screen product claim; the planner must verify claims before they enter a plan.

## Dowd

Dowd integrates the engine as a rendering and QA backend behind its own planner and asset pipeline. It supplies its own presets (its brand identities) as portable preset data, its own rights-cleared asset manifests, and its own job runner. The contract, the FFmpeg wrappers, and the QA battery are reused unchanged. Nothing in the engine assumes Octupie branding; the Octupie preset is one entry in a registry Dowd can extend.

## Security and licensing in production

- Keep the no-shell-interpolation and path-safety guarantees at the service edge too: never build FFmpeg commands from user strings, and re-validate every path server-side.
- The engine bundles no audio. Production supplies SFX through rights-cleared manifests; enforce `checkManifestRights` before a cue references an asset.
- Strip metadata on every deliverable and assert no location tags in the QA gate. Do not disable that gate for speed.
- The package is `UNLICENSED`. Keep it private. Third-party assets carry their own licenses recorded beside them.

## Update flow

- The schema is versioned by `format` (`octupie-edit-plan/v1`). A breaking change bumps the version; keep a validator for each supported version during migration.
- Regenerate the committed JSON Schema whenever the Zod source changes (`npm run schema:gen`); CI fails if the committed file drifts.
- Presets are data. Adding or tuning a preset is a data change with a test that its starter plan still validates.

## What is intentionally excluded

- No bundled model keys. The deterministic engine and offline agent provider
  remain zero-key; authenticated providers are optional adapters.
- No job queue, database, auth, or web server.
- No bundled media, fonts as binaries, or paid asset packs.
- No cloud storage client. The engine reads and writes the local filesystem only.
