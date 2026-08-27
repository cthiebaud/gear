#!/usr/bin/env python3
"""Find how many seconds (and frames) into a recording the trace cascade
actually started -- the --offset/--offset-frames scripts/crop_to_reel.py
needs -- by cross-correlating the known opening jingle
(sounds/pacman_beginning.mp3, played right at the timeline's own t=0, see
playBeginning/startCascade in app.js) against the recording's own audio
track.

Usage:
    scripts/find_offset.py RECORDING.mov [--jingle sounds/pacman_beginning.mp3]
"""

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

SR = 22050  # plenty for a correlation match, keeps the FFT small/fast
DEFAULT_JINGLE = Path(__file__).resolve().parent.parent / "sounds" / "pacman_beginning.mp3"


def probe_fps(video_path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", str(video_path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    num, den = out.split("/")
    return int(num) / int(den)


def load_mono(path: Path, sr: int = SR) -> np.ndarray:
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "s16le", tmp.name],
            check=True, capture_output=True,
        )
        return np.frombuffer(Path(tmp.name).read_bytes(), dtype=np.int16).astype(np.float64)


def find_offset(recording: np.ndarray, reference: np.ndarray) -> tuple[float, float]:
    """Returns (offset_seconds, confidence) -- confidence is the peak
    correlation divided by the runner-up peak (>=~3 is a solid match,
    close to 1 means it's not really finding anything)."""
    n = len(recording) + len(reference) - 1
    n_fft = 1 << (n - 1).bit_length()
    ref_padded = np.zeros(n_fft)
    ref_padded[:len(reference)] = reference
    rec_padded = np.zeros(n_fft)
    rec_padded[:len(recording)] = recording
    corr = np.fft.irfft(np.fft.rfft(rec_padded) * np.conj(np.fft.rfft(ref_padded)), n_fft)
    valid = corr[:len(recording)]
    best = int(np.argmax(valid))

    # Confidence: peak vs. the next-best peak at least 1s away (so we're not
    # just comparing the peak to its own immediate shoulder).
    exclude = SR
    mask = np.ones_like(valid, dtype=bool)
    mask[max(0, best - exclude):best + exclude] = False
    runner_up = valid[mask].max() if mask.any() else 0
    confidence = valid[best] / runner_up if runner_up > 0 else float("inf")

    return best / SR, confidence


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("recording", type=Path)
    parser.add_argument("--jingle", type=Path, default=DEFAULT_JINGLE)
    args = parser.parse_args()

    print("Loading audio...")
    recording = load_mono(args.recording)
    reference = load_mono(args.jingle)

    offset, confidence = find_offset(recording, reference)
    fps = probe_fps(args.recording)
    frame = round(offset * fps)
    print(f"offset: {offset:.3f}s  =  frame {frame} @ {fps:.2f}fps  (confidence: {confidence:.1f}x)")
    if confidence < 3:
        print("Low confidence -- the recording's audio may not actually contain the jingle "
              "cleanly (e.g. captured the wrong device, or it's very quiet). Verify by ear "
              "before trusting this.", file=sys.stderr)


if __name__ == "__main__":
    main()
