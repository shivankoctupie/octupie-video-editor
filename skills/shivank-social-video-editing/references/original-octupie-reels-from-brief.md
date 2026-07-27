# Original Octupie Reels from a Brief

Use this workflow when Shivank supplies a topic, audience, and CTA and expects a complete original Reel, including script, voiceover, motion graphics, music, and SFX.

## 1. Verify the product claim first

- Read the live first-party Octupie site before writing.
- Convert only current, explicit product statements into narration.
- Avoid broad claims such as guaranteed growth, trend prediction, or fully automatic publishing unless the live product source supports them.
- Save the final value promise in one plain sentence before production.

First-party language may include concepts such as account baselines, outliers, content structure, and niche mapping. These are product-research notes, not automatically voiceover language.

## 2. Translate product language for ordinary creators

Write for a general creator or social-media operator, not an analytics specialist.

- Replace `baseline` with `what that account normally gets` or `usual performance`.
- Replace `outlier` with `a post doing much better than usual`.
- Replace `noise versus signal` with the concrete problem: `too much content and no clear answer`.
- Replace framework lists such as `hook, beat, payoff, CTA` with only the terms a normal creator would say, such as `the hook, the main idea, and why it worked`.
- Prefer `your space` over `your niche` when the audience is broad.
- Use short spoken sentences, contractions, and familiar verbs.
- Read the script aloud before voice generation. If a sentence sounds like product documentation, rewrite it.

A reliable value-first order is:

1. Name a familiar creator problem or promise a useful method.
2. Teach the method in concrete steps that work even if the viewer never buys anything.
3. Include one non-obvious decision rule, such as comparing a post with what that creator normally gets rather than choosing the largest raw view count.
4. Give a short checklist the viewer can apply immediately.
5. Show how to adapt the idea without copying, using the creator's own experience and audience.
6. State the manual limitation only after the lesson is complete.
7. Introduce Octupie in the final 20 to 30 percent as the faster way to search, sort, or turn the chosen idea into a script.
8. End with the supplied CTA.

Do not mention Octupie, product mechanics, founding access, or agency scaling in the opening educational section. A small established series wordmark may remain as passive branding, but the narration and main visuals must teach rather than pitch. Audit the script by timestamp: if the product benefit begins before roughly 70 percent of the runtime without a specific user request, rewrite it.

Example plain-language mechanism:

> It watches the top creators in your space and finds the posts doing much better than they normally do. Then it shows you the hook, the main idea, and why people kept watching.

Keep two or three alternate hooks in the project notes when useful, even when rendering one selected master.

## 3. Study approved references before designing

When Shivank says to use previous videos as inspiration, the prior approved videos are the style source of truth.

Before opening the motion project:

1. Locate the approved masters, source references, prior Remotion components, contact sheets, and music stems.
2. Record the reusable principles: phrase duration, text-entry direction, blur amount, typography contrast, information density, scene color rhythm, music energy, and transition cadence.
3. Reject any new visual family that is not supported by the script or the approved references.
4. Create phone-scale stills for the hook, product explanation, and payoff before the full render.

Treat references as learning sources, not templates. Rebuild the design in Octupie branding.

## 4. Voice quality is an approval gate

Generate the complete voice before locking scene timing.

- Do not accept a technically intelligible voice that sounds robotic, over-enunciated, or evenly paced.
- Audition the first 10 to 15 seconds at phone volume before building the full motion timeline.
- Use sentence and paragraph generation with intentional 0.2 to 0.4 second pauses instead of one long unbroken synthesis request.
- Preserve varied sentence lengths and natural contractions.
- Export or recover word timing from the finished voice. Build scene boundaries from actual phrase onsets and tails.
- Verify the final encoded mix with ASR, but do not use ASR alone to judge voice quality.
- Brand-name ASR output such as `Octopi` does not prove the spoken brand is wrong. Check the source script and listen.

### Natural local voice fallback with Kokoro ONNX

When no approved human recording or premium voice provider is available, Kokoro ONNX is a stronger local fallback than a generic system neural voice.

Setup in a project-local environment:

```bash
uv venv .venv-tts --python 3.12
uv pip install --python .venv-tts/Scripts/python.exe kokoro-onnx soundfile 'misaki[en]'
```

Use the official Kokoro ONNX model release and voices file. An int8 model is sufficient for local iteration. Generate each paragraph separately, concatenate the results with short silence, then master to 48 kHz. On Windows Git Bash under Hermes, invoke the project interpreter with `env -u PYTHONPATH` so imports come from the project environment.

A conversational voice such as `af_heart` at roughly 1.0 speed is a useful audition starting point, not a permanent preset. Always compare voice personality against the topic and references.

Master conservatively:

- high-pass around 70 Hz;
- light compression only;
- approximately -16 LUFS dialogue target;
- no processing that makes the voice metallic or gated.

### More natural local fallback with Chatterbox

When Kokoro still sounds too even or synthetic, audition Chatterbox before accepting the voice. Its default English voice can provide more varied pauses and emphasis without cloning a person.

Project-local Windows setup:

```bash
uv venv .venv-chatter --python 3.11
uv pip install --python .venv-chatter/Scripts/python.exe chatterbox-tts 'setuptools<81'
env -u PYTHONPATH .venv-chatter/Scripts/python.exe generate_voice.py
```

