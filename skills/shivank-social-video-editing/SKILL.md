---
name: shivank-social-video-editing
description: Apply Shivank's learned editing grammar to LinkedIn and Instagram Reels, founder videos, YC/Y-series edits, and institutional gratitude films, including hooks, captions, real B-roll, motion-first pacing, brand typography, official logos, exports, and manual QA.
---

# Shivank social video editing

Use this skill for Shivank's founder-led short-form videos and any edit that should match the previously approved Reel series.

## Creator-style boundary

This skill is for Shivank's visual grammar. Do not treat it as a universal founder-video preset.

- Selvam/Mindwise uses the separate `authority-trust-founder-reels` skill.
- Never carry Shivank's white/orange Arial, persistent horizontal hierarchy, hook behavior, punch cadence, or creator branding into Selvam/Mindwise unless the user explicitly asks for a hybrid.
- Feedback about one creator does not automatically modify another creator's style.
- Technical methods such as phrase-boundary cuts, conservative dialogue cleanup, metadata stripping, deterministic rendering, and manual QA may transfer. Visual taste and series identity may not.
- Record the creator and active style in the render plan before assembly. If the creator does not match this skill, stop and load the correct style skill.

Load `ai-video-editing-pipelines` for the deterministic media workflow and `distribution-retention-editing` for retention reasoning. This skill defines Shivank's current visual and editorial defaults.

## Core principles

1. Lead with a clear, source-supported claim.
2. Cut on phrase boundaries, not arbitrary time intervals.
3. Remove false starts, duplicated takes, filler, and long pauses only when grammar and human cadence remain natural.
4. Use real, claim-specific B-roll. Prefer supplied assets, original screenshots, official proof, event footage, and real working scenes. Never use stock-looking filler.
5. Use movement with purpose. Shivank expects jump cuts and visible punch-ins at emphasis beats.
6. Treat the full screen as one centered visual hierarchy. Do not center only the A-roll while captions, hook, or proof feel detached.
7. Every deliverable receives technical validation and manual phone-scale QA.

## Premium motion direction gate

Apply this before coding any new animation family, especially product launches and clean-room reference recreations.

- Before motion work, extract a compact reference DNA: palette, typography, spacing, composition, image treatment, depth or shadow, motion signature, transition grammar, and sound relationship. Record measured values and separately label subjective mood.
- Declare one motion personality per project. For premium launches, use elegant, controlled movement with zero overshoot as the default.
- Lock a signature easing curve for roughly 80 percent of movement, plus a three-value duration palette: quick, standard, and slow. A practical premium starting point is 0.35s, 0.50s, and 0.80s.
- Use directional easing: decelerate into entrances, accelerate out of exits, and use smooth ease-in-out curves for objects that remain on screen.
- Treat each beat as setup, action, and resolution. Leave roughly 100 to 200ms of visual stillness after the resolution before starting a new major beat.
- Keep one hero action at a time. With three or more animated elements, no more than about one third should be in active motion simultaneously.
- A move longer than one third of the frame needs an intermediate keyframe, speed change, or gentle arc. Do not send an object across the whole frame on one unbroken interpolation.
- Scale duration with travel distance. Long camera pushes need more time than short text entries.
- Use the minimum property set that communicates the move. Position plus opacity or scale is usually enough. Three or more competing transforms require explicit justification.
- Match perceived material: rigid furniture and typography use no bounce; paper may use a tiny 3 to 5 percent settle; smoke or blur can move more slowly; glass remains crisp with no overshoot.
- For coordinated scenes, share the same motion origin and easing family. Supporting layers may trail the hero by 50 to 150ms. Background counter-motion stays near 20 to 30 percent of hero displacement.
- Stable text geometry is mandatory. Reserve each glyph or word's final layout before revealing it. Never use changing substrings when that makes centered text reflow every frame.
- Product substitutions share one camera path. Cross the outgoing and incoming object with velocity-linked blur and preserve a common anchor. Never reset scale or transform origin at each cut.
- Motion blur is transitional, not ambient. Peak it around the velocity maximum and resolve fully before the reading hold.
- Diagnose cheap or jittery motion by checking for linear spatial interpolation, missing settle time, mixed easing families, opacity-only state changes, too many simultaneous elements, transform-origin resets, and scene wrappers that create blank handoffs.
- Performance is part of craft. Prefer transform and opacity. Use expensive blur or shadow only in short windows and verify the native-resolution render before final delivery.
- Quantify abruptness on unfamiliar builds with a frame-delta or optical-flow spike check, then inspect the exact spike frames. Metrics support viewing, never replace it.

These rules adapt the strongest transferable ideas from LottieFiles `motion-design-skill`, GSAP choreography guidance, and measured reference reconstruction. They are not permission to add decorative UI motion to every edit.

