#!/usr/bin/env python3
"""Remove background, crop to content, and optionally resize to match a reference PNG.

Usage:
    scripts/remove_bg.py INPUT.jpg [-o OUTPUT.png] [--ref REFERENCE.png]

Pipeline: rembg -> crop to the non-transparent bounding box -> resize to
match the reference image's exact pixel dimensions (if --ref given) ->
save as an optimized RGBA PNG.
"""

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image


def remove_bg(input_path: Path, output_path: Path, ref_path: Path | None) -> None:
    with tempfile.NamedTemporaryFile(suffix=".png") as tmp:
        subprocess.run(["rembg", "i", str(input_path), tmp.name], check=True)
        raw = Image.open(tmp.name).convert("RGBA")

    bbox = raw.getbbox()
    if bbox is None:
        raise SystemExit(f"{input_path}: background removal left nothing visible")
    cropped = raw.crop(bbox)

    if ref_path is not None:
        ref_size = Image.open(ref_path).size
        result = cropped.resize(ref_size, Image.LANCZOS)
    else:
        result = cropped

    output_path.parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path, optimize=True, compress_level=9)
    print(f"{input_path} -> {output_path} ({result.size[0]}x{result.size[1]})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="source JPEG/PNG photo")
    parser.add_argument("-o", "--output", type=Path, default=None,
                         help="output PNG path (default: <input stem>_nobg.png next to input)")
    parser.add_argument("--ref", type=Path, default=None,
                         help="reference PNG to match dimensions against (default: no resize)")
    args = parser.parse_args()

    output = args.output or args.input.with_name(args.input.stem + "_nobg.png")
    remove_bg(args.input, output, args.ref)


if __name__ == "__main__":
    main()
