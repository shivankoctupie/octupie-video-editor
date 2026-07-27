#!/usr/bin/env python3
"""Local faster-whisper transcription bridge for the Octupie video editor.

This script is spawned by the TypeScript engine with an explicit argument array
and no shell. It reads a single local audio (or video) file, runs faster-whisper
fully on-device, and prints one JSON object to stdout. Every diagnostic goes to
stderr so stdout stays a clean JSON channel.

It is deliberately prompt-free: no initial_prompt is ever passed, so the model
cannot be steered by injected text. Named models are cached or local-only by
default. A missing model is downloaded only when --allow-model-download is
explicitly supplied. It installs nothing.

Output shape (seconds are floats):

    {
      "language": "en",
      "languageProbability": 0.99,
      "duration": 12.34,
      "words": [{"text": "hello", "start": 0.0, "end": 0.4, "probability": 0.98}, ...],
      "segments": [
        {"id": "seg0", "start": 0.0, "end": 1.2, "text": "hello world",
         "words": [ ... ]}
      ]
    }
"""

import argparse
import json
import sys


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def clamp_word(w) -> dict | None:
    """Normalize one faster-whisper word; drop words with no usable timing."""
    start = getattr(w, "start", None)
    end = getattr(w, "end", None)
    text = getattr(w, "word", None)
    if start is None or end is None or text is None:
        return None
    start = float(start)
    end = float(end)
    if end < start:
        end = start
    out = {"text": str(text).strip(), "start": round(start, 3), "end": round(end, 3)}
    if not out["text"]:
        return None
    prob = getattr(w, "probability", None)
    if prob is not None:
        out["probability"] = round(float(prob), 4)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Local faster-whisper transcription bridge.")
    parser.add_argument("--audio", required=True, help="Path to a local audio or video file.")
    parser.add_argument("--model", default="base.en", help="faster-whisper model name or path.")
    parser.add_argument("--language", default=None, help="Force a language code (e.g. en). Omit to auto-detect.")
    parser.add_argument("--device", default="cpu", help="cpu or cuda.")
    parser.add_argument("--compute-type", default="int8", help="Compute type, e.g. int8, float16.")
    parser.add_argument("--beam-size", type=int, default=5, help="Beam size for decoding.")
    parser.add_argument(
        "--allow-model-download",
        action="store_true",
        help="Explicitly permit a missing named model to be downloaded. Default is cached/local files only.",
    )
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover - environment guard
        log(f"faster_whisper import failed: {exc}")
        return 3

    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            local_files_only=not args.allow_model_download,
        )
    except Exception as exc:
        log(f"model load failed: {exc}")
        return 4

    try:
        segments_iter, info = model.transcribe(
            args.audio,
            language=args.language,
            beam_size=args.beam_size,
            word_timestamps=True,
            # Prompt-free by construction: no initial_prompt, no hotwords.
        )
    except Exception as exc:
        log(f"transcription failed: {exc}")
        return 5

    all_words: list[dict] = []
    segments: list[dict] = []
    for idx, seg in enumerate(segments_iter):
        seg_words = []
        for w in getattr(seg, "words", None) or []:
            norm = clamp_word(w)
            if norm is not None:
                seg_words.append(norm)
        all_words.extend(seg_words)
        segments.append(
            {
                "id": f"seg{idx}",
                "start": round(float(seg.start), 3),
                "end": round(float(seg.end), 3),
                "text": str(seg.text).strip(),
                "words": seg_words,
            }
        )

    payload = {
        "language": info.language,
        "languageProbability": round(float(info.language_probability), 4),
        "duration": round(float(info.duration), 3),
        "words": all_words,
        "segments": segments,
    }
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
