# Full Parity Architecture

This document defines the standalone architecture for eight capability areas the
engine intends to reach. Parity phase 1 landed the contracts, the permission
model, the capability registry and its diagnostics, and the acceptance framework.
Later phases implemented the local, offline halves of several capabilities and the
full local product server for human review and publishing.

Read the status honestly, in three states (unchanged from the registry's own three
states below):

- Verified local: implemented and executable-verified offline. This covers human
  review and publishing (capability 8) as the product server in `src/server/` and
  its browser app in `public/`; local deterministic generation (SVG and labelled
  WAV); the local half of asset discovery and materialization; complete hook-variant
  production; and reviewed improvement proposals with approval and rollback. Their
  local gates live in `PRODUCT_ACCEPTANCE.json`, proven by the test suite.
- Configured but unverified: a backing provider or endpoint can be wired by env only
  and is never reported verified. This covers the OpenAI-compatible generation HTTP
  adapters, the S3 storage contract, the Google Drive materialization path, the HTTPS
  webhook publishing adapter, and the official Hermes API surface.
- Intentionally unverified (external providers): direct semantic video understanding,
  automatic transcription with word timing and diarization, and rendered-draft
  multimodal critique. These reach beyond the local boundary and stay `pending` in
  `ACCEPTANCE_MANIFEST.json` until backed by real evidence. Nothing marks them green.

Removing every optional capability still leaves the offline plan-to-master pipeline
working exactly as before.

The prime directive from `ARCHITECTURE.md` and `AGENTIC_ARCHITECTURE.md` is
unchanged: language models return data, deterministic code validates and executes
it, the edit-plan JSON is the stable contract, and a human signs off on the final
master. Nothing a model returns is executed. This layer sits in front of that
boundary and never weakens it.

## Standalone first

The engine runs offline with no network, no Hermes, and no private workspace.
Every capability below is optional and additive. Removing all of them leaves the
existing plan-to-master pipeline working exactly as it does today. Each capability
that reaches beyond the local offline boundary must hold an explicit permission
grant; with no grant, the engine stays offline and denies the action.

## Permission and approval model

Source: `src/permissions/policy.ts`.

Four operation classes are gated, default-deny:

- `network` any outbound network call (model APIs, Drive, web discovery).
- `media-upload` sending media bytes to a remote service.
- `publishing` pushing a rendered draft to an external destination.
- `code-change` modifying the engine's own source, skills, or prompts.

A grant is operator-supplied data (`action`, `grantedBy`, `grantedAt`, optional
`expiresAt` and `reason`). `evaluatePermission` allows an action only when a
matching, unexpired grant exists; `requireGrant` throws `PermissionDeniedError`
at an enforcement point otherwise. The engine never mints a grant for itself, and
a model reply can never become a grant. An unparseable or past `expiresAt` is
treated as no grant.

## Capability registry and diagnostics

Sources: `src/capabilities/types.ts`, `contracts.ts`, `registry.ts`.

`CAPABILITIES` is the single source of truth. Each descriptor names its
provider-neutral contract interface, the permission actions it must hold before
acting, and the acceptance-gate ids that must pass before it may be `verified`.

Three honest states:

- `unavailable` the contract exists but nothing backs it here.
- `configured` a backing provider or config is present but unproven.
- `verified` an acceptance gate for this capability actually passed.

`diagnoseCapabilities` reports the real state. A probe may claim `verified`, but
the claim survives only if it cites an acceptance gate that belongs to that
capability; otherwise it is downgraded to `configured` and annotated. This is the
anti-overclaim rule, and it is enforced structurally, not by convention.

Command: `octupie-video-editor agent capabilities [--json]`. It is offline and
deterministic. It prints each capability's status, the default-deny permission
set, and the acceptance-gate ledger. The `--json` form is machine-readable and
reports `permissions.defaultDeny: true` and `acceptance.green: 0` while nothing
is implemented.

## Acceptance framework

Sources: `ACCEPTANCE_MANIFEST.json`, `src/capabilities/acceptance.ts`.

The manifest enumerates every future end-to-end gate. Each gate is `blocking`,
`kind: "e2e"`, and starts `pending`. A gate flips to `passed` only when its real
executable check passes against real output; that wiring is future work.
`assertNoGreenGates` throws if any gate is marked green with no verified backing,
so the manifest can never fake completion. Gate ids match the registry's
`acceptanceGateIds` exactly in both directions, checked by test.

## The eight capabilities

For each area: the component boundary, the contract, the permissions it needs,
and its blocking acceptance gates.

### 1. Direct semantic video understanding