For the complete cue matrix, intensity hierarchy, whoosh-hit anatomy, audition protocol, local library paths, blacklist, and tutorial evidence, read `references/sfx-selection-and-placement.md` before designing a new SFX pass.

Before building audio, copy `templates/sfx-cue-sheet.json`, state one distinct editorial role per cue, then run `python scripts/validate_sfx_cue_sheet.py <cue-sheet.json>`. Resolve all errors. Manually review every warning about dense stacks, repeated waveforms, missing roles, or closely spaced hero cues. The validator is a preflight, not a substitute for listening.

## Hook and pacing rules

- Produce two or three meaningfully different hook variants when the source supports them.
- Reuse one approved body timeline across variants.
- Recalculate all downstream captions, B-roll, logo, and zoom timing from each hook's exact duration.
- Protect the first useful word and final consonant tail.
- Every video starts with a bold text hook visible during the first three seconds. Place it at the top over the A-roll, inside the platform safe zone, clearly readable, and never covering the speaker's face.
- The first second must communicate the topic or tension through the spoken line, text hook, logo, proof, or a deliberate combination.
- A relevant official or supplied logo may appear near the opening when it strengthens recognition or curiosity. Keep it subordinate to the claim.
- Do not add random motion every few seconds. Each cut, zoom, caption highlight, or B-roll change must support a spoken beat.

## Visual cadence and mockup gate

Before assigning visuals, classify each spoken section as hook or connection, proof, explanation, breather, or payoff.

- Hook and breather sections usually preserve clean A-roll and captions.
- Proof sections use real screenshots, products, events, official sources, or supplied evidence.
- Explanation sections receive diagrams or restrained animation only when the idea remains abstract.
- Payoff sections use the strongest A-roll, proof, or restrained emphasis treatment.
- Approve a phone-scale static mockup before spending time on a new animation family.
- Reject generic AI imagery, synthetic stock-looking scenes, invented proof, inconsistent characters, or motion with baked, uncontrollable music and SFX.
- Keep A-roll, captions, proof, motion, SFX, and music separately editable through final assembly.

Follow `references/visual-cadence-and-mockup-gates.md` for the planning fields, reference priority, learning rationale, and series boundaries.

### Reference recreations and Octupie brand alignment

For public LinkedIn launch-film references, source separation, DOM media recovery, final-voice retiming, transition-blank prevention, and exact-frame audio mux repair, follow `references/public-linkedin-launch-recreations.md`.

When adapting a public motion-graphics reference to Shivank or Octupie branding:

- Match useful timing and information structure, but rebuild the graphics rather than embedding rendered reference frames.
- If a public Instagram Reel plays in the browser but the normal downloader returns an empty response, follow `references/instagram-public-reference-recovery.md` to recover and classify separate adaptive video and audio streams before muxing a local analysis master.
- Audit the live first-party brand source before styling. For Octupie, use its current paper, ink, blue accent, Geist typography, hairlines, grid, and restrained hard-shadow language.
- Keep branding restrained. Do not add persistent top-corner system labels, a bottom-corner website URL, or a separate branded end card unless Shivank explicitly requests them.
- For Octupie motion-graphics remakes, place the small official icon plus lower-case wordmark in the top-right by default, not the bottom-left. Use a measured inset, keep it clear of headings, tables, and platform UI, and verify it on both paper and blue scenes. Hide it during the final spoken payoff unless Shivank explicitly asks for persistent branding. Preserve the final message instead of adding an extra company card.
- Treat mixed-style inline text as layout, not plain copy. Use explicit flex rows or wrapped rows with numeric gaps between spans. Never rely on JSX whitespace when font style, weight, size, or negative tracking changes inside a sentence.
- Inspect every mixed-style sentence at its exact rendered frame. Watch especially for emphasis words touching adjacent copy and for `Story`, `and`, `Meaning`, or trailing words collapsing together.
- After removing labels, URLs, or an end card, rerender and inspect exact final-composite frames plus a half-second timeline sheet. Source-code removal alone is not proof.

See `references/octupie-motion-graphics-brand-system.md` for the tested palette, spacing, restraint, remux, and QA recipe.

When building an original Octupie Reel from only a topic, audience, and CTA, verify current product claims before scripting, then translate them into plain creator language. Lead with useful creator education, not a product pitch. Teach a complete method or decision rule through roughly the first 70 to 80 percent, then introduce Octupie near the end as the faster way to apply what the viewer has already learned. Product terms such as `baseline`, `outlier`, and `signal` belong in research notes unless the audience already uses them.

The approved V3 benchmark teaches a useful manual research method until about 77 percent of runtime, then presents Octupie as the faster implementation and closes with a short CTA. Treat that value-to-product ratio as the default for new Octupie briefs. Passive series branding may remain during the teaching section, but product narration, product diagrams, access language, and conversion framing may not begin early.

