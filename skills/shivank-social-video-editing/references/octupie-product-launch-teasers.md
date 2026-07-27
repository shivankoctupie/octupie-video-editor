# Octupie product-launch teasers

Use this reference for explicit Octupie product launches, feature reveals, and short SaaS teasers. It is an exception to the value-first educational Reel structure, not a replacement for it.

## Format decision

Match the delivery aspect ratio to the reference and placement. A landscape YouTube or website launch reference supports a 1920x1080 master. Do not force the normal 1080x1920 social preset merely because the runtime is short.

For a 25 to 35 second teaser, a text-led structure can be stronger than generated narration when the reference itself relies on music, typography, UI choreography, and SFX. No voiceover is a valid creative decision, not a missing layer.

## Reference audit

1. Download and inspect the exact reference.
2. Inspect several recent videos from the same agency or channel to separate one-video decoration from recurring motion grammar.
3. Build a dense contact sheet, usually every 0.5 seconds, plus exact frames at structural changes.
4. Record:
   - copy density and transformation pattern;
   - font category, weights, tracking, and hierarchy;
   - color and depth treatment;
   - UI staging and camera moves;
   - transition direction and easing;
   - music sections, impacts, risers, clicks, and sonic-logo behavior;
   - opening and end-card hold lengths.
5. Reuse the observable grammar, not the source brand, frames, soundtrack, or protected graphics.

A useful launch grammar is:

1. symbol or brand tension;
2. compact transformation promise;
3. one product capability per scene;
4. a clear progress or completion payoff;
5. a short three-beat summary;
6. minimal logo and launch-status lockup.

## Product truth and asset priority

Use this source order:

1. current first-party product source and live website;
2. current official screen recordings and supplied assets;
3. prior approved product videos;
4. old demos only as historical evidence.

If an old recording uses a retired UI or visual system, do not make it the visual center of the launch. Reconstruct current product states as deterministic HTML, CSS, SVG, or Remotion UI only when every visible state and claim is grounded in current first-party sources. Do not invent dashboards, metrics, alerts, or features.

If a supplied Drive folder requires sign-in, inspect the original Drive page once. Continue from verified local official assets when they are sufficient, and disclose the substitution in the delivery note. Do not claim the Drive package was reviewed.

## Octupie launch identity

Default current system:

- Geist Variable;
- paper `#F7F5F0`;
- ink `#111111`;
- blue `#014CE3`;
- faint columns and hairline rules;
- restrained hard shadows;
- blue italic emphasis;
- official logo asset.

A launch teaser may introduce Octupie immediately. This differs from an educational Octupie Reel, which should normally teach value for roughly 70 to 80 percent before the product appears.

Keep one dominant idea per scene. Product proof may be visually dense, but the scene headline must remain sparse and readable.

## Motion build

- Use frame-driven Remotion interpolation. Do not use CSS transitions.
- Favor masked phrase replacements, directional card streams, perspective UI entrances, progress fills, controlled blur-to-sharp entries, and synchronized completion states.
- Build the UI as a hero object, not a static full-desktop screenshot.
- Alternate sparse typography scenes with product-proof scenes.
- Make the final lockup simpler than the preceding visual peak.
- Ensure frame 0 contains intentional visible content. A generic scene-opacity helper that fades from zero must special-case a scene beginning at frame 0.
- Render a half-resolution full-duration preview before the master.

## Original soundtrack and SFX

When no cleared reference music is available, create or license a new track. Do not reuse the reference soundtrack merely because the user asked for its style.

For an original electronic teaser bed:

- set a clear tempo and deterministic arrangement;
- create section changes around scene boundaries;
- use musical impacts for major changes;
- add whooshes only to visible directional motion;
- use a riser before the final summary or logo reveal;
- reserve the strongest impact for one breakout or final payoff;
- keep the final chord or sonic logo under the end-card hold.

SFX timing should be planned in milliseconds against the visual event. Avoid placing the same sweep on every cut at the same gain.

FFmpeg `atrim` should use explicit syntax such as `atrim=start=0.15:end=1.05`. Do not rely on ambiguous shorthand duration parsing.

## QA

Before delivery:

1. Probe dimensions, frame rate, exact decoded frame count, duration, codecs, sample rate, and channels.
2. Run a full video and audio decode.
3. Run black-frame detection.
4. Generate a 0.5-second contact sheet.
5. Inspect exact opening, every structural transition, progress completion, final logo reveal, and closing frame.
6. Check text and UI at both desktop and reduced phone scale.
7. Confirm every shown capability against current first-party product sources.
8. Measure integrated loudness and true peak on the final AAC file.
9. Expect AAC encoding to raise true peak relative to the WAV master. If the encoded peak is too high, lower the original WAV mix, remux with video stream copy, then rerun decode, probe, loudness, contact-sheet, and hash checks on the exact delivered file.
10. Keep the final logo, launch status, and URL inside safe margins with a readable hold.

Suggested text-led teaser target: around `-16` to `-14 LUFS`, with encoded true peak at or below about `-1.0 dBTP`.

## Delivery note

State:

- format and runtime;
- reference techniques adapted;
- product sources used;
- music and SFX origin;
- technical checks passed;
- anything the user should eyeball on their intended screen;
- any supplied asset package that could not be accessed and what verified source replaced it.
