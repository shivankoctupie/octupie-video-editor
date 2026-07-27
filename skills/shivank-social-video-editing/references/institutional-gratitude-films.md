# Institutional gratitude films

Use this reference for alumni, donor, sponsor, university, and team-support films where gratitude is the primary message and technical progress is supporting proof.

## Message hierarchy

1. Make gratitude the opening and closing idea.
2. Let team scale and work-in-progress footage prove what the support enables.
3. Keep competition names, destinations, and engineering milestones subordinate to the thank-you.
4. A strong structure is: `THANK YOU` → current team scale → support already at work → building/testing/flight → `THANK YOU`.

Do not let a bold competition slogan become more visually dominant than the acknowledgment.

## Brand extraction

- Inspect the official website before designing.
- Record real type families, colors, logo treatment, spacing, image crops, and headline hierarchy.
- Prefer full-bleed imagery, generous whitespace, restrained split layouts, and direct typography over floating pills, generic cards, or synthetic UI overlays.
- If the user names a font explicitly, use that font even when the browser reports a fallback or a different currently deployed family.
- Brand through typography, spacing, and color first. A persistent corner logo is not required.

## Team-scale proof

Use several kinds of current team imagery:

- a wide current group photograph;
- a second current team photograph from a different setting;
- a grid of official team portraits when it helps show headcount;
- active workshop footage with several members around the aircraft;
- a final group image beside the gratitude message.

Show team scale early. Do not wait until the closing frame.

## Campaign-year source discipline

A file downloaded or exported in the current year is not automatically current-year footage.

- Identify the event year from clothing, venue, banners, aircraft version, website copy, and source context.
- Separate footage of a prior competition from footage documenting preparation for the next campaign.
- When the film is about an upcoming campaign, prioritize current team, current build, current testing, and current flight-readiness footage.
- Use prior competition footage only when explicitly framed as history or aspiration.

## Motion-first rule

A team mosaic, split card, or photo sequence can be visually polished and still feel like a slideshow. Minor zooms and dissolves do not change that diagnosis.

Use this default for a 15 to 30 second institutional gratitude film:

- Put real video on most of the timeline, preferably work, coordination, testing, and outcome footage.
- Use each still image as a brief punctuation beat, usually under one second unless emotional comprehension needs longer.
- Do not stack several photo-led layouts back to back.
- Keep portrait mosaics and group images free of labels. If headcount matters, establish it in adjacent narration or a separate high-contrast text beat.
- A final gratitude hold may be static or slow, but it should follow a clearly motion-led body.

Motion metrics are a useful warning, not an editorial verdict. Measure frame differences by segment after a slideshow complaint, then watch the cut. Intentional brief stills and the final hold are valid exceptions.

## Text contrast and face protection

- Evaluate each text event against the full moving background, not one contact-sheet sample.
- Place essential copy on a restrained solid or semi-opaque brand band, dark gradient, or true negative space.
- Do not rely on a thin shadow when foreground and background have similar hue or luminance.
- Keep text completely off team portrait grids and group-photo faces. Cropping legs is sometimes acceptable; covering faces or an entire portrait row is not.
- Verify first, midpoint, and last frames of every text event at phone scale.

## Official logo handling

- Prefer the supplied official SVG or an official first-party PNG.
- Rasterize SVGs to a transparent high-resolution PNG when the renderer cannot ingest them directly.
- Inspect the rasterized emblem for complete paths, correct colors, sharp edges, and real transparency.
- Use the requested institution logo at a phone-readable size, usually in the closing brand band rather than as a persistent corner bug.

## Satoshi verification

ASS or FFmpeg logging that a font file was loaded does not prove that the requested family rendered.

- Inspect the final `fontselect` line.
- A fallback such as Arial means the font requirement failed.
- Verify the file's internal family and weight with FontTools before styling.
- A genuine web-distributed WOFF2 may be converted to a project-local TTF by loading it with FontTools, setting `font.flavor = None`, and saving it. This preserves the real family instead of inventing a renamed approximation.
- Some TTF files carry malformed family names. If needed, normalize only project-local copies, then select the repaired family through a small project `fontsdir`.
- Judge visible glyph shape as well as logs. The user may correctly reject an output that technically selected a file but does not visually read as the requested family or weight.

## Exact timing and overlay cleanup

- A 20-second master at 30 fps must contain exactly 600 video frames.
- Static-image inputs can silently end early inside an overlay chain. Use an explicit loop or cloned-frame hold before trimming, then count decoded frames.
- Crop baked source logos and subtitles structurally where possible.
- Inspect transitions at 0.25 to 0.5-second intervals. A one-second contact sheet can miss a stray telemetry frame or stale source title.
- After shifting a source range, inspect several frames before and after the cut, not only the new midpoint.

## SUAS correction example, July 2026

The rejected direction used current imagery, Satoshi-oriented styling, split layouts, and a long portrait mosaic, but the user still experienced it as a slideshow. Text also lost contrast against changing footage, and the `24 members` label covered portrait content. Technical font selection and polished cards did not solve the structural problem.

The corrected motion-first pass used:

- real build, workshop, assembly, field-testing, and flight video for most of the runtime;
- three brief, unobstructed team-photo beats between moving sequences;
- no headcount label over the 24-tile portrait mosaic;
- controlled navy contrast bands for every essential text event;
- genuine Satoshi Variable with `fontselect` resolving to the intended bold face;
- the official IIT Madras emblem, rasterized from the supplied SVG and used at phone-readable size in the closing band;
- no persistent corner badge, baked source subtitle, telemetry panel, or source logo;
- a large opening and closing `THANK YOU`, with `YOU` in signal blue;
- dense half-second QA plus decoded-frame motion analysis before the final master.

Reusable lesson: when a user says an institutional film feels like a slideshow, do not respond with more animated cards. Rebuild the timeline around coherent moving evidence, then let brief unlabelled photos punctuate the story.