The established three-recreation Octupie family is the visual source of truth unless Shivank explicitly changes it: Geist Variable only, paper `#F7F5F0`, blue `#014CE3`, ink `#111111`, paper-2 `#EDEAE3`, faint 180-pixel vertical columns, blue italic emphasis, thin borders, restrained 7-pixel hard shadows, and a small official logo plus lower-case wordmark in the established corner position. Do not introduce a new serif, glossy SaaS cards, rounded dashboard styling, or another brand system merely because the Reel is original.

Study the previous approved Orate-style videos and the existing recreation components before designing. Match their phrase-led pacing, audible music role, information density, and restrained blur or slide entries without copying source branding. Audition voice naturalness before building the full motion timeline. Generic system neural voices, inaudible music, bare procedural beds, dense diagrams, repeated card grids, hard selling from the opening, and unexplained metrics are rejection risks even when technically correct. Follow `references/original-octupie-reels-from-brief.md` for the complete value-first script, natural local voice, established-brand motion, audible music, SFX, and final-QA workflow.

### Explicit Octupie product-launch teasers

Do not apply the value-first educational ratio blindly to an explicit product-launch, feature-reveal, or SaaS teaser brief. A launch teaser may introduce Octupie immediately and remain product-led throughout, provided every capability is current and verified.

- Match the master aspect ratio to the supplied reference and placement. A landscape launch reference supports a 1920x1080 master instead of the normal vertical social preset.
- Match the reference's natural duration and complete narrative structure unless Shivank requests a shorter cut. If he asks to recreate a 45 to 90 second promo without another duration, do not silently compress it into the normal 25 to 35 second teaser preset.
- Inspect both the exact inspiration and several videos from the same studio or channel. Extract recurring typography, UI choreography, pacing, transition, and sound grammar rather than copying one film's frames or soundtrack.
- Build a timestamped mapping from each reference scene's communication job to one verified Octupie truth before coding the composition.
- A text-led teaser with no narration is valid when music, SFX, typography, and UI motion carry the story.
- Prefer current first-party product source and live website states over an older screen recording with retired UI. Rebuild accurate UI states deterministically only when current sources support every visible claim.
- If a supplied asset folder requires sign-in, continue from sufficient verified local official assets and disclose that substitution. Do not claim the inaccessible package was reviewed.
- Alternate sparse promise scenes with one-capability product proof, then simplify into a short logo and launch-status lockup.
- The normal Octupie hairline and grid language is not mandatory in a cinematic promo recreation. When lines, axes, rules, or placeholder bars make the film feel like a presentation, remove them and carry brand identity through Geist, paper, ink, blue, luminous shape fields, real copy, and moving product states instead.
- Ensure frame 0 contains intentional visible content. Do not let a generic fade wrapper create a blank opening flash.
- Measure true peak after final AAC encoding. AAC may overshoot the WAV target. If needed, lower the original mix and remux with video stream copy, then rerun QA on the exact delivered bytes.

For Octupie manifesto and launch-film revisions, treat `generic`, `AI-generated`, `repetitive`, and `no craft` as structural failure signals, not polish notes.

- Replace a generic voice before rebuilding motion. Use a human recording when available. A local natural TTS fallback still requires a short cadence audition and must be disclosed as synthetic.
- Increase key landscape manifesto copy to a deliberately cinematic hierarchy. Do not inherit small caption or deck-body sizes.
- Use blur reveals, masked text entries, scale settles, and phrase-led jump replacements selectively. Avoid one repeated pop-in preset.
- Build an asset ledger before assembly. Do not reuse the same thumbnails or pictures as default filler. Fresh web research must be claim-specific, real, reviewed, and rights-flagged.
- Use big figure imagery or hero-scale moving footage on major emotional pivots. Alternate it with sparse copy, proof collages, kinetic full-screen footage, and breathing space.
- Every zoom, whip, or major visual jump needs a planned sound relationship. Land the whoosh or impact with the motion while keeping narration dominant.
- Review high-retention sections with dense motion strips, not only static keyframes. Confirm the zoom develops, the reveal becomes readable quickly, and no transition flash becomes an accidental blank.
- Preserve reference rhythm while changing target-brand content. Repetition visible in a contact sheet is a failed variation gate even when every asset is technically relevant.

For manifesto-specific asset-ledger, shot-grammar, narration, and motion-strip gates, load `ai-video-editing-pipelines` and follow `references/editorial-manifesto-reference-recreations.md`.

Follow `references/octupie-product-launch-teasers.md` for the reusable 25 to 35 second reference audit, truthful UI reconstruction, original soundtrack and SFX map, Remotion motion build, and final-master QA workflow. For full-length music-led SaaS recreations, also load `ai-video-editing-pipelines` and follow its `references/full-length-saas-promo-recreations.md` mapping, soundtrack, preview, and exact-master workflow.

For the complete public-Instagram recovery, source mapping, deterministic rebuild, preview gate, audio treatment, `-shortest` frame-count safeguard, and exact-master validation workflow, follow `references/octupie-public-reference-recreation-runbook.md`.

