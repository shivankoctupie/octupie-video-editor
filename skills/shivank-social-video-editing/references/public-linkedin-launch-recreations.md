# Public LinkedIn launch-reference recreations

Use this for a public LinkedIn post whose embedded launch video is the motion reference and for a supplied brand video that provides the target product truth.

## Separate the two sources

- Treat the LinkedIn video as the edit-language reference.
- Treat the supplied brand video, current product, and first-party assets as the content source.
- Never assume the attachment is the LinkedIn reference merely because both arrived in the same message. Probe duration, dimensions, frame rate, and content first.
- Do not reuse the reference brand's voice, music, UI, footage, or logos. Rebuild only its communication and motion grammar.

## Recover the public LinkedIn media

1. Open the exact post before relying on conversation history or search snippets.
2. Dismiss the public sign-in modal when possible.
3. Inspect `document.querySelectorAll('video')` for `currentSrc`, `poster`, `duration`, and `readyState`.
4. Inspect media resource entries for an auto-caption WebVTT URL.
5. Download the video and VTT immediately because the signed URLs are temporary.
6. Never preserve or repeat signed query parameters in plans, notes, skills, or delivery messages.
7. Probe the downloaded file and build a dense chronological contact sheet. A public playback resolution may be lower than the original, but it is still adequate for timing, layout, transition, and edit-grammar analysis.

## Map communication jobs, not frames

Build a table with:

- reference timestamp;
- communication job;
- verified target-brand truth;
- target visual state;
- motion behavior;
- sound cue.

For feature-launch films, a useful mapping is:

1. Instant feature hook.
2. Product input or setup.
3. The product visibly working.
4. Alternate starting path.
5. Use cases or outcomes.
6. Minimal CTA and logo hold.

Keep the reference's density changes and pacing while replacing every product claim and visual with truthful target-brand content.

## Narration timing gate

- Generate and audition the final narration before locking scene boundaries.
- Save sentence-level start and end times from the final rendered voice.
- If voice, speed, pauses, or wording changes, rebuild all scene boundaries, internal animation cues, and SFX timings from the new timing map.
- Never leave the motion timeline on timings from an earlier voice candidate. A readable preview can still be semantically out of sync by several seconds.

## Transition gate

When the root switches between mutually exclusive scenes, do not also fade the incoming scene from zero opacity unless an intentional blank is required. That combination creates accidental gray or empty frames at exact boundaries.

Prefer:

- an always-visible incoming background;
- short blur or scale settle;
- a restrained flash overlay;
- a whoosh that lands on the same cut.

Inspect dense motion strips at each scene boundary. Half-second sheets can reveal transition blanks, but inspect exact frames as well.

## Exact-frame mux safeguard

A correct silent render can lose its final frame when muxed with `-shortest` if the processed audio ends one packet early.

Verification and repair:

1. Count frames in the silent master.
2. Probe the processed WAV duration.
3. If audio is shorter than `frames / fps`, pad it to the exact target duration.
4. Mux with an explicit `-t TARGET_DURATION` instead of relying on `-shortest`.
5. Count frames again on the delivered MP4.
6. Run full decode, black-frame detection, loudness, true-peak, metadata, and contact-sheet QA on the exact delivered bytes.

Example pattern:

```bash
ffmpeg -i mix.wav -af "apad=pad_dur=1" -t TARGET -ar 48000 -ac 2 mix_exact.wav
ffmpeg -i silent.mp4 -i mix_exact.wav -map 0:v:0 -map 1:a:0 \
  -c:v copy -c:a aac -b:a 256k -t TARGET -movflags +faststart final.mp4
ffprobe -count_frames -show_entries stream=nb_read_frames -of json final.mp4
```

## Delivery QA

- Hook, demo, use cases, and CTA are all present.
- All claims are current and target-brand supported.
- No reference-brand media survives in the remake.
- UI and typography remain readable at the delivery size.
- No clipped cards, accidental blank transitions, or unfinished animations.
- Final logo hold is clean.
- Narration remains the loudness leader.
- Every major whoosh, impact, or riser has a visible motivation.
- Manual note flags narration taste and third-party image clearance for human review.
