#!/usr/bin/env python3
"""Local pyannote.audio speaker-diarization bridge for the Octupie video editor.

Spawned by the TypeScript engine with an explicit argument array and no shell.
It reads a single local mono WAV file, runs pyannote.audio fully on-device, and
prints one JSON object of speaker turns to stdout. Every diagnostic goes to
stderr so stdout stays a clean JSON channel.

Permissions and safety:
  - It is prompt-free by construction: there is no text-steering input.
  - It NEVER reads a token file and NEVER prints a token. If a Hugging Face token
    is needed for the standard pyannote model, the operator supplies it in the
    HF_TOKEN environment variable; this script reads it from the environment and
    passes it straight to the loader without echoing it anywhere.
  - Default is cached/local-only: HF_HUB_OFFLINE and TRANSFORMERS_OFFLINE are set
    so a missing model is a hard error, not a silent download. A download is
    attempted ONLY when --allow-model-download is explicitly supplied.
  - A local model path (a directory or a config.yaml) loads fully offline with no
    token at all.
  - It installs nothing.

Output shape (seconds are floats):

    {
      "model": "pyannote/speaker-diarization-3.1",
      "turns": [
        {"speaker": "SPEAKER_00", "start": 0.0, "end": 2.31},
        {"speaker": "SPEAKER_01", "start": 2.40, "end": 5.02}
      ]
    }
"""

import argparse
import json
import os
import sys


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Local pyannote.audio diarization bridge.")
    parser.add_argument("--audio", required=True, help="Path to a local mono WAV file.")
    parser.add_argument(
        "--model",
        default="pyannote/speaker-diarization-3.1",
        help="A local model path (directory or config.yaml) or a named pyannote model.",
    )
    parser.add_argument("--device", default="cpu", help="cpu or cuda.")
    parser.add_argument(
        "--allow-model-download",
        action="store_true",
        help="Explicitly permit a missing named model to be downloaded. Default is cached/local files only.",
    )
    args = parser.parse_args()

    # Cached/local-only unless the operator explicitly allows a download.
    if not args.allow_model_download:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

    try:
        from pyannote.audio import Pipeline
    except Exception as exc:  # pragma: no cover - environment guard
        log(f"pyannote.audio import failed: {exc}")
        return 3

    # A token is only relevant for the named hub model. It is read from the
    # environment and never logged. A local path loads without any token.
    token = os.environ.get("HF_TOKEN")
    is_local_path = os.path.exists(args.model)

    try:
        if is_local_path:
            pipeline = Pipeline.from_pretrained(args.model)
        else:
            pipeline = Pipeline.from_pretrained(args.model, use_auth_token=token)
    except Exception as exc:
        # Do not echo the token; report only the model reference.
        log(f"pipeline load failed for model '{args.model}': {exc}")
        return 4

    if pipeline is None:
        log(f"pipeline could not be constructed for model '{args.model}' (missing access or cached files).")
        return 4

    try:
        import torch

        pipeline.to(torch.device(args.device))
    except Exception as exc:  # pragma: no cover - device is best-effort
        log(f"device selection failed ({args.device}); continuing on default: {exc}")

    try:
        diarization = pipeline(args.audio)
    except Exception as exc:
        log(f"diarization failed: {exc}")
        return 5

    turns = []
    for segment, _track, speaker in diarization.itertracks(yield_label=True):
        turns.append(
            {
                "speaker": str(speaker),
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
            }
        )

    payload = {"model": str(args.model), "turns": turns}
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