### Independent exact-reference reconstruction

When Shivank asks for the exact same edit, determine whether he means a source copy, an independently rendered reconstruction, or a brand adaptation. These are different deliverables.

- If he says to render it using your own skills, never answer by copying, remuxing, or re-encoding the recovered source.
- Lock dimensions, frame rate, decoded frame count, duration, and persistent player or breakdown chrome before rebuilding.
- Use dense motion strips, usually 4 fps or denser, rather than one-second contacts.
- Treat an independently rendered recreation as a clean-room build. The reference is measurement data only.
- Never reuse the reference's frames, crops, clips, snapshots, UI panels, photographic regions, album art, soundtrack, narration, or SFX. Do not hide reuse behind a new encode, animated crop, composited still, or screenshot sequence.
- Rebuild the timeline as editable coded layers and use only generated, procedurally created, separately sourced rights-cleared, or user-supplied non-reference assets.
- If the same photographed subject or artwork is required, locate the original rights-cleared asset separately. Do not extract it from the reference.
- If an image or voice generator is unavailable, switch to procedural generation, another configured generator, or request an asset. Never fall back to harvesting the reference.
- Keep an asset provenance ledger with one of: coded, procedurally generated, generated model and prompt, user-supplied non-reference asset, or separately licensed source.
- Before rendering, search the composition and public asset tree for reference filenames, snapshot directories, extracted crops, video/audio embeds, and suspicious aliases. A different output hash alone does not prove independence.
- Delete contaminated previews and copied-source deliverables before final handoff so they cannot be mistaken for the clean-room master.
- Verify that the independent render hash differs from the reference hash.
- Use SSIM or PSNR only as directional iteration metrics. Pair them with exact-frame visual review. Do not improve the score by importing source pixels.
- Never call a reconstruction pixel-identical unless decoded frame comparison actually proves it.

Follow `references/exact-reference-reconstruction.md` for the complete interpretation gate, dense analysis method, layered rebuild, comparison loop, disclosure rules, and common failures.

## Jump cuts and punch-ins

Jump cuts and punch-ins are a default planning step, not an optional polish pass.

Good punch-in targets include:

- the contradiction or risk;
- a high-stakes noun or number;
- `permission to fail` style consequence lines;
- a decisive `this has to work` statement;
- the final mindset, company, or payoff line.

Implementation default:

- Start from the full 1080x608 landscape frame.
- Use a centered 1.08x to 1.12x punch-in for selected phrase windows.
- Enter and leave as direct visual cuts when emphasis is intended.
- Keep each state long enough to register, usually around one phrase rather than one word flash.
- Return to the full frame between distinct emphasis beats.
- Merge nearby emphasis words into one window to avoid flicker.
- Skip or hide a punch-in when B-roll already provides the pattern change.
- Inspect face, hair, hands, props, and evidence at the frame before and after every zoom boundary.

## Persistent-hook landscape preset

Use this for the approved LinkedIn/Instagram landscape Reel format.

- Canvas: black, 1080x1920.
- Hook: persistent above the media, centered near y=640.
- Hook font: Arial Bold, white with selective orange emphasis.
- A-roll: full horizontal 1080x608 at y=680.
- Normal captions: Arial Bold, one line, 1 to 3 words, near y=1335.
- Safe-zone model: no important caption or hook inside the top danger area around y<250 or the lower interface area around y>1580.
- Center the complete hook, media, and caption hierarchy vertically.
- Keep the hook visible during A-roll and B-roll when the user requests a persistent-hook version.

### Same-slot B-roll

This is the preferred treatment for landscape photos and real B-roll in the current format.

- Replace the A-roll inside the exact 1080x608 media slot.
- Crop with cover behavior when needed. Do not stretch.
- Keep captions directly below at the normal y=1335 band.
- Use a black matte for the complete slot so no moving A-roll strips remain.
- For a transparent logo, keep the 1080x608 black slot and place a smaller centered logo inside it.
- A supplied campus, company, or product logo can open the Reel briefly even when the spoken brand mention comes slightly later, if it improves recognition without delaying the claim.

### Tall proof-card exception

Use a taller proof treatment only when a screenshot would become unreadable in the 1080x608 slot.

- Preserve the persistent hook above.
- Scale or crop the screenshot so its author, claim, and proof remain readable at phone size.
- Move captions lower only if needed, while keeping them above the verified platform danger boundary.
- Inspect for thin A-roll strips, proof-caption overlap, and unreadable text.

## YC and Y-series rules

YC/Y-series edits have stricter brand continuity:

