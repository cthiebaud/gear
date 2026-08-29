#!/usr/bin/env python3
"""Remove background, crop to content, and optionally resize to match a reference PNG.

Usage:
    scripts/remove_bg.py INPUT.jpg [-o OUTPUT.png] [--ref REFERENCE.png] [--no-crop]

Pipeline: rembg -> fill any interior hole rembg's mask left enclosed within
the object's own silhouette (see fill_enclosed_holes) -> crop to the
non-transparent bounding box (unless --no-crop) -> resize to match the
reference image's exact pixel dimensions (if --ref given) -> save as an
optimized RGBA PNG.
"""

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import binary_fill_holes

# rembg's saliency model classifies pixels by appearance alone, so a dark
# mesh/grille (an amp's front panel, say) reads as "background" wherever it
# looks enough like the real background behind the object -- even though
# it's fully enclosed within the object's own silhouette. True background,
# in a product photo shot against a plain backdrop, is always reachable
# from the image's own border; an enclosed hole never is. So instead of
# trusting rembg's per-pixel call inside the outline, flood the alpha mask
# in from the border and force anything it *can't* reach back opaque.
def fill_enclosed_holes(rgba: Image.Image) -> Image.Image:
    arr = np.array(rgba)
    solid = arr[:, :, 3] > 0
    filled = binary_fill_holes(solid)  # solid, plus any hole not reachable from the border
    enclosed = filled & ~solid
    if enclosed.any():
        arr[enclosed, 3] = 255
    return Image.fromarray(arr, mode="RGBA")


def remove_bg(input_path: Path, output_path: Path, ref_path: Path | None, no_crop: bool = False) -> None:
    with tempfile.NamedTemporaryFile(suffix=".png") as tmp:
        subprocess.run(["rembg", "i", str(input_path), tmp.name], check=True)
        raw = fill_enclosed_holes(Image.open(tmp.name).convert("RGBA"))

    if no_crop:
        # Keeps the output's pixel grid identical to the source photo's own
        # (no bbox crop at all) -- for a case fill_enclosed_holes couldn't
        # fully clean up (e.g. a mesh/grille whose interior stays partly
        # transparent through a gap too wide to treat as spurious), so a
        # patch cut from the original photo can be pasted straight in at
        # its own coordinates, no crop-offset arithmetic needed.
        cropped = raw
    else:
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
    parser.add_argument("--no-crop", action="store_true",
                         help="skip cropping to content -- output keeps the source photo's exact pixel grid, for manually patching leftover interior transparency back in from the original")
    args = parser.parse_args()

    output = args.output or args.input.with_name(args.input.stem + "_nobg.png")
    remove_bg(args.input, output, args.ref, args.no_crop)


if __name__ == "__main__":
    main()
