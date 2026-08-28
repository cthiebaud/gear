#!/usr/bin/env python3
"""Extract the dominant body color(s) of a pedal/amp cutout image.

By default, ignores transparent background pixels, then filters out
near-black (knobs, switches, dark text), near-white (labels, highlights),
and desaturated gray/silver (metal hardware, buttons) pixels before
finding the most common remaining color. This targets product cutouts
where the enclosure color is what matters, not its knobs/labels/hardware.

Pass --top N to list the N most common colors instead of just one, and
--include-neutrals to skip the black/white/gray filtering entirely (the
body itself may legitimately be black, white, or silver, or the filter
may be excluding the color you actually want) -- useful together when
the single filtered "dominant" color isn't the one you expected: one of
the top few unfiltered colors usually is.

Usage:
    scripts/dominant_color.py images/*.png
    scripts/dominant_color.py images/ua-1176.png --top 3 --include-neutrals
    scripts/dominant_color.py images/telecaster.png --swatch swatches.png
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ALPHA_MIN = 128          # pixels below this alpha are background, ignored
BLACK_VALUE_MAX = 0.20   # V <= this -> treated as black (knobs, dark text)
WHITE_VALUE_MIN = 0.85   # V >= this and low saturation -> white (labels)
WHITE_SAT_MAX = 0.18
GRAY_SAT_MAX = 0.12      # low saturation at any mid brightness -> silver/gray
BIN_SIZE = 16            # RGB quantization bucket width for the histogram
LOW_CONFIDENCE_FRACTION = 0.05  # below this, too few colorful pixels survived filtering
MIN_DISTANCE = 40        # min RGB euclidean distance between --top picks, so e.g.
                          # three shades of the same gunmetal don't fill the list


def rgb_to_hsv(rgb: np.ndarray) -> np.ndarray:
    """Vectorized RGB[0..1] -> HSV[0..1], shape (...,3) in, (...,3) out."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    maxc = np.max(rgb, axis=-1)
    minc = np.min(rgb, axis=-1)
    v = maxc
    delta = maxc - minc
    s = np.where(maxc == 0, 0, delta / np.where(maxc == 0, 1, maxc))

    rc = np.where(delta == 0, 0, (maxc - r) / np.where(delta == 0, 1, delta))
    gc = np.where(delta == 0, 0, (maxc - g) / np.where(delta == 0, 1, delta))
    bc = np.where(delta == 0, 0, (maxc - b) / np.where(delta == 0, 1, delta))

    h = np.zeros_like(v)
    is_r = (maxc == r) & (delta != 0)
    is_g = (maxc == g) & (delta != 0)
    is_b = (maxc == b) & (delta != 0)
    h = np.where(is_r, bc - gc, h)
    h = np.where(is_g, 2.0 + rc - bc, h)
    h = np.where(is_b, 4.0 + gc - rc, h)
    h = (h / 6.0) % 1.0

    return np.stack([h, s, v], axis=-1)


