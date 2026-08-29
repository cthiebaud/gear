#!/usr/bin/env python3
"""Crop one or more already-transparent PNGs to content and resize to match a reference.

Usage:
    scripts/crop_to_ref.py --ref REFERENCE.png INPUT.png [INPUT2.png ...]

For a set of inputs meant to be swapped for one another (e.g. an LED on/off
pair of the same photo), all inputs are cropped to their shared (union)
bounding box rather than each to its own -- so any minor difference between
their individual alpha edges can't shift one relative to the other -- then
every result is resized to the reference's exact pixel dimensions. Each
input is overwritten in place with its own cropped, resized result.
"""

import argparse
from pathlib import Path

from PIL import Image


def union_bbox(images: list[Image.Image]) -> tuple[int, int, int, int]:
    boxes = [im.getbbox() for im in images]
    if any(b is None for b in boxes):
        raise SystemExit("one of the inputs is fully transparent -- nothing to crop to")
    lefts, tops, rights, bottoms = zip(*boxes)
    return min(lefts), min(tops), max(rights), max(bottoms)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path, nargs="+", help="already-transparent PNGs to crop, overwritten in place")
    parser.add_argument("--ref", type=Path, required=True, help="reference PNG to match final dimensions against")
    args = parser.parse_args()

    images = [Image.open(p).convert("RGBA") for p in args.inputs]
    bbox = union_bbox(images)
    ref_size = Image.open(args.ref).size

    for path, img in zip(args.inputs, images):
        result = img.crop(bbox).resize(ref_size, Image.LANCZOS)
        result.save(path, optimize=True, compress_level=9)
        print(f"{path} -> {result.size[0]}x{result.size[1]}")


if __name__ == "__main__":
    main()
