#!/usr/bin/env python
"""Validate a planned SFX cue sheet before building or rendering audio.

Input is JSON with either a top-level list or {"cues": [...]}.
Each cue may contain:
  time: number in seconds, required
  asset: source filename, required
  family: ambience|foley|whoosh|riser|impact|ui|paper|tonal|glitch|other
  intensity: texture|support|hero
  role: short sentence describing the distinct editorial job
  duration: optional seconds

Exit code 0 means no blocking failures. Warnings still require editorial review.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

BLACKLIST = {
    "impact_ultra_serious_48k_pcm24.wav",
}
STACK_WINDOW = 0.12
REPEAT_WINDOW = 4.0
HERO_WINDOW = 10.0
HEAVY_FAMILIES = {"riser", "impact"}


def load_cues(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    cues = data.get("cues") if isinstance(data, dict) else data
    if not isinstance(cues, list):
        raise ValueError("Cue sheet must be a list or an object with a 'cues' list")
    return cues


def validate(cues: list[dict]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    normalized: list[dict] = []

    for index, cue in enumerate(cues, start=1):
        if not isinstance(cue, dict):
            errors.append(f"cue {index}: entry is not an object")
            continue
        if "time" not in cue or not isinstance(cue["time"], (int, float)):
            errors.append(f"cue {index}: numeric 'time' is required")
            continue
        asset = Path(str(cue.get("asset", ""))).name
        if not asset:
            errors.append(f"cue {index} at {cue['time']:.3f}s: 'asset' is required")
        if asset.lower() in {name.lower() for name in BLACKLIST}:
            errors.append(f"cue {index} at {cue['time']:.3f}s: blacklisted asset '{asset}'")
        role = str(cue.get("role", "")).strip()
        if not role:
            warnings.append(f"cue {index} at {cue['time']:.3f}s: no distinct editorial role stated")
        family = str(cue.get("family", "other")).lower()
        intensity = str(cue.get("intensity", "support")).lower()
        if intensity not in {"texture", "support", "hero"}:
            errors.append(f"cue {index} at {cue['time']:.3f}s: invalid intensity '{intensity}'")
        normalized.append({
            "index": index,
            "time": float(cue["time"]),
            "asset": asset,
            "family": family,
            "intensity": intensity,
            "role": role,
        })

    normalized.sort(key=lambda cue: cue["time"])

    for left_index, left in enumerate(normalized):
        nearby = [left]
        for right in normalized[left_index + 1:]:
            if right["time"] - left["time"] > STACK_WINDOW:
                break
            nearby.append(right)
        if len(nearby) >= 3:
            families = Counter(cue["family"] for cue in nearby)
            labels = ", ".join(f"{cue['family']}:{cue['asset']}" for cue in nearby)
            warnings.append(
                f"dense stack near {left['time']:.3f}s ({len(nearby)} cues): {labels}. "
                "Start with one cue and justify every additional layer."
            )
            if {"whoosh", "riser", "impact"}.issubset(families):
                errors.append(
                    f"default trailer stack near {left['time']:.3f}s: whoosh + riser + impact. "
                    "This requires an explicit hero-level narrative justification."
                )

    by_asset: dict[str, list[float]] = {}
    for cue in normalized:
        by_asset.setdefault(cue["asset"].lower(), []).append(cue["time"])
    for asset, times in by_asset.items():
        for earlier, later in zip(times, times[1:]):
            if later - earlier < REPEAT_WINDOW:
                warnings.append(
                    f"repeated waveform '{asset}' at {earlier:.3f}s and {later:.3f}s. "
                    "Use an alternate take, different source region, or fewer cues."
                )

    heroes = [cue for cue in normalized if cue["intensity"] == "hero"]
    for earlier, later in zip(heroes, heroes[1:]):
        if later["time"] - earlier["time"] < HERO_WINDOW:
            warnings.append(
                f"hero cues only {later['time'] - earlier['time']:.2f}s apart at "
                f"{earlier['time']:.3f}s and {later['time']:.3f}s. Preserve contrast."
            )

    for cue in normalized:
        if cue["family"] in HEAVY_FAMILIES and cue["intensity"] == "texture":
            warnings.append(
                f"{cue['family']} at {cue['time']:.3f}s is labeled texture. "
                "Confirm the asset is genuinely subtle or choose a lighter family."
            )

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("cue_sheet", type=Path)
    args = parser.parse_args()

    try:
        cues = load_cues(args.cue_sheet)
        errors, warnings = validate(cues)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print(f"Cues checked: {len(cues)}")
    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}")
    print(f"Result: {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