- Use the verified official YC logo, never a generated approximation.
- Use white and orange Arial captions.
- Keep A-roll unobstructed. B-roll must not cover the speaker unless the explicitly approved persistent-hook landscape preset replaces the entire A-roll slot.
- Use the prior series hierarchy and measured coordinates before inventing a new design.
- Proof cards, screenshots, and headline/logo visibility must use one shared timing model.
- Restore hidden series elements only after the last B-roll frame exits.
- Ownership wording and exact terminology must remain consistent across all variants.

## Captions and terminology

- One line, 1 to 3 words per card.
- Group by meaning, punctuation, and edit boundaries. Never bridge unrelated phrases merely to fill three words.
- Use white text with selective orange emphasis on important names, stakes, numbers, failure, proof, or company terms.
- Do not use a visible outline or hard stroke around captions. Use a slight soft drop shadow only when contrast is needed.
- Choose caption color from the actual rendered background, not a global preset: white on dark footage, black on cream or bright proof graphics. A shadow cannot rescue white text on a pale card.
- Build a soft shadow as a separate low-opacity blurred text layer when the renderer's native shadow looks hard or outline-like.
- Keep captions close to the media and out of Instagram interface danger zones.
- Correct terminology in the source-of-truth data, not only in the burned render.
- Build caption timing from word timestamps on the assembled clean dialogue timeline. Never distribute cards proportionally across a clip by word count or character count. That can make cards appear early, late, or skipped.
- Maintain exact token coverage when the active series expects full captions: every approved spoken token belongs to one card, in order, with no overlap. Re-transcribe and rebuild captions after any dialogue EDL change.
- Start each card at the first word onset or with a restrained 20 to 50 ms lead, then hold through the final word tail. Preserve real blank pauses rather than stretching stale text.
- Regroup any card that would hold for less than about 0.35 seconds. Keep the one-to-three-word limit while improving semantic grouping.
- Treat caption animation as part of sync. A blur or travel entry can make a correctly timestamped short command feel delayed. For a critical opening phrase, make it static or ensure it is fully readable by the spoken onset.

When Shivank corrects a term, propagate it through:

1. transcript text;
2. word token;
3. caption groups;
4. SRT and ASS files;
5. edit plan and proof labels;
6. every hook variant;
7. validators and exact-frame QA.

Current canonical spelling: `Octupie`.

Do not trust ASR blindly for proper nouns or decisive claims. Examples from prior work include corrections such as `trap` versus `drop/drug`, `interns` versus `intents`, and `fail` versus `feel/pay`.

## B-roll selection and timing

- Prefer supplied assets before web sourcing.
- If written instructions mention a required shot that is absent from the nominal source, inspect sibling clips supplied in the same project folder before declaring it missing. Keep the requested clip as the spoken master, use only the required visual from the sibling as B-roll, and record the cross-source use in the render plan.
- Show B-roll on the exact concept it proves: a logo on the institution mention, internship images on intern lines, a working-computer image on a repetitive-work or loop line.
- Use B-roll to mask an otherwise visible phrase-boundary jump when the timing naturally aligns.
- Keep B-roll long enough to read but not so long that the speaker disappears without reason.
- In YC edits where the speaker must remain visible, place wide screenshot proof in the dedicated upper proof region and temporarily replace the logo/headline there. Keep A-roll visible in its media slot. Restore the logo/headline only after the proof exits.
- A supplied phone-reveal take may replace the A-roll inside the media slot when the speaker and phone both remain visible.
- Add a short fade only when it helps. Do not crossfade between mismatched takes when faces or props occupy different positions, because it creates a double-image. Prefer a direct phrase-boundary cut.
- Inspect exact first, midpoint, last, and return-to-A-roll frames in the rendered composite, not only the isolated asset.
- For split-screen proof, reserve a continuous face-safe zone. Reposition or scale A-roll so the complete face remains visible below or beside the proof for the whole interval. A correct first frame is not enough.

See `references/cross-source-proof-and-overlay-timing.md` for a tested source-reconciliation and delayed-overlay recipe.

## Audio and source handling

- Preserve source media unchanged.
- Probe rotation, dimensions, frame rate, color transfer, audio sample rate, and privacy metadata before editing.
- For prompted founder recordings, use word-timed ASR plus visual or listening review to separate founder responses from crew guidance. ASR alone does not identify the speaker.
- When a duplicate occurs inside one ASR segment, split the source range around the repeated word. Caption correction is not an audio edit.
- Re-transcribe the cleaned founder-only timeline. Check for clipped first words, clipped consonant tails, hidden repetitions, and script drift before designing captions.
- Convert iPhone HLG/Dolby Vision material to tagged BT.709 before social delivery.
- When writing an 8-bit FFV1 working file after HDR tone mapping, explicitly add `format=yuv420p` before the FFV1 encoder. Do not assume the tone-mapping chain will leave a compatible pixel format.
- Use visually lossless intermediates such as FFV1 when repeated source decoding slows iteration.
- Apply tiny fades around audio phrase cuts to prevent clicks.
- Dialogue default: high-pass filtered, conservatively denoised, lightly compressed, and resampled to 48 kHz. Compare raw and cleaned speech. Preserve natural room tone rather than producing watery, metallic, gated, or robotic speech.
- Final dialogue target: approximately -16 LUFS, with true peak protection around -1.5 dBTP.
- Music is not automatic. Add it only when requested or when the approved series clearly uses it.
- Verify music rights before rendering. Reject NonCommercial tracks for commercial work and treat NoDerivatives tracks as unsafe for synchronization unless separately licensed. Save the license and source URL beside the asset.
- Public YouTube and official-institution footage is not automatically cleared for reuse. Flag permission requirements or replace it before public delivery.

