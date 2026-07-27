# Independent exact-reference reconstruction

Use this when Shivank asks to recreate a reference exactly, frame by frame, but explicitly rejects receiving the original file or a simple remux.

## Interpret the request correctly

Separate three different deliverables before building:

1. **Exact source copy:** byte-identical delivery of the recovered source.
2. **Independent reconstruction:** a newly rendered timeline that follows the reference shot by shot.
3. **Brand adaptation:** the reference grammar rebuilt around another product, creator, or script.

Do not substitute one for another. If the user says “render it yourself,” a copied, remuxed, or re-encoded source is a failed deliverable.

An independent reconstruction cannot honestly be called pixel-identical unless every decoded frame is identical. Recreated type, UI, gradients, footage, easing, antialiasing, compression, and audio will otherwise differ. Say “independent reconstruction” and report measured similarity instead of claiming exactness.

## Reconstruction workflow

### 1. Lock the reference contract

Record:

- width and height;
- frame rate;
- decoded frame count;
- exact duration;
- audio sample rate and channel count;
- whether visible player, timeline, caption, or breakdown chrome is part of the actual video.

Hash the reference. The final independent render must have a different hash. A matching hash proves a copy, not a recreation.

### 2. Analyze motion densely

Create chronological strips at 4 fps, or denser when transitions happen faster than 250 ms. Split long references into 8 to 12 second strips so individual states stay legible.

For each phase, record:

- start and end frame;
- background and material state;
- text and glyph geometry;
- viewport coordinates;
- UI hierarchy;
- asset bounds;
- scale, translation, opacity, blur, mask, and easing;
- transition overlap;
- audio event.

Do not rely on one-second contact sheets for an “exact” request. They miss glyph morphs, wipe shapes, and intermediate UI states.

### 3. Rebuild layers, not screenshots

Separate the composition into stable layers:

- outer canvas or analysis chrome;
- inner content viewport;
- logo and typography system;
- background material and grid;
- product UI;
- image or video montage;
- transition masks;
- audio.

Rebuild motion, UI, typography, materials, imagery, and transitions with code or independently created editable assets. Do not place any part of the reference video or its decoded frames into the render.

For Shivank's clean-room recreations, the ban includes partial and disguised reuse:

- no full frames, screenshots, snapshots, or frame sequences;
- no cropped UI cards, panels, logos, album art, or photographic regions;
- no source clip used as a texture, mask, reflection, blur, background, or transition layer;
- no reference narration, music, ambience, or SFX;
- no re-encode, remux, animated crop, or compositing trick that still carries source pixels or samples.

If matching photographed subjects or artwork matters, obtain or generate an independent replacement. Separately sourced assets need a rights record. If generation is unavailable, create a procedural substitute or request the missing asset rather than harvesting the reference.

### 4. Recreate audio independently

Treat transcript, phrase timing, and event timing as reference measurements. Recreate the sound from independent sources:

- synthesize or record new narration from the approved transcript;
- compose or synthesize a new score with similar energy and section lifts;
- generate or use independently licensed SFX aligned to measured events;
- match duration, pauses, emphasis, loudness, and transition timing without copying source samples.

Do not preserve the reference soundtrack merely to improve synchronization or similarity. If Shivank explicitly requests original audio reuse as a separate deliverable, label that file as containing reference audio and do not call the complete audiovisual result clean-room or independently recreated.

### 4a. Maintain an asset provenance ledger

Every render dependency must have a provenance class:

- coded React, SVG, canvas, shader, or CSS;
- procedurally generated local asset;
- model-generated asset with prompt and provider recorded;
- user-supplied non-reference asset;
- separately sourced rights-cleared asset with URL and license.

Before the first preview and again before delivery, audit the component and public asset tree for reference filenames, extracted-frame folders, snapshot sequences, media embeds, and aliases. Inspect the actual dependency paths. A different final hash proves only that the bytes differ, not that the render is independent.

### 4b. Recover clean official e-commerce product assets

