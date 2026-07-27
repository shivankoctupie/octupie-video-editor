# Agentic Architecture

The agentic layer turns a human brief into a validated edit plan, optionally
renders it through the existing deterministic pipeline, and remembers explicit
human corrections between runs. It is a bounded editorial decision agent: models
propose data, deterministic code validates and executes it, and a human still
signs off on the final master. Nothing a model returns is ever executed.

It runs standalone. It does not depend on Hermes or any private workspace, and
it never reads another tool's private credential store. When a Claude or Codex
CLI is logged in (or a standard API env var is set), the agent can use it; with
neither, the built-in deterministic provider runs the whole loop offline.

## The boundary, restated

```
brief.json --> [agent: manifest + rules + planner/reviewer loop] --> edit-plan.json
                                                                        |
                                                                        v
                                                          [validate] (existing schema)
                                                                        |
                                                                        v
                                                    [render + audio + mux + QA] (existing pipeline)
                                                                        |
                                                                        v
                                                        master.mp4 + qa-report.json  --> human QA
```

The agent only ever emits an edit plan that validates against the existing
`src/schema/editPlan.ts` contract. The planner/renderer split from
`ARCHITECTURE.md` is unchanged; the agent sits in front of the planner boundary.

## Modules (`src/agent/`)

- `brief.ts`: the strict AgentBrief v1 Zod schema. Objective, audience, platform,
  creator/style, preset, desired duration, relative source clips, optional
  transcript text or path, output file, constraints, optional hook-variant count,
  and learning scope. Every path is a safe relative path.
- `manifest.ts`: builds the text, FFprobe-derived asset manifest. The planner
  sees a text description of the footage, never the media bytes. The prober is
  injected, so offline runs and tests need no FFprobe.
- `json.ts`: robust extraction of the first balanced JSON object from model text,
  ignoring prose, code fences, and braces inside strings.
- `prompt.ts`: planner and critique prompt construction, the rubric, and the
  critique schema. The model receives only the brief, transcript text, manifest,
  active rules, and the edit-plan schema. It is told to return one JSON object.
- `plan.ts`: the deterministic plan builder. Given a valid brief it produces a
  valid plan with no model in the loop; it backs both the offline provider and
  the guaranteed fallback.
- `providers/`: the provider interface plus three adapters.
  - `deterministic.ts`: offline, no network. Synthesizes a valid plan and an
    approving critique from the brief.
  - `claude.ts`: the `claude` CLI in noninteractive print mode with
    `--output-format json`, tools disabled, and session persistence disabled.
    The prompt goes on stdin; argv holds no user text.
  - `codex.ts`: the `codex` CLI in noninteractive `exec --json` mode inside a
    read-only sandbox, prompt on stdin, final agent message extracted from the
    JSON events.
  - `index.ts`: the registry and `diagnoseAll` for the `providers` command.
- `exec.ts`: the only process boundary. Argument arrays, `shell:false`, hard
  timeout, capped output buffer, prompt on stdin. No credentials are read here.
- `planner.ts`: the bounded planner/reviewer loop.
- `learning.ts`: the persistent, append-only learning store under
  `OVE_AGENT_HOME`.
- `audit.ts`: the per-run audit directory writer, atomic and redacted.
- `run.ts`: the top-level orchestration that connects everything.
- `cli.ts`: the `agent` subcommands and their exit codes.
- `redact.ts`: secret redaction and size bounds shared across the layer.

## The planner/reviewer loop

Each iteration:

1. Build the planner prompt from the brief, transcript text, manifest text,
   active rules, and the edit-plan JSON Schema. On a repair iteration it also
   carries the exact prior errors.
2. Ask the provider for a plan. Extract the JSON object robustly.
3. Validate it against the real edit-plan schema. Validation errors are returned
   to the planner as repair instructions for the next iteration.
4. On a valid plan, request a separate structured critique. Only a valid plan
   that the reviewer approves is accepted.
5. A rejected plan feeds the reviewer's issues back into the next iteration.

The loop is capped (iterations and per-call timeouts). If it never lands an
approved valid plan, it returns a deterministic fallback plan, so a run always
produces a valid, renderable plan. Model critiques and failed attempts never
become durable rules and never alter the agent's code or prompts.

## Persistent learning

Human feedback and run history live outside the repository under
`OVE_AGENT_HOME` (default `~/.octupie-video-editor`).

- `rules.jsonl`: an append-only log of versioned, timestamped, hashed events.
  A `feedback` command appends a rule; `deactivate` appends a tombstone. The
  current state is the fold of the log, so history is never rewritten in place.
- `runs/index.jsonl`: append-only run records.
- `runs/<runId>/`: the audit directory for a run.

Rules carry a scope: `global`, `creator`, `series`, or `project`. A run loads
only the active rules that apply to its scope. Exact duplicates are deduplicated
by a deterministic id. Only an explicit human correction ever becomes a rule.

## Auditability

Each run directory contains: the sanitized brief, the text asset manifest (both
`.txt` and `.json`), each iteration's prompt and prompt hash, the redacted raw
model replies, the validated plan and critique per iteration, the selected final
plan, provider metadata, the active rule ids, render and QA paths when rendering
is enabled, and any failure detail. It never copies source media or credentials.
Files are written atomically (temp + rename).

## Security

- No shell interpolation anywhere. Every provider call is an argument array with
  `shell:false`; the prompt is delivered on stdin.
- Nothing a model returns is executed. Models return data, which is validated
  through the edit-plan schema (plans) or the critique schema (critiques).
- A plan may use only media paths declared by the brief. Undeclared source
  clips, B-roll, dialogue, music, and SFX are rejected and returned for repair.
- Every brief path is a safe relative path, and real media is contained under
  the existing asset root.
- Bounded stdout/stderr, per-call timeouts, and hard maximum sizes for the
  brief, transcript, rules, and each model response.
- Common secret patterns are redacted before anything is written to an audit
  log; no API keys are logged.
- The agent never rewrites its own source or prompts from model output.

## CLI

```
octupie-video-editor agent providers
octupie-video-editor agent run <brief.json> [--provider deterministic|claude-cli|codex-cli] [--max-iterations N] [--no-render]
octupie-video-editor agent feedback --run ID --scope SCOPE --rule TEXT [--creator X] [--series X] [--project X]
octupie-video-editor agent rules [--scope SCOPE]
octupie-video-editor agent deactivate --rule ID
```

Exit codes: `0` success, `1` an operation that ran but did not pass (render or
QA failed, or an unknown rule to deactivate), `2` a usage or input error (bad
arguments, invalid brief, bad scope, or unknown provider).

## What this agent is not

It is a bounded editorial decision agent, not a taste oracle. It does not
perfectly judge editorial taste, it does not clear source rights, and it does not
verify final phone-scale quality. Human QA of the delivered master remains
required, exactly as for a hand-authored plan.
