# SFX selection and placement

Use this guide before adding sound effects to any edit. Sound effects are story and motion cues, not decoration.

## First question

Before searching for a sound, write the cue's job in one sentence.

Good examples:

- `Describe the left-to-right speed of the product card.`
- `Prepare the viewer for the one major product reveal.`
- `Confirm that the visible UI state changed.`
- `Ground the scene in a quiet office.`

Bad examples:

- `Make it cooler.`
- `Put something on the cut.`
- `The timeline feels empty.`

If the cue has no specific job, leave it silent.

## Selection matrix

| SFX family | Use it for | Do not use it for | Timing |
|---|---|---|---|
| Diegetic or Foley | Visible real-world actions, material contact, paper, clothing, doors, keyboards | Abstract motion with no physical source | Align the recognizable contact transient to the action |
| Ambience or room tone | Establishing place, scale, continuity, and realism | Filling a designed white-space moment | Start before the cut when it motivates the new space, then carry gently across |
| Short whoosh or swish | Fast position changes, camera pans, object passes, text or cards crossing space | Static text changes, fades, tiny movements | Shape the sound across the visible motion; peak near maximum velocity or 2 to 3 frames before a cut |
| Long whoosh | Large travel, long camera move, or a transition with a real approach phase | Short one-frame cuts or small furniture substitutions | Start with visible acceleration and finish as motion settles |
| Reverse or suck-back | Brief anticipation before a cut, collapse, pull-away, or reveal | Ordinary informational changes | End immediately before the landing transient |
| Riser | A meaningful reveal, topic shift, escalation, or delayed payoff | Every product swap, every caption, or any event without anticipation | Start 1 to 3 seconds before the payoff and resolve or cut at the reveal |
| Light impact or thud | A clear object landing, card lock, title lock, or medium narrative punctuation | Gentle crossfades and continuous movement | Align the sharp transient exactly to the landing frame |
| Heavy impact, sub hit, boom, braam | The single largest reveal, dramatic scale change, trailer-like punctuation | Small products, furniture substitutions, normal social cuts, calm premium work | Use rarely. Give the low tail space and preserve headroom |
| UI click or select | A visible selection, toggle, confirmation, open, close, snap, or navigation state | Decorative text and non-interactive footage | Align to the state-change frame, usually dry and quiet |
| Paper or type texture | Editorial layouts, page movement, physical typography, restrained writing or print metaphors | Every character or every text card | One cue per meaningful phrase or physical motion, not per letter |
| Chime, glass, shimmer | Light, premium confirmation or delicate reveal when the brand supports it | Serious claims, hard objects, or repeated transitions | Let the attack land gently, then clear its tonal tail before speech or the next chord |
| Glitch or digital burst | Visible corruption, failure, scan, signal break, or deliberate digital fragmentation | Generic scene transitions or clean product motion | Synchronize each audible fragment to visible fragmentation |
| Drone or tonal bed | Emotional subtext, tension, continuity, or scale | Replacing music or masking a weak edit | Keep key-compatible with music and automate under dialogue |
| Silence or reduced bed | Contrast, breath, anticipation, emotional reset | Avoiding the work of building ambience | Pull layers before the important moment, then restore only what the payoff needs |

## Intensity hierarchy

Label every cue before placing it:

1. **Texture:** Nearly subliminal. Adds tactility or continuity.
2. **Support:** Clearly reinforces one visible action without becoming the event.
3. **Hero:** Commands attention at the largest payoff.

Normal short-form edits should be mostly texture, use a few support cues, and contain zero or one hero stack.

Do not place two hero cues close together. If every cue is large, none is meaningful.

## Whoosh-hit anatomy

A designed whoosh-hit reads as one gesture:

1. **Approach:** The whoosh describes incoming motion and stays quieter than the landing.
2. **Transient:** A short, precise attack marks the exact contact or lock frame.
3. **Body:** Adds weight appropriate to the visible object's mass and material.
4. **Tail:** Describes space and consequence, then clears before the next beat.

Each layer needs a different job and useful frequency range. Do not stack sounds merely because each sounds impressive alone.

Common failures:

- all layers peak together and become an unreadable blob;
- the visual is small but the sound implies trailer-scale mass;
- a long or vocal-like tail makes a clean reveal feel strange;
- several low layers mask each other or the music;
- the transient is early or late;
- reverb removes precision;
- identical cues repeat across multiple actions;
- limiting flattens the attack and makes the cue harsh.

## Audition protocol

Every new candidate must pass all seven checks:

1. **Solo:** Listen for vocals, horror textures, comedy, distortion, abrupt edits, noise, tonal clash, and strange tails.
2. **Visual scale:** Confirm the sound's perceived mass and material match the object and movement.
3. **Music context:** Check pitch, rhythm, low-end competition, and whether the cue duplicates a musical accent.
4. **Exact timing:** Align the waveform transient or velocity peak to the intended visual frame.
5. **Full mix:** Confirm dialogue or the main narrative element remains dominant.
6. **Repetition:** Compare every similar cue in the edit. Use alternate takes, different source regions, or fewer cues.
7. **Delivery:** Listen to the encoded master on headphones, phone speaker, and mono. Metering alone does not reveal a strange sound.

If a cue causes doubt, remove it. Silence is better than a mismatched sound.

## Local libraries

- Curated premium edits: `<sfx-library>\edit_ready_48k`
- Licensed additions and manifest: `<sfx-library>\curated_licensed`
- UI SFX source: CC0-1.0, stored with `LICENSE-AUDIO`
- Mixkit selections: Mixkit Free License, source and license URLs recorded in `manifest.json`

The licensed folder contains candidates, not automatic approvals. Audition before every use.

## Global rejection

Never use `impact_ultra_serious_48k_pcm24.wav`, or a pitched, stretched, layered, or renamed derivative. Shivank rejected its strange treatment around 0:33 in The Oblist V2.

## Tutorial evidence

Rules were consolidated from:

- Film Editing Pro, `How to SOUND DESIGN a Video`, https://www.youtube.com/watch?v=Wcxw3BPSt3A
- `Sound Design for Cinematic Filmmaking | My Process`, https://www.youtube.com/watch?v=I66_LmOTlSk
- `Sound Design Tutorial: Cinematic Whoosh Hit`, https://www.youtube.com/watch?v=3rCUdTDodrc
- `Complete Guide to Sound Design Any Video Like a Pro`, https://www.youtube.com/watch?v=FjpnOstqBvs

Transferable lessons: build score and ambience first, use varied Foley, align waveforms visibly, let sound communicate emotion as well as literal action, preserve silence, keep a consistent sonic style, and reserve maximum intensity for rare moments.