For product-launch recreations, use the brand's official public storefront before generating substitutes. Shopify product endpoints such as `/products/<handle>.js` often expose original CDN image URLs, titles, and variants without scraping rendered pages. Record the product page, direct CDN URL, download date, and SHA-256 before editing.

Build a labeled candidate contact sheet before choosing products. When the official image has a studio backdrop, isolate the object with `rembg` or an equivalent local segmentation tool. QA every cutout on the target background. Reject masks with retained wall patches, missing legs, or damaged thin geometry. Keep both the untouched official original and the derived transparent PNG in the ledger.

Use the exact official logo file when available. Do not redraw a brand wordmark unless the official asset cannot be sourced legitimately.

When muxing a frame-count-locked Remotion render, avoid `-shortest` if the encoded audio stream ends a few samples early. It can silently drop final video frames. Mux without `-shortest`, then re-probe decoded video frame count and stream durations.

### 5. Build motion as a system

For crafted product-launch motion, inspect the actual source code of suitable permissively licensed repositories, not only their README descriptions. Adapt techniques, do not paste a generic preset over every scene.

Useful clean-room patterns:

- **Frame-history motion blur:** layer a few prior deterministic frames with `Freeze`, low opacity, and small blur. Limit it to fast glyph, card, or wipe motion so the whole film does not look smeared.
- **Blur-scale transition:** entering content moves from about 0.9 scale and moderate blur to 1.0 and sharp; exiting content moves slightly beyond 1.0 and blurs. Drive it from the Remotion frame, never CSS transitions.
- **Damped card settle:** use high damping and controlled stiffness. Stagger by a few frames. Avoid toy-like bounce unless the reference visibly bounces.
- **Frame-driven UI state:** define interface states and event frames separately from presentation. Animate between states rather than crossfading screenshots.
- **Procedural material:** use deterministic SVG, canvas, noise, or generated textures with recorded seeds. Keep it editable and reproducible.

Prevent transition blanks. With exclusive scene switching, fading the outgoing scene to zero and starting the incoming scene at zero creates an accidental black gap. Either overlap scenes, start the incoming scene before the boundary, or keep full visual coverage through the cut. During rapid montage cuts, never reset the only visible panel to zero opacity. Inspect the exact boundary frame, one frame before, and one frame after.

### 6. Iterate with evidence

Render a complete V1 before polishing isolated frames. Compare it against the reference at identical geometry and timing.

Useful checks:

- frame count and duration;
- dense contact sheets;
- exact transition frames;
- SSIM and PSNR for directional comparison;
- hash difference from source;
- full decode.

SSIM is a progress metric, not proof of perceptual or editorial equivalence. A higher score can reward static dark backgrounds while important glyphs or UI remain wrong. Pair the number with human visual inspection.

After each pass, fix the largest chronological mismatches first:

1. wrong scene timing;
2. missing persistent chrome;
3. incorrect material scale or brightness;
4. wrong UI geometry;
5. incorrect transition mask;
6. typography and antialiasing differences.

### 7. Delivery language

State clearly:

- whether every visual frame was newly rendered;
- confirmation that zero reference frames, crops, clips, snapshots, or audio samples entered the render;
- the asset provenance ledger summary;
- source and final hashes;
- frame count and duration;
- measured similarity, if used;
- what remains non-identical.

Never claim pixel identity when the independently rendered frames are not pixel-identical.

## Common failures

- Sending the recovered source after the user asked for a new render.
- Calling a brand adaptation an exact reconstruction.
- Rebuilding the content but forgetting visible timeline or player chrome.
- Using coarse one-second samples for sub-second glyph transitions.
- Reporting matching dimensions and duration as proof of matching frames.
- Reusing reference audio, UI crops, montage images, or snapshots because independent generation is harder.
- Treating a different output hash as proof of clean-room independence without auditing asset dependencies.
- Improving SSIM by importing source pixels instead of improving geometry, typography, timing, and motion.
- Falling back to reference harvesting when an image or voice generator is unavailable instead of using procedural generation, another configured provider, or requesting an asset.
- Leaving contaminated previews beside the clean master and later delivering the wrong file.
- Promising endless iteration without first defining what can and cannot be exact in a clean-room render.