- Contract: `VideoUnderstandingProvider`.
- Boundary: reads a source clip directly and returns time-ranged semantic
  segments (description, salience, tags) plus a summary for the planner manifest.
  It produces data only; the planner consumes the summary, the renderer never
  sees media bytes.
- Permissions: `network` (a remote understanding model).
- Gate: `gate:semantic-video-understanding:segments`. Segment ranges lie within
  the clip and salience ranks a known key moment above filler.

### 2. Automatic transcription and editorial analysis

- Contract: `TranscriptionProvider`.
- Boundary: word-level timing with diarization, plus marks for filler words, dead
  silence, off-camera crew prompts, and repeated takes grouped for selection.
  Feeds the existing caption grouping and cut logic as data.
- Permissions: `network`.
- Gates: `word-timing` (monotonic, in-clip, within tolerance of a reference),
  `diarization` (two speakers separated correctly), `filler-silence-take` (each
  seeded artifact flagged, repeated take grouped).

### 3. Rendered-draft multimodal critique and bounded revision

- Contract: `DraftCritiqueProvider`.
- Boundary: critiques the actually-rendered master, not just the plan, with
  frame-anchored notes, then proposes a bounded revision plan. The proposal is
  data; the engine re-validates it against the edit-plan schema and re-renders.
  The loop is capped and escalates to a human at the cap.
- Permissions: `network`, `media-upload` (the master is sent to a critique model).
- Gates: `frame-notes` (note anchored near a known defect, marked blocker),
  `bounded-rounds` (proposals validate and re-render, loop halts at the cap).

### 4. Rights-safe local, Drive, and web asset discovery

- Contract: `AssetDiscoveryProvider`.
- Boundary: finds candidate assets across local disk, Google Drive, and the web,
  returning only licensed references with explicit license and attribution data,
  never unlicensed bytes. Local discovery is offline; Drive and web need grants.
- Permissions: `network` for Drive and web; downloads that pull bytes also enter
  the `media-upload` review path.
- Gates: `local` (offline, finds a seeded asset, returns a portable relative
  reference), `rights-metadata` (every candidate carries a permissive license;
  unlicensed candidates are never returned).

### 5. Complete hook-variant production

- Contract: `HookVariantProducer`.
- Boundary: produces the full requested set of distinct hook variants, each as a
  renderer-ready plan fragment, not prose. Fragments validate against the
  edit-plan schema before use.
- Permissions: `network`.
- Gate: `full-set` (N variants requested returns N distinct, each valid).

### 6. Optional Hermes integration via official surfaces

- Contract: `HermesIntegration` (carries `standalonePreserved: true`).
- Boundary: connects to Hermes only through an official MCP, API, or plugin
  endpoint, never a private credential store. Absent Hermes, the full offline
  pipeline still runs and passes QA.
- Permissions: `network`.
- Gates: `official-surface` (only a configured official endpoint is used),
  `standalone-preserved` (pipeline passes QA with Hermes fully absent).

### 7. Reviewed improvement proposals with approval and rollback

- Contract: `ImprovementProposalProvider`.
- Boundary: drafts code, skill, or prompt improvements as reviewed proposals that
  carry tests and a rollback plan. Applying is permitted only with an explicit
  approval decision and a held `code-change` grant. There is no silent
  self-modification path, consistent with the agentic security rules.
- Permissions: `code-change`.
- Gates: `approval-required` (unapproved apply is refused), `rollback` (applied
  change ships passing tests and its rollback restores prior state).

### 8. Human review and publishing

- Contract: `ReviewPublishingProvider`.
- Boundary: frame comments, approvals, version comparison, review queues,
  versioned storage, publishing adapters, and role-based access control. Storage
  and queues stay outside the engine, matching the host-service boundary in
  `PRODUCTIZATION.md`; the engine defines the contract.
- Permissions: `publishing`, `media-upload`.
- Gates: `frame-comments` (persisted against the right version),
  `approvals-rbac` (only approver or admin can approve), `version-compare`
  (truthful diff of two masters), `publish-adapter` (publishing needs an approved
  version, a publisher or admin role, and held publishing and media-upload
  grants; otherwise refused).

## Invariants preserved

- Deterministic offline CI: the new contracts, registry, diagnostics, and
  acceptance loader run with no network and no media, and their tests are offline.
- Media-path containment: contracts reference assets by portable relative paths
  through the existing guard; no capability introduces absolute or escaping paths.
- No secrets, no shell interpolation: this layer spawns nothing and reads no
  credential store. Existing redaction and the argument-array process boundary
  are untouched.
- Current renderer behavior: unchanged. This layer sits in front of the planner
  boundary and adds no code to the render, audio, mux, or QA path.
