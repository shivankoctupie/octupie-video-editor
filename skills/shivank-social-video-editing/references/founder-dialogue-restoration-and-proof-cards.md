# Founder dialogue restoration and proof-card workflow

Use this reference for older founders, phone-recorded dialogue, prompted/script-repeat recordings, and evidence-heavy brand stories.

## Founder-only take isolation

1. Probe rotation, HDR transfer, audio channels, and privacy metadata.
2. Transcribe the untouched source with word timestamps.
3. Identify off-camera prompts, founder responses, false starts, and repeated clauses by combining transcript timing with visual or listening review. ASR alone does not identify the speaker.
4. Build the source EDL from phrase-level ranges. For a repeated word inside one ASR segment, split the range around the duplicate instead of trying to hide it with caption text.
5. Add 10 to 25 ms audio fades at joins.
6. Re-transcribe the cleaned timeline. Compare it against the intended script and inspect every remaining duplicate, clipped first word, and clipped final consonant.
7. Extend boundaries when softly spoken opening words disappear. Do not repair audible omissions only in subtitles.

## Conservative phone-audio restoration

A safe FFmpeg starting point is:

```text
highpass=f=70,
lowpass=f=14000,
afftdn=nr=8:nf=-32:tn=1:gs=6,
acompressor=threshold=-22dB:ratio=2:attack=18:release=160:makeup=2,
aresample=48000
```

Treat this as a starting point, not a preset. Compare raw and cleaned dialogue. Reduce denoise when consonants become watery, metallic, gated, or robotic. Natural room tone is preferable to damaged speech.

## Caption correction order

Correct proper nouns at the word-token level before grouping captions. A phrase-level replacement after three-word grouping can fail when a name is split across cards, for example `plant called Bacopa` followed by `ammonia`.

Required order:

1. normalize ASR word tokens;
2. inject or recover any verified softly spoken word;
3. group into one-to-three-word cards;
4. normalize the combined transcript;
5. regenerate ASS and SRT;
6. search outputs for rejected variants;
7. visually inspect the rendered card.

## Proof cards and transitions

- Prefer real archive, institution footage, research pages, launch images, and product photography.
- Use a restrained paper, cream, or dark-green frame for an old-fashioned evidence aesthetic.
- Do not alpha-fade a full-screen proof card over visible A-roll when it creates a double exposure. Use a hard phrase-boundary cut or fade through an opaque background.
- Check the actual visual at the selected source offset. A correct label such as `BACOPA MONNIERI` does not make a reporter shot valid plant B-roll. Inspect the first frame, midpoint, and final frame for semantic accuracy, not only technical cleanliness.
- Avoid aggressive full-frame vignette filters on portrait footage. They can create large black elliptical arcs. Inspect all four edges at full size.
- Hold the final clean frame for roughly 0.3 to 0.6 seconds after the last word when the source otherwise ends abruptly.
- Apply a final-frame `tpad` before burning subtitles. Padding after the subtitle filter clones the last caption into the hold even when its ASS event has ended.

## Timeline and validator pitfalls

- Derive B-roll, punch-in, music-fade, caption, and output timings from the cumulative cleaned EDL. Any split, boundary extension, or duplicate removal changes all downstream timeline positions.
- Caption and metadata validators must match complete tokens or tag keys. Avoid naive substring checks that reject valid words such as `laboratory` because they contain `labor`, or normal codec fields such as `chroma_location` because they contain `location`.
- After changing validator logic, rerun it against the final master. A corrected test is not a pass until the report returns success.

## Music and web-asset rights

- Verify the exact track license before rendering.
- Reject `NonCommercial` for commercial brand work.
- Treat `NoDerivatives` as unsafe for synchronization or edited use unless separately licensed.
- Prefer CC0, suitable CC BY with attribution, or a paid commercial license.
- Save the license text and source URL beside the asset.
- Public YouTube or official-institution footage is not automatically licensed for reuse. Mark permission requirements in the delivery note or replace it with cleared material before public posting.

## QA checkpoints

- First and final words are complete.
- No crew guidance remains.
- No repeated word survives at a cut boundary.
- Raw versus cleaned speech still sounds like the founder.
- Every B-roll first, midpoint, last, and return frame is opaque and clean.
- No black arcs, source strips, or double exposures.
- Proper nouns are correct in transcript, tokens, ASS, SRT, and render.
- The final hold feels intentional.
