#!/usr/bin/env python3
"""Local OpenCV frame-metrics bridge for the Octupie video editor.

Spawned with an explicit argument array and no shell. Reads a JSON manifest of
already-extracted frame image paths (each with the source timestamp) and prints
one JSON object of per-frame measurements to stdout. Diagnostics go to stderr.

These are visual measurements, not semantic understanding:
  - blur:        variance of the Laplacian (higher = sharper)
  - brightness:  mean luma normalized to 0..1
  - faces:       Haar-cascade frontal-face boxes in normalized frame coordinates
  - discontinuity: 1 - grayscale-histogram correlation with the previous frame

The manifest shape is [{"path": "...", "atSeconds": 1.5}, ...]. Everything runs
fully offline against the bundled OpenCV cascade; no download and no network.
"""

import argparse
import json
import sys


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Local OpenCV frame-metrics bridge.")
    parser.add_argument("--manifest", required=True, help="Path to a JSON manifest of frames.")
    args = parser.parse_args()

    try:
        import cv2
        import numpy as np
    except Exception as exc:  # pragma: no cover - environment guard
        log(f"opencv import failed: {exc}")
        return 3

    try:
        with open(args.manifest, "r", encoding="utf-8") as fh:
            frames_in = json.load(fh)
    except Exception as exc:
        log(f"could not read manifest: {exc}")
        return 4

    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    face_cascade = cv2.CascadeClassifier(cascade_path)

    out_frames = []
    prev_hist = None
    for item in frames_in:
        path = item["path"]
        at_seconds = float(item.get("atSeconds", 0.0))
        img = cv2.imread(path)
        if img is None:
            log(f"could not read frame: {path}")
            continue
        h, w = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        brightness = float(gray.mean()) / 255.0

        faces_raw = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        faces = []
        for (fx, fy, fw, fh) in faces_raw:
            faces.append(
                {
                    "xNorm": round(float(fx) / w, 4),
                    "yNorm": round(float(fy) / h, 4),
                    "wNorm": round(float(fw) / w, 4),
                    "hNorm": round(float(fh) / h, 4),
                }
            )

        hist = cv2.calcHist([gray], [0], None, [64], [0, 256])
        cv2.normalize(hist, hist)
        frame_out = {
            "atSeconds": round(at_seconds, 3),
            "blur": round(blur, 3),
            "brightness": round(min(max(brightness, 0.0), 1.0), 4),
            "faceCount": len(faces),
            "faces": faces,
        }
        if prev_hist is not None:
            corr = float(cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL))
            frame_out["discontinuity"] = round(min(max(1.0 - corr, 0.0), 1.0), 4)
        prev_hist = hist
        out_frames.append(frame_out)

    json.dump({"frames": out_frames}, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
