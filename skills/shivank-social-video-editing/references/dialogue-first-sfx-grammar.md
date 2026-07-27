# Dialogue-first SFX grammar

Source basis: Artlist's `How To SOUND DESIGN | Step by step tutorial`, studied from its full timestamped transcript, local 720p reference, Premiere timeline examples, and key-moment contact sheet.

## Transferable principles

1. Layer by function, not by loudness. Context, anticipation or movement, and landing or texture are separate roles.
2. Most founder-reel moments need one role. Meaningful reveals may use two. Reserve three-layer stacks for a major hook or payoff.
3. Place an impact transient on the visual landing frame or in the space after a key spoken word. Never mask the word's first or final consonant.
4. Start a whoosh with visible motion, peak during its fastest point, and end when it settles. Do not use a whoosh for static text changes.
5. Make a riser peak at the reveal. Start around 0.25 to 0.6 seconds before quick transitions and 0.6 to 1.5 seconds before a genuinely major reveal.
6. Pre-lap relevant off-screen sound when it predicts or explains the next shot. Do not use unrelated ambience as transition filler.
7. Use low-pass filtering for distance, obstruction, underwater perspective, or a filtered-to-open reveal. Use high-pass and EQ to keep effects away from dialogue and music bass.
8. A reversed impact tail can become a riser. Trim any ugly reversed transient, fade its beginning, and end its peak exactly at the landing.
9. Pan only unmistakable lateral motion. Keep panning moderate, preserve a centered layer, and test the final mix in mono.
10. Dialogue stays the hierarchy leader. Effects should clarify attention, motion, or story, not announce the editing.

## Conservative density

Until Shivank gives more taste feedback:

- Calm authority reel: zero to two designed sound events.
- Normal 30 to 60 second Shivank reel: two to five purposeful events.
- High-energy montage: one event per distinct visual action, not per cut.
- Major multi-layer stack: usually one per reel.

Do not automatically add SFX to approved Selvam/Mindwise edits or YC/Y-series edits.

## Available library

Root: `<sfx-library>\edit_ready_48k`

- `impact_ultra_serious_48k_pcm24.wav`: major hook, stat, or final reveal. Start around -18 to -24 dB under dialogue.
- `impact_hit_01.wav`: proof reveal or title landing. Start around -12 to -18 dB and trim the tail when needed.
- `riser_01.wav`: restrained anticipation into a real reveal. Start around -18 to -24 dB.
- `riser_06.wav`: stronger anticipation. Start around -20 to -26 dB. Its source true peak is near 0 dBTP.
- `whoosh_11.wav`: large motivated motion. Start around -18 to -24 dB.
- `crowd_left_to_right.wav`: real audience, event, virality, or social-proof context. Start around -20 to -28 dB.

These are starting points. Mix to the actual dialogue and music.

## Event planning

Before mixing, record:

- asset;
- functional role;
- start, peak, and end time;
- exact visual or semantic sync target;
- gain;
- panning;
- EQ intent;
- editorial reason.

Reject any event with a vague sync target or reason.

## QA

1. Listen to dialogue alone.
2. Listen to SFX alone and verify every peak has a visual or narrative cause.
3. Listen to dialogue plus SFX without music.
4. Add music last and rebalance.
5. Check normal phone volume and mono.
6. Inspect every transient's exact landing frame.
7. Confirm nearby consonants remain intelligible.
8. Measure final loudness and true peak.
9. Remove any effect noticed more than the story it supports.

The full source study and recipes live at `<workspace>\Premium Editing Assets\docs\SFX_PLAYBOOK.md`.
