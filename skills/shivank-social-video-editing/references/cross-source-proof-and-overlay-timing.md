# Cross-source proof and delayed overlay timing

Use this reference when project instructions require a visual that is not present in the named A-roll, or when a short proof clip must appear late in a longer FFmpeg composite.

## Source reconciliation

1. Treat the requested version as the spoken master.
2. Probe and contact-sheet every supplied sibling A-roll before sourcing anything externally.
3. Locate the exact missing visual using coarse contact sheets, then exact frames around the candidate range.
4. Extract only the required visual as a muted, color-matched mezzanine.
5. Record its source and destination window in the render plan.
6. Re-transcribe the cleaned spoken master to ensure cross-source work did not alter dialogue continuity.

A reliable pattern from a YC Reel project was:

- keep Version 1 for all dialogue;
- find the instruction-referenced phone reveal in a supplied Version 2 main clip;
- tone-map only that short range to a 1080x608 FFV1 mezzanine;
- place it after the phrase that introduces the comments;
- keep the speaker and phone visible;
- follow it with supplied comment screenshots.

## YC proof placement

When B-roll must not cover the speaker:

- keep A-roll in the 1080x608 slot at y=680;
- place wide screenshot proof in the upper region around y=315;
- temporarily hide the YC logo and headline while the proof card is present;
- restore them after the final proof frame;
- keep captions in the normal lower band around y=1335.

This makes screenshots readable while preserving speaker continuity.

## Delayed short-video overlays

A short overlay input starts near timestamp zero. If it is simply gated with `enable='between(t,18.45,21.15)'`, it may have reached end-of-file before the destination window.

A robust input pattern is:

```python
cmd = [
    "ffmpeg", "-i", str(MAIN),
    "-itsoffset", f"{overlay_start:.3f}",
    "-t", f"{overlay_duration:.3f}",
    "-i", str(OVERLAY),
]
```

Then keep the shifted timestamps in the filter graph:

```text
[1:v]fps=24,scale=1080:608,format=rgba[proof];
[base][proof]overlay=0:680:eof_action=pass:shortest=0:
enable='between(t,18.45,21.15)'[out]
```

Do not reset the shifted overlay with `setpts=PTS-STARTPTS` afterward.

Alternative PTS shifting is valid, but it must be tested by extracting a frame from the final composite inside the destination window.

## Transition rule

Do not alpha-fade between takes with different face, hand, or prop positions. The result is a double-exposed face or ghosted phone. If the B-roll begins and ends at complete phrase boundaries, use a hard cut. Inspect:

- one frame before entry;
- first proof frame;
- proof midpoint;
- last proof frame;
- first frame after return.

## HDR working copy pitfall

After HLG to BT.709 tone mapping, force an encoder-compatible format before 8-bit FFV1:

```text
...,zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=tv,
scale=1080:608:flags=lanczos,format=yuv420p,setsar=1,fps=24
```

Without the explicit `format=yuv420p`, the filter chain may retain a high-bit-depth format that the selected FFV1 settings reject.

## Completion gate

After any overlay timing repair:

1. Render the final master.
2. Inspect exact final-composite frames around the repaired window.
3. Run the technical validator on that final file.
4. Require a passing report for dimensions, frame rate, codecs, loudness, true peak, BT.709 tags, duration, fast-start, captions, and privacy metadata.
5. Only then deliver.