`setuptools<81` is needed by the current Perth watermark loader used by Chatterbox. Keep watermarking enabled. Do not patch it out merely to bypass an import error.

Generate one thought or paragraph at a time, preserve short irregular pauses, then concatenate and master to 48 kHz. `exaggeration=0.42` and `cfg_weight=0.32` are useful audition starting points, not fixed style values. Always listen to the hook, one long sentence, the brand name, and the CTA before timing motion. Correct ASR proves intelligibility only.

Chatterbox model files and project environments can consume several gigabytes. Preserve the raw and mastered voice first. If render storage becomes constrained, remove only the reproducible model cache and temporary environment, never source media or approved masters.

## 5. Established Octupie recreation language

For this series, originality means a new teaching structure inside the approved brand system, not a new brand system.

Lock these tokens before mockups:

- Geist Variable only, with italic Geist for emphasis;
- paper `#F7F5F0`;
- brand blue `#014CE3`;
- ink `#111111`;
- secondary paper `#EDEAE3`;
- faint vertical paper columns at approximately 180-pixel spacing;
- thin one-pixel borders and restrained seven-pixel hard black shadows;
- small official icon plus lower-case `octupie` wordmark in the same measured position used by the approved recreation family;
- paper, blue, and ink full-frame states;
- no Georgia or unrelated editorial serif, glossy gradients, rounded SaaS cards, glass panels, or generic dashboard styling unless Shivank explicitly changes the family.

Preferred visual behavior:

- one clear teaching idea per screen;
- large phone-readable phrases with generous empty space;
- phrase-led cuts that follow the narration;
- a brief blur plus short upward or sideways entry on important phrases;
- simple creator metaphors, such as five account rows, twenty post tiles, one post beating an account's usual result, a three-question checklist, and an idea-plus-experience formula;
- passive branding during the educational body;
- no logo during the final conversion line when the established reference does the same;
- no separate branded end card.

Useful animation starting points at 24 fps:

- 8 to 10 frames for the primary entry;
- 12 to 22 px initial blur;
- 24 to 40 px vertical or horizontal travel;
- cubic ease-out with no bounce;
- stagger related items by the spoken phrase, not a fixed decorative interval.

Do not apply blur to every object. Use it to reveal a new thought or soften a phrase transition. Ensure critical opening text is readable by the first spoken word.

### Avoid the AI-generated look

Reject these before rendering:

- dense network diagrams;
- dashboards and unexplained metrics;
- four-card or six-card grids used only to fill the screen;
- abstract labels such as `signal`, `baseline`, or `outlier` in consumer-facing scenes;
- identical card animations repeated through the whole Reel;
- perfectly symmetrical layouts with no editorial hierarchy;
- procedural music or synthetic UI visuals that feel like a software demo when the reference is editorial.

A few simple visual metaphors are enough: tabs piling up, one post clearly outperforming two others, three phrase cards appearing in sequence, one clean script page, and two plain outcome lines.

## 6. Music and sound design

When the user asks for music like previous videos, inspect and reuse an approved internal music stem when rights and series fit allow. Otherwise choose a licensed track with similar energy. Do not default to a bare procedural pulse merely because it is easy to generate.

- Match the reference's energy and emotional role, not just its BPM.
- Keep the voice as the loudness leader.
- Duck music under speech, then audition on a phone speaker.
- Use two to five purposeful SFX at most.
- Place whooshes on visible movement and impacts on genuine reveals.
- Do not place SFX over word attacks or consonant tails.
- Preserve the approved music stem separately from the final mix.

A procedural bed is a fallback for rights-safe prototyping. It requires human audition and should be replaced if it feels synthetic, bland, or unlike the approved series.

## 7. Required production gates

1. Save the verified claims separately from the spoken script.
2. Humanize the script and perform a jargon pass.
3. Audition a short voice sample before full motion work.
4. Generate and master the approved full voice.
5. Derive phrase timing from that voice.
6. Build phone-scale static mockups using the approved reference grammar.
7. Render a full-duration half-resolution preview.
8. Build a half-second contact sheet and inspect every reveal.
9. Create and audition the final audio mix on phone speakers.
10. Render the full-resolution silent master.
11. Mux final audio without shortening the approved video stream.
12. Decode the exact delivered MP4 and count decoded frames.
13. Measure final AAC loudness and true peak.
14. Re-transcribe final AAC audio.
15. Inspect exact keyframes and a new half-second contact sheet from the final bytes.

Target delivery:

- 1080x1920;
- 24 or 30 fps, matching the approved source family and motion cadence. The approved V3 original uses 30 fps;
- H.264, yuv420p-compatible;
- AAC, 48 kHz;
- approximately -16 LUFS;
- conservative true peak protection;
- stripped source metadata.

Do not use `-shortest` blindly during the final mux. A one-sample audio difference can remove the last video frame. Count the delivered frames and remux with an explicit duration or padded audio when needed.

## 8. Delivery note

State:

- what changed from the rejected or earlier draft;
- which product claims were verified;
- duration, frame count, loudness, peak, and decode result;
- what Shivank should eyeball on a phone.

The mandatory eyeball items are voice naturalness, music presence, text-entry feel, and whether the visual language resembles the approved reference family without copying it.