For the full older-founder workflow, conservative FFmpeg starting filters, caption correction order, proof-card transitions, and rights checks, see `references/founder-dialogue-restoration-and-proof-cards.md`.

## Dialogue-first sound design

Use SFX to clarify attention, motion, or story. Do not use them to fill every cut.

- Choose SFX by function and visible scale. Diegetic or Foley sounds establish reality. Whooshes describe actual velocity. Risers create anticipation before a meaningful reveal. Impacts mark a real landing or major narrative punctuation. UI sounds confirm a visible state change. Silence creates contrast.
- Every designed cue needs an intensity label: texture, support, or hero. Ordinary transitions stay at texture or support. Reserve hero stacks for the single largest payoff.
- Build a whoosh-hit as approach, transient, body, and tail. Each layer needs a distinct job and frequency range. Align the transient to the exact landing frame, keep the approach quieter than the landing, and clear the tail before the next important beat.
- Never stack a whoosh, riser, heavy impact, and tick by default. Start with one sound. Add another only when the first cannot communicate a separate necessary function.
- Reject cues whose perceived mass, tone, or acoustic space does not match the visual. A furniture substitution or clean product reveal must not receive a horror, trailer, vocal-like, distorted, or oversized impact.
- Blacklisted asset: `impact_ultra_serious_48k_pcm24.wav`. Shivank rejected its use around 0:33 in The Oblist V2. Do not use it again, including pitched, stretched, layered, or renamed derivatives.
- Vary repeated physical actions with alternate takes or separate regions from one recording. Do not reuse the identical waveform for every occurrence.
- Audition every new SFX isolated, with music, and in the final encoded mix. Reject any sound that becomes strange, vocal-like, abrasive, comic, or disproportionately prominent in context.
- Layer by function: context, anticipation or movement, then landing or texture.
- Most moments use one layer. Important reveals may use two. Reserve three-layer stacks for one major hook or payoff.
- Land impacts on the visual event or in the space after a key word. Never mask the word's first or final consonant.
- Start whooshes with visible motion and end them when it settles. Static text changes do not need whooshes.
- Make risers peak at the reveal. Do not build anticipation for ordinary information.
- Pre-lap only relevant off-screen sound that predicts or explains the next visual.
- EQ effects around dialogue. Keep the voice as the loudness and attention leader.
- Pan only clear lateral motion, keep it moderate, preserve a centered layer, and test in mono.
- For a normal 30 to 60 second founder reel, begin with two to five purposeful events and usually no more than one major stack.
- Do not add SFX automatically to approved Selvam/Mindwise or YC/Y-series edits.

Use the curated library under `<sfx-library>\edit_ready_48k`. Follow `references/dialogue-first-sfx-grammar.md` for asset-specific gain starting points, timing, planning fields, and QA.

## Institutional gratitude and alumni films

Use a gratitude-first hierarchy for alumni, donor, sponsor, university, and team-support films.

- Make `THANK YOU` the opening and closing idea when gratitude is the requested purpose.
- Use engineering, competition, destination, and campaign language as supporting proof. Do not let it become visually louder than the acknowledgment.
- Make the timeline video-led. Long portrait mosaics, repeated split cards, and slow photo holds read as a slideshow even when they have minor zooms or dissolves. Use real work, coordination, testing, and flight footage for most of the runtime.
- Use still images as short punctuation between moving sequences. Keep faces and team rows unobstructed. Do not place headcount labels, campaign copy, or large captions over a portrait grid or group photograph.
- Show current team scale early with real group images and active wide workshop footage. One late group shot is insufficient, but a long static mosaic is not a substitute for moving team-scale proof.
- Put essential text in a verified high-contrast region. Prefer a controlled navy band, dark gradient, or dedicated negative-space zone. Check the complete moving background, because text that passes on one sampled frame can disappear half a second later.
- Distinguish current campaign preparation from prior competition footage. A current download date does not establish the capture year.
- Audit the official website before designing. Reuse its real font, colors, spacing, image treatment, and headline hierarchy instead of inventing floating cards or generic AI-style interface elements.
- Use the official institution logo when requested. Rasterize the supplied official SVG or use an official first-party PNG, preserve transparency, and reserve enough end-card size for phone readability.
- Prefer brand expression through typography, whitespace, restrained bands, and real imagery. Remove persistent corner badges or logo pills when they compete with the message or feel visually pasted on.
- When the user explicitly names a font, verify the real requested font file, rendered glyph appearance, family, and weight. A loaded font file is not proof. Inspect the ASS or libass `fontselect` result and reject fallback output.
- After a slideshow complaint, quantify motion as a QA signal in addition to watching the cut. Report moving-frame coverage by segment, while treating intentional brief stills and the final gratitude hold as valid exceptions.
- Count decoded video frames as well as container duration. Static-image overlay chains can end the video stream early while audio keeps the file duration apparently correct.
- Use half-second or denser transition sheets after source-range changes. One-second contacts can miss a stray telemetry frame, source title, stale logo, or momentary contrast failure.

