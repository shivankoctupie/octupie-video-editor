# Workspace audit

What was inspected in the internal read-only workspaces, what behavior was reused, and what was deliberately left out. Nothing private was copied. Every reused idea was reimplemented as original code, schema, tests, presets, or sanitized skill content.

## Inspected and reused

### shivank-social-video-editing skill

The editorial source of truth. Read in full: `SKILL.md` and the reference set, the Python cue validator, and the cue-sheet template.

Reused as behavior:
- The SFX cue rules became `src/sfx/gates.ts` (role, family, intensity, blacklist, near-time repetition, dense stack, default trailer stack, hero spacing), reimplemented in TypeScript.
- One-to-three-word captions on phrase boundaries with preserved word tails became `src/captions/grouping.ts`.
- The Octupie brand system (Geist, paper `#F7F5F0`, ink `#111111`, blue `#014CE3`) and the series identities became the presets.
- The premium motion direction (single signature easing, reserved layout, frame-zero content, one hero action) shaped `src/render/remotion/components.tsx`.
- The technical QA gates became `src/ffmpeg/qa.ts`.

Copied and sanitized into `skills/shivank-social-video-editing/`: the whole skill tree, with local absolute paths replaced by portable placeholders and verified free of em and en dashes. Editorial meaning is unchanged.

### Premium Editing Assets tools

Read `tools/download_curated_sfx.py`. Reused the pattern of a rights-cleared manifest with source URL, license, license URL, and SHA-256 per record, and the blacklist. Reimplemented as `src/sfx/manifest.ts` plus the `scripts/fetch-sfx.ts` mechanism. No audio, no library, and no machine paths were copied. The transport is intentionally left unwired.

### Claude Video Editor remotion package

Read `package.json` and the composition list. Reused the approach of data-driven Remotion compositions with the Geist variable font and React 19, and confirmed the version line. Wrote original components and two new compositions (`PremiumProductFilm`, `FounderSocialReel`); none of the existing `.tsx` compositions were copied.

## Inspected at a distance, not copied

The following workspaces were listed as reuse sources. Their structure was examined to confirm the transferable lessons already captured above; no code or media was taken.

- `YC Reel Edit`: per-version Python reel builders, hook-variant generation, transcription. Confirmed the lessons about recalculating downstream timing from each hook's exact duration and preserving word tails. These are encoded in the captions retiming helpers and the schema, not copied.
- `Drive Reel 1zGx`: Y-series revision builder and B-roll preparation. Confirmed the YC rule that B-roll must not cover the speaker, encoded in the `yc-series-vertical` preset proof behavior.
- `Addx Product Launch Recreation`: audio build, onset comparison, motion-smoothness measurement, and delivery notes. Confirmed the launch-teaser grammar and the true-peak-after-AAC caution, reflected in the audio target handling and the QA loudness and true-peak gates.

## Deliberately excluded

- All source footage, client media, and reference media.
- All rendered outputs, mezzanines, and analysis artifacts.
- Paid asset packs and any audio binaries.
- User-specific absolute paths and machine configuration.
- The existing Remotion compositions and Python build scripts (reimplemented from principles, not copied).
- Model keys and credentials. The engine is zero-key.
