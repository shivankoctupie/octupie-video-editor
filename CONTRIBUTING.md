# Contributing

Proprietary and private. Internal contributions only.

## Test-driven workflow

Every behavior change starts with a failing test.

1. Write a focused test that describes the new behavior and run it to confirm it fails for the right reason.
2. Write the smallest code that makes it pass.
3. Run the whole suite and keep it clean.

For a rejection rule, add a fixture that must always fail validation (see `tests/fixtures/rejected-33s-stack.json`).

## Commands

```bash
npm test            # full suite, including the real render and QA integration
npm run typecheck   # strict TypeScript, no emit
npm run build       # compile Node code to dist/
npm run doctor      # environment check
npm run demo        # render a synthetic reel and QA it
npm run schema:gen  # regenerate the committed JSON Schema from the Zod source
npm run dash:sweep  # fail on any em or en dash
```

Set `OVE_SKIP_RENDER_TESTS=1` to skip the render integration test locally when iterating on pure logic. CI always runs it.

## Conventions

- Strict TypeScript. Portable relative paths only; no machine paths in committed code, presets, or skills.
- Never build an FFmpeg or FFprobe command from a user string. Use the argument-array wrappers in `src/ffmpeg/spawn.ts`.
- Validate all plan JSON and all file paths before use. Keep `.strict()` on schema objects.
- Never overwrite source media. Write only under the output directory.
- No em dashes and no en dashes anywhere in committed text. The dash sweep and a PostToolUse gate enforce this; a single dash fails the change.
- No writing that reads as machine-generated. Plain, direct English.
- Keep editorial series taste in presets and skill references, not in the shared engine.

## Adding a preset

1. Add the preset data to `src/presets/index.ts` with no machine paths.
2. Add a test that `makeStarterPlan` for it validates against the schema.
3. If it introduces a new composition, add the Remotion component and register it in `Root.tsx`.

## Changing the contract

1. Edit the Zod schema in `src/schema/editPlan.ts`.
2. Regenerate the committed JSON Schema (`npm run schema:gen`); CI fails if it drifts.
3. If the change is breaking, bump the `format` version and keep a validator for each supported version.

## Before opening a change

- `npm run typecheck`, `npm test`, `npm run build`, and `npm run dash:sweep` all pass.
- `npm run doctor` and `npm run demo` pass locally.
- No media, secrets, or machine paths are staged.