Follow `references/institutional-gratitude-films.md` for a tested motion-first structure, unobstructed-photo rule, current-year source audit, website-brand extraction, official-logo handling, Satoshi verification, contrast gates, exact-frame checks, and the SUAS 2026 revision example.

## Export and privacy

Default social master:

- 1080x1920;
- H.264 High Profile;
- yuv420p;
- 24 fps when matching the source series;
- AAC, 48 kHz, about 192 kbps;
- fast-start MP4;
- one avoidable lossy generation at most.

Strip inherited camera metadata with `-map_metadata -1 -map_metadata:s -1`. Phone clips may contain GPS coordinates, device model, and creation details. Verify the delivered MP4 has no location metadata.

## Human-aware vision QA

For unfamiliar framing or any overlay that may approach the speaker, run the local editor's optional HyperFrames-backed probe before final placement:

```bash
claude-editor vision-qa VIDEO --output REVIEW_DIR --start SEC --duration 1 --fps 4 --width 360
```

Use it as a proposal layer only. It provides local human segmentation, temporal subject occupancy, candidate clean rectangles, and luminance warnings. Inspect `vision-overlay.png` with vision and at phone size before accepting a region. Human segmentation can miss laptops, phones, microphones, screens, furniture, hands, and held proof. A prop-blind rectangle is never automatic approval.

The Windows path uses a temporary ProRes 4444 MOV matte. VP9 WebM alpha may decode as opaque and produce a false 100 percent subject-coverage result.

Keep HyperFrames as a selective analysis and motion-graphics layer. The established FFmpeg pipeline remains responsible for phrase cuts, hook/body retiming, punch-ins, B-roll, captions, audio, and final delivery.

## Required QA gates

### Editorial

- Strongest complete take selected.
- False starts and duplicated lines removed.
- Every join remains grammatical when listening without video.
- Hook and body make the same promise.
- Punch-ins support emphasis and do not feel random.
- B-roll proves or clarifies the spoken line.

### Layout

- Full hierarchy is vertically centered.
- Persistent hook remains visible where requested.
- Media is not stretched.
- Same-slot B-roll is exactly 1080x608.
- Captions stay within the safe band.
- No logo, hook, caption, speaker, or proof collision.

### Captions

- Maximum three words per card.
- Correct proper nouns and company names.
- No deleted dialogue remains.
- Corrected terms are present in every variant.
- Final company/payoff card is visibly complete.

### Technical

- Full decode with no fatal errors.
- 1080x1920, H.264, yuv420p.
- Expected frame rate and duration.
- AAC 48 kHz audio.
- Integrated loudness near -16 LUFS.
- BT.709 tags present for converted HDR sources.
- No GPS or source camera metadata.
- Output file exists and is playable.
- The validator must be executed against the final master and return a passing report before delivery. Writing a validator or rendering successfully is not equivalent to passing technical QA.
- Any repaired overlay or timing bug requires exact-frame reinspection in the final composite before delivery.

### Manual phone-scale pass

Inspect:

- first frame and first spoken word;
- logo opening;
- every B-roll boundary;
- normal frame before each punch-in;
- punch-in midpoint and return frame;
- low-confidence corrected captions;
- final company/payoff card;
- final word and ending hold;
- full contact sheet for black frames, strips, drift, and attention dead zones.

The delivery note must state what was checked and what Shivank should eyeball inside Instagram before posting.

## Common failures learned from prior edits

