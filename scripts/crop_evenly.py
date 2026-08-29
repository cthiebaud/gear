#!/usr/bin/env python3
"""Crop a WAV containing N evenly-spaced one-shot sounds into N equal-length slots.

Usage:
    scripts/crop_evenly.py INPUT.wav -n 16 [-o OUTPUT.wav] [--preroll-ms 30]

A recording of N distinct hits (button presses, foot taps, ...) rarely has
matching lead-in and trail-out silence -- there's usually a longer pause
before the first hit and a longer tail after the last one than the actual
spacing between hits. This finds each hit's onset by a smoothed-envelope
threshold, derives one fixed slot duration from the first-to-last onset
span (assumed evenly spaced, per the recording), and crops so the file
starts `preroll-ms` before the first onset and ends exactly N slots later
-- every slot the same length, the last one ending with the same trailing
room as any other, ready to be sliced into N equal pieces downstream (by
sample count alone, no per-slot onset lookup needed).
"""

import argparse
import wave
from pathlib import Path

import numpy as np

ENVELOPE_WINDOW_S = 0.005
THRESHOLD_FRACTION = 0.03  # of the envelope's peak
MERGE_GAP_S = 0.5  # onsets closer together than this are one event, not two


def detect_onsets(mono: np.ndarray, sr: int) -> np.ndarray:
    win = max(1, int(sr * ENVELOPE_WINDOW_S))
    envelope = np.convolve(np.abs(mono.astype(np.float64)), np.ones(win) / win, mode="same")
    active = envelope > envelope.max() * THRESHOLD_FRACTION
    edges = np.where(np.diff(active.astype(int)) == 1)[0] + 1

    gap = int(sr * MERGE_GAP_S)
    onsets = []
    for e in edges:
        if not onsets or e - onsets[-1] > gap:
            onsets.append(e)
    return np.array(onsets)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path)
    parser.add_argument("-n", "--count", type=int, required=True, help="number of evenly-spaced sounds in the recording")
    parser.add_argument("-o", "--output", type=Path, default=None, help="default: overwrite input in place")
    parser.add_argument("--preroll-ms", type=float, default=30, help="silence kept before the first onset (default: 30ms)")
    args = parser.parse_args()

    with wave.open(str(args.input), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sampwidth = w.getsampwidth()
        n = w.getnframes()
        raw = w.readframes(n)

    if sampwidth != 2:
        raise SystemExit(f"{args.input}: only 16-bit PCM is supported (got {sampwidth * 8}-bit)")
    data = np.frombuffer(raw, dtype=np.int16).reshape(-1, ch)
    mono = data.mean(axis=1)

    onsets = detect_onsets(mono, sr)
    if len(onsets) != args.count:
        raise SystemExit(f"{args.input}: detected {len(onsets)} onsets, expected {args.count} -- adjust THRESHOLD_FRACTION/MERGE_GAP_S")

    slot_samples = int(round((onsets[-1] - onsets[0]) / (args.count - 1)))
    preroll_samples = int(round(args.preroll_ms / 1000 * sr))
    crop_start = onsets[0] - preroll_samples
    crop_end = crop_start + slot_samples * args.count
    if crop_start < 0 or crop_end > n:
        raise SystemExit(f"{args.input}: computed crop [{crop_start}, {crop_end}) falls outside the file (0, {n})")

    cropped = data[crop_start:crop_end]
    output = args.output or args.input
    with wave.open(str(output), "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(sampwidth)
        w.setframerate(sr)
        w.writeframes(cropped.astype(np.int16).tobytes())

    slot_s = slot_samples / sr
    print(f"{args.input} -> {output}: {args.count} slots x {slot_s:.4f}s ({slot_samples} samples) = {slot_samples * args.count / sr:.4f}s total")


if __name__ == "__main__":
    main()