def top_colors(
    path: Path, top_n: int = 1, include_neutrals: bool = False, min_distance: float = MIN_DISTANCE
) -> tuple[list[tuple[tuple[int, int, int], float]], bool]:
    """Returns ([((r,g,b), fraction_within_candidate_pixels), ...], low_confidence).

    `fraction` is each color's share of the pixels it was ranked among
    (all opaque pixels if include_neutrals, else the non-neutral ones).
    low_confidence is only meaningful when include_neutrals is False: it
    means too few non-neutral pixels survived filtering to trust the
    result (the body is likely black/gray/silver with no real hue).
    """
    im = Image.open(path).convert("RGBA")
    arr = np.asarray(im)
    rgb = arr[..., :3].reshape(-1, 3)
    alpha = arr[..., 3].reshape(-1)

    opaque = alpha >= ALPHA_MIN
    if not opaque.any():
        raise ValueError(f"{path}: no opaque pixels found")
    opaque_rgb = rgb[opaque]

    if include_neutrals:
        candidate_rgb = opaque_rgb
        low_confidence = False
    else:
        hsv = rgb_to_hsv(opaque_rgb.astype(np.float64) / 255.0)
        h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]

        is_black = v <= BLACK_VALUE_MAX
        is_white = (v >= WHITE_VALUE_MIN) & (s <= WHITE_SAT_MAX)
        is_gray = s <= GRAY_SAT_MAX
        keep = ~(is_black | is_white | is_gray)

        candidate_rgb = opaque_rgb[keep]
        fraction_kept = candidate_rgb.shape[0] / opaque_rgb.shape[0]
        low_confidence = fraction_kept < LOW_CONFIDENCE_FRACTION

        # Too few colorful pixels survived filtering to trust a hue; fall
        # back to all opaque pixels so we still report *something*.
        if candidate_rgb.size == 0:
            candidate_rgb = opaque_rgb

    # Quantize into bins to find the most common color regions, then
    # average the true pixel values within each bin for an accurate result.
    binned = (candidate_rgb // BIN_SIZE).astype(np.int32)
    keys = (binned[:, 0] * 4096 + binned[:, 1] * 64 + binned[:, 2])
    uniq, counts = np.unique(keys, return_counts=True)
    order = np.argsort(-counts)

    # Greedily take the largest bins, skipping any whose average color is
    # too close to one already picked -- otherwise --top just returns
    # several near-identical shades of the same dominant tone (e.g. a
    # gunmetal body's own lighting gradient) instead of genuinely
    # different candidate colors.
    picks: list[tuple[np.ndarray, int]] = []
    for idx in order:
        in_bin = keys == uniq[idx]
        dom = candidate_rgb[in_bin].mean(axis=0)
        if all(np.linalg.norm(dom - p) >= min_distance for p, _ in picks):
            picks.append((dom, counts[idx]))
            if len(picks) >= top_n:
                break

    results = [
        ((int(round(dom[0])), int(round(dom[1])), int(round(dom[2]))), count / candidate_rgb.shape[0])
        for dom, count in picks
    ]
    return results, low_confidence


def to_hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("images", nargs="+", type=Path, help="pedal/amp PNG cutouts")
    parser.add_argument("--top", type=int, default=1,
                         help="list this many of the most common colors instead of just one (default: 1)")
    parser.add_argument("--include-neutrals", action="store_true",
                         help="don't filter out black/white/gray pixels before ranking colors")
    parser.add_argument("--min-distance", type=float, default=MIN_DISTANCE,
                         help=f"min RGB distance between --top picks, to avoid near-duplicate "
                              f"shades of the same tone (default: {MIN_DISTANCE})")
    parser.add_argument("--swatch", type=Path, default=None,
                         help="save a strip of color swatches (one per image) for visual review")
    args = parser.parse_args()

    results = []  # (path, [(rgb, fraction), ...])
    for path in args.images:
        try:
            colors, low_confidence = top_colors(path, args.top, args.include_neutrals, args.min_distance)
        except ValueError as exc:
            print(f"{path}: {exc}", file=sys.stderr)
            continue
        results.append((path, colors))

        note = ""
        if low_confidence and not args.include_neutrals:
            note = "  [low confidence: likely black/gray/silver, no real hue -- try --include-neutrals]"
        if args.top == 1:
            (rgb, fraction), = colors
            print(f"{path.name:35s} {to_hex(rgb)}  rgb{rgb}  ({fraction:.0%}){note}")
        else:
            print(f"{path.name}{note}")
            for rgb, fraction in colors:
                print(f"  {to_hex(rgb)}  rgb{str(rgb):18s} {fraction:.0%}")

    if args.swatch and results:
        from PIL import ImageDraw

        cell = 80
        top_n = max(len(colors) for _, colors in results)
        strip = Image.new("RGB", (cell * len(results), cell + 20), "white")
        draw = ImageDraw.Draw(strip)
        for i, (path, colors) in enumerate(results):
            stripe_h = cell / top_n
            for j, (rgb, _fraction) in enumerate(colors):
                y0 = round(j * stripe_h)
                y1 = round((j + 1) * stripe_h)
                draw.rectangle([i * cell, y0, (i + 1) * cell, y1], fill=rgb)
            draw.text((i * cell + 4, cell + 2), path.stem[:12], fill="black")
        strip.save(args.swatch)
        print(f"\nSwatch strip saved to {args.swatch}")


if __name__ == "__main__":
    main()