1. Static A-roll with no emphasis changes. Fix: plan punch-in windows before the first proof render.
2. B-roll filling the vertical canvas and hiding the persistent hook. Fix: constrain it to the approved media or proof region and compose captions last.
3. B-roll narrower than A-roll, leaving moving side strips. Fix: use a full-slot matte and exact-width crop.
4. Captions pushed into Instagram's lower interface zone. Fix: validate y positions numerically and inspect a phone-scale frame.
5. Correcting only visible subtitles. Fix: update transcript words, grouped captions, plans, and all variants.
6. Using an approximate logo. Fix: locate and hash the official asset.
7. ASR preserving false terminology. Fix: verify names and claims against the user's correction and source context.
8. Duplicated spoken phrases hidden inside an ASR timing span. Fix: retranscribe the clean cut, inspect word timing, and recut the source range.
9. Exporting inherited phone metadata. Fix: strip metadata and assert that no location tag remains. Inspect actual format and stream tag keys, not arbitrary FFprobe field names. `chroma_location` is a normal color-sampling field and is not GPS metadata.
10. Trusting coarse contact sheets alone. Fix: inspect exact high-resolution frames around every state boundary.
11. Assuming an instruction-referenced shot must be in the named source. Fix: inspect supplied sibling clips, then borrow only the missing visual while preserving the requested spoken master.
12. A delayed short overlay silently failing because its input timestamps ended near zero. Fix: shift the overlay input to its destination time with input-level `-itsoffset` or an explicitly verified PTS transform, then inspect a composite frame inside the window.
13. Fading between mismatched A-roll and B-roll faces. Fix: use a direct phrase-boundary cut or a transition that does not produce a double-exposed face. For full-screen proof cards, do not alpha-fade over visible A-roll when the founder remains ghosted underneath.
14. Reporting QA after only creating the validator. Fix: execute it on the final master, require a pass, and save the report before delivery.
15. Correcting a proper noun only after caption grouping. Fix: normalize word tokens before creating one-to-three-word cards, then search the generated SRT and ASS for rejected variants.
16. Using a strong portrait-video vignette without edge inspection. Fix: inspect all four edges at full resolution; remove any filter that creates black elliptical arcs or crescents.
17. Ending on the last speech sample. Fix: when the source feels abrupt, preserve an intentional clean-frame hold of roughly 0.3 to 0.6 seconds after the last word.
18. Treating a public or official web video as automatically reusable. Fix: verify the license, record attribution or permission requirements, and flag uncleared footage before public posting.
19. Freezing the end after subtitle burn-in. Fix: apply the clean-frame hold before the subtitle filter so the final ASS event can expire instead of being cloned into the hold.
20. Trusting a B-roll label instead of the selected pixels. Fix: inspect first, midpoint, and last frames at the exact source offset; replace any semantically wrong opening, such as a reporter where the claim requires the actual plant.
21. Using substring validation for words or metadata. Fix: match complete caption tokens and actual metadata tag keys so valid values such as `laboratory` and `chroma_location` do not produce false failures.
22. Hard-coding downstream timeline windows after an EDL revision. Fix: derive B-roll, punch-ins, captions, fades, and output duration from cumulative cleaned-clip timing, then regenerate all plans.
23. Accepting a voice because ASR is correct. Fix: audition a short sample for natural cadence before motion work; intelligibility is not naturalness.
24. Reading internal product terms to a general creator. Fix: keep verified mechanisms in research notes, then translate them into ordinary spoken language before synthesis.
25. Designing an original motion Reel before studying the approved references. Fix: extract their typography rhythm, blur or slide behavior, information density, color cadence, and music role first, then rebuild those principles in the current brand.
26. Using dense diagrams, repeated card grids, or a procedural pulse because they are easy to generate. Fix: use one clear idea per screen, a few familiar metaphors, and approved or licensed music that fits the established series.
27. Introducing Octupie from the opening and calling the result value-led. Fix: teach a complete, immediately usable creator method first. Keep product explanation and conversion language near the final 20 to 30 percent, where Octupie becomes the easier way to apply the lesson.
28. Treating an original topic as permission to redesign the established Octupie identity. Fix: inspect the three approved recreation components, lock their exact fonts, palette, grid, logo placement, borders, shadows, and phrase motion in the render plan, then innovate only inside that system.
29. Reporting that music exists when viewers cannot perceive it. Fix: audition the full encoded mix on a phone speaker, compare a music-muted version, and require the intended rhythmic or emotional lift to remain obvious without masking speech. Raise or replace the bed when it is technically present but perceptually absent.
30. Using ASR success as proof of a human-sounding generated voice. Fix: audition the opening and one long sentence for breath, emphasis, pause variation, and over-enunciation. Regenerate with a stronger voice model or human recording before timing motion.

## Future learning loop

Treat every completed edit, reference, and human-edited example as evidence about why an editing choice works, not as a template to copy. Extract transferable principles such as hook construction, information density, phrase timing, proof selection, motion motivation, visual hierarchy, sound placement, and payoff structure. Apply a learned technique only when it serves the current script, footage, audience, creator identity, tone, and platform. Preserve useful lessons while rejecting reference choices that would reduce clarity, trust, safety, or series continuity.

After Shivank gives feedback:

1. Identify whether it is a stable preference, series-specific rule, or one-video correction.
2. Save stable preferences in memory.
3. Save reusable procedures and validators in this skill.
4. Update the current project's source transcript, build script, and tests.
5. Rerender every affected hook variant.
6. Verify the correction at exact frames before delivery.
