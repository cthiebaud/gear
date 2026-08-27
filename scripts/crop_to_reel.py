#!/usr/bin/env python3
"""Crop a wide recording of the trace cascade down to a vertical Reel,
following the monster's own position exported by index.html?track=1.

Usage:
    scripts/crop_to_reel.py [RECORDING.mov] [TIMELINE.json] [-o OUTPUT.mp4]
        [--zoom 0.35] [--smooth 0.6] [--out-size 1080x1920]

RECORDING.mov and TIMELINE.json are both optional -- omit either (or both)
to use the most recently modified "Screen Recording*.mov" / "monster-track-
*.json" found in the repo root, since typing out either full filename by
hand is tedious and both files always land there.

The timeline is a JSON array of {t, x, y} samples (t in ms since the
cascade started, x/y as fractions 0-1 of #app's own box) -- see
setCascadeActive/trackFrame in app.js. RECORDING.mov must capture #app's
content only (no browser chrome/DevTools panel), or these fractions won't
line up with the video frame.

Pipeline: map fractions to source pixels -> smooth with a centered
(non-causal) moving average, since post-production can look both forward
and backward in time unlike a live camera -> compute a crop rectangle per
output frame -> render it "object-fit: contain" style (crop, scale to fit
the output canvas, center, letterbox as needed) -> re-encode with the
original audio remuxed back in.

Bookending (on by default, see --bookend): before the opening jingle and
after the closing cue, the crop rectangle *is* the entire source frame,
which the same contain-scaling naturally letterboxes into a full-video
view -- no separate code path needed. In between, it smoothly interpolates
(eased, not linear) between that full-frame rectangle and the normal
tracking crop, timed to the opening/closing sound clips' own real
durations, so the zoom lands exactly as the music does.

Note on approach: ffmpeg's `crop` filter declares its x/y options as
timeline-capable, which looks like it should support a `sendcmd`-driven
animated crop -- it doesn't, in this ffmpeg build (`sendcmd` logs "ret:
Function not implemented" for both). Frame-by-frame cropping sidesteps
that entirely and was verified end-to-end against a synthetic test clip
before being trusted here.
"""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
SOUNDS_DIR = REPO_ROOT / "sounds"


def find_latest(pattern: str) -> Path:
    matches = sorted(REPO_ROOT.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    if not matches:
        raise SystemExit(f"no file matching {pattern!r} found in {REPO_ROOT} -- pass it explicitly")
    return matches[0]


def probe(video_path: Path) -> tuple[int, int, float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-of", "csv=p=0:s=x", str(video_path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    w, h, fps_frac = out.split("x")
    num, den = fps_frac.split("/")
    return int(w), int(h), int(num) / int(den)


def probe_duration(media_path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(media_path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return float(out)


def smooth(samples: list[dict], window_s: float) -> list[tuple[float, float, float]]:
    """Centered moving average over a time window, in seconds. samples are
    {t (ms), x, y} sorted by t; returns (t_s, x, y) triples."""
    ts = [s["t"] / 1000 for s in samples]
    half = window_s / 2
    out = []
    lo = hi = 0
    n = len(samples)
    for t in ts:
        while ts[lo] < t - half:
            lo += 1
        while hi < n and ts[hi] <= t + half:
            hi += 1
        window = samples[lo:hi]
        x = sum(s["x"] for s in window) / len(window)
        y = sum(s["y"] for s in window) / len(window)
        out.append((t, x, y))
    return out


def path_at(path_pts: list[tuple[float, float, float]], t: float) -> tuple[float, float]:
    """Linearly interpolates (x, y) at time t from the smoothed path;
    clamps to the first/last sample outside its range."""
    if t <= path_pts[0][0]:
        return path_pts[0][1], path_pts[0][2]
    if t >= path_pts[-1][0]:
        return path_pts[-1][1], path_pts[-1][2]
    lo, hi = 0, len(path_pts) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if path_pts[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    t0, x0, y0 = path_pts[lo]
    t1, x1, y1 = path_pts[hi]
    frac = (t - t0) / (t1 - t0) if t1 > t0 else 0
    return x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac


def crop_dims(src_w: int, src_h: int, zoom: float, out_w: int, out_h: int) -> tuple[int, int]:
    """Largest out_w:out_h-shaped window whose height is zoom*src_h, clamped
    to fit within the source frame on both axes."""
    crop_h = zoom * src_h
    crop_w = crop_h * out_w / out_h
    if crop_w > src_w:
        crop_w = src_w
        crop_h = crop_w * out_h / out_w
    return round(crop_w), round(crop_h)


def ease_in_out(t: float) -> float:
    """Smoothstep -- eases into and out of a transition instead of a
    linear (mechanical-looking) start/stop."""
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


Rect = tuple[float, float, float, float]  # (center_x, center_y, width, height)


def lerp_rect(a: Rect, b: Rect, t: float) -> Rect:
    return tuple(lerp(a[i], b[i], t) for i in range(4))


def tracking_rect(path_pts: list[tuple[float, float, float]], timeline_t: float,
                   src_w: int, src_h: int, crop_w: int, crop_h: int) -> Rect:
    """The normal (non-bookend) tracking crop, centered on the monster's
    smoothed position at a given timeline time (seconds since the cascade
    started -- i.e. video time already adjusted by --offset)."""
    x, y = path_at(path_pts, timeline_t)
    cx, cy = x * src_w, y * src_h
    half_w, half_h = crop_w / 2, crop_h / 2
    cx = min(max(cx, half_w), src_w - half_w)
    cy = min(max(cy, half_h), src_h - half_h)
    return cx, cy, crop_w, crop_h


def render_frame(img: Image.Image, rect: Rect, out_w: int, out_h: int) -> Image.Image:
    """Crops `rect` out of img, then scales it to *fit* (not fill) the
    output canvas, centered on black -- object-fit:contain, same idea as
    the CSS property. Letterboxes when rect's aspect doesn't match the
    output's (the full-frame bookend views, or mid-transition); fills
    exactly with no letterboxing when it does (the normal tracking crop,
    sized to match the output aspect already -- see crop_dims)."""
    cx, cy, w, h = rect
    x0, y0 = cx - w / 2, cy - h / 2
    cropped = img.crop((round(x0), round(y0), round(x0 + w), round(y0 + h)))
    scale = min(out_w / w, out_h / h)
    new_w, new_h = max(1, round(w * scale)), max(1, round(h * scale))
    resized = cropped.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGB", (out_w, out_h), (0, 0, 0))
    canvas.paste(resized, ((out_w - new_w) // 2, (out_h - new_h) // 2))
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("recording", type=Path, nargs="?", default=None,
                         help="default: newest Screen Recording*.mov in the repo root")
    parser.add_argument("timeline", type=Path, nargs="?", default=None,
                         help="default: newest monster-track-*.json in the repo root")
    parser.add_argument("-o", "--output", type=Path, default=None,
                         help="output video path (default: <recording stem>_reel.mp4 next to input)")
    parser.add_argument("--zoom", type=float, default=1,
                         help="crop height as a fraction of the source video's height -- lower is more zoomed in (default: 0.35)")
    parser.add_argument("--smooth", type=float, default=2,
                         help="centered smoothing window, in seconds (default: 0.6)")
    parser.add_argument("--out-size", default="1080x1920",
                         help="final output resolution, WxH (default: 1080x1920)")
    parser.add_argument("--fps", type=float, default=30,
                         help="output frame rate -- resampled down from the recording's own "
                              "native rate (screen recordings often land on some odd variable "
                              "rate like 55fps, not a clean 60) at extraction time, via ffmpeg's "
                              "own fps filter. Doesn't affect --offset-frames/--end-offset-frames, "
                              "which stay in the recording's own native frames (matching "
                              "QuickTime's own timecode display) regardless (default: 30 -- plenty "
                              "for content with no slow-motion need, and meaningfully smaller/"
                              "faster to render than the source's own rate)")
    offset_group = parser.add_mutually_exclusive_group()
    offset_group.add_argument("--offset", type=float, default=None,
                               help="seconds into the recording where the cascade actually "
                                    "started (the timeline's own t=0) -- e.g. scrub to when the "
                                    "stationary monster first appears at the guitar's jack, or "
                                    "when the opening jingle starts")
    offset_group.add_argument("--offset-frames", type=int, default=None,
                               help="same as --offset, but as a frame count -- QuickTime Player's "
                                    "timecode display (Tools > Show Timecode, or the trim view) "
                                    "shows this more precisely than reading off seconds by eye")
    parser.add_argument("--bookend", action=argparse.BooleanOptionalAction, default=True,
                         help="start/end on the whole video, object-fit:contain style (letterboxed, "
                              "centered), zooming smoothly in/out around the opening/closing music "
                              "(default: on -- pass --no-bookend for the plain tracking crop only, "
                              "the original behavior)")
    end_offset_group = parser.add_mutually_exclusive_group()
    end_offset_group.add_argument("--end-offset", type=float, default=None,
                                   help="seconds into the recording where the closing music starts "
                                        "-- default: start offset + the timeline's own last "
                                        "timestamp, since the cascade ending and the closing cue "
                                        "starting happen back-to-back (see setCascadeActive/"
                                        "exportTracking in app.js), so this is normally accurate "
                                        "without needing to scrub for it separately")
    end_offset_group.add_argument("--end-offset-frames", type=int, default=None,
                                   help="same as --end-offset, but as a frame count")
    parser.add_argument("--outro-sound", choices=["intermission", "death"], default="intermission",
                         help="which closing cue actually played in this take -- determines the "
                              "de-zoom's own duration, to match (default: intermission, i.e. the "
                              "cascade ran to its natural end; pass death if you stopped it early)")
    parser.add_argument("--outro-hold", type=float, default=2.5,
                         help="seconds to hold the final full-video view before cutting the output "
                              "-- everything past that point in the recording (the download popup, "
                              "you stopping QuickTime, ...) is simply never processed. Only applies "
                              "with --bookend; ignored with --no-bookend, since there's no de-zoom "
                              "to hold after (default: 2.5)")
    parser.add_argument("--watermark", action=argparse.BooleanOptionalAction, default=True,
                         help="overlay --watermark-image in the bottom-right corner of every output "
                              "frame, at a fixed pixel size/position regardless of the tracking "
                              "crop's own zoom (default: on -- pass --no-watermark to skip it)")
    parser.add_argument("--watermark-image", type=Path, default=REPO_ROOT / "images" / "ct_watermark.png",
                         help="watermark PNG, transparency respected (default: images/ct_watermark.png)")
    parser.add_argument("--watermark-size", type=int, default=60,
                         help="watermark width in output pixels, aspect preserved (default: 60)")
    parser.add_argument("--watermark-margin", type=int, default=30,
                         help="gap from the output frame's right/bottom edges, in pixels (default: 30)")
    args = parser.parse_args()

    if args.recording is None:
        args.recording = find_latest("Screen Recording*.mov")
        print(f"No recording given -- using newest: {args.recording.name}")
    if args.timeline is None:
        args.timeline = find_latest("monster-track-*.json")
        print(f"No timeline given -- using newest: {args.timeline.name}")

    out_w, out_h = (int(v) for v in args.out_size.split("x"))
    output = args.output or args.recording.with_name(args.recording.stem + "_reel.mp4")

    watermark = wm_pos = None
    if args.watermark:
        watermark = Image.open(args.watermark_image).convert("RGBA")
        wm_h = round(watermark.height * args.watermark_size / watermark.width)
        watermark = watermark.resize((args.watermark_size, wm_h), Image.LANCZOS)
        wm_pos = (out_w - watermark.width - args.watermark_margin,
                  out_h - watermark.height - args.watermark_margin)

    samples = json.loads(args.timeline.read_text())
    if not samples:
        raise SystemExit(f"{args.timeline}: empty timeline")

    src_w, src_h, src_fps = probe(args.recording)
    out_fps = args.fps
    offset = args.offset_frames / src_fps if args.offset_frames is not None else (args.offset or 0.0)
    crop_w, crop_h = crop_dims(src_w, src_h, args.zoom, out_w, out_h)
    path_pts = smooth(samples, args.smooth)

    if args.end_offset_frames is not None:
        end_offset = args.end_offset_frames / src_fps
    elif args.end_offset is not None:
        end_offset = args.end_offset
    else:
        end_offset = offset + path_pts[-1][0]

    intro_duration = probe_duration(SOUNDS_DIR / "pacman_beginning.mp3") if args.bookend else 0.0
    outro_file = "pacman_intermission.mp3" if args.outro_sound == "intermission" else "pacman_death.mp3"
    outro_duration = probe_duration(SOUNDS_DIR / outro_file) if args.bookend else 0.0
    # Keeps the four phases (full -> zoom-in -> tracking -> zoom-out) in
    # order even if the actual tracked cascade ran shorter than the intro
    # jingle itself -- an edge case real footage won't hit (the cascade
    # always runs many seconds longer than either cue), but without this
    # a too-short gap between end_offset and offset+intro_duration would
    # invert the outro's own start, jumping instead of easing into it.
    end_offset = max(end_offset, offset + intro_duration)

    # Real footage is never extracted past the outro cue's own natural end.
    # exportTracking's monster-track-*.json download (see app.js) can't
    # fire any earlier than that -- it's chained off the outro sound's own
    # finished promise, then whenOneShotsIdle() -- so this is the latest
    # moment provably still clean of the save/download popup, the
    # subsequent QuickTime-stopping, etc., regardless of how long any
    # trailing one-shot tail (an eatfruit sound...) adds on top of it.
    real_cutoff = (end_offset + outro_duration) if args.bookend else None

    full_rect: Rect = (src_w / 2, src_h / 2, src_w, src_h)

    def rect_at(t: float) -> Rect:
        if not args.bookend:
            return tracking_rect(path_pts, t - offset, src_w, src_h, crop_w, crop_h)
        if t < offset:
            return full_rect
        if t < offset + intro_duration:
            frac = ease_in_out((t - offset) / intro_duration)
            target = tracking_rect(path_pts, intro_duration, src_w, src_h, crop_w, crop_h)
            return lerp_rect(full_rect, target, frac)
        if t < end_offset:
            return tracking_rect(path_pts, t - offset, src_w, src_h, crop_w, crop_h)
        if t < end_offset + outro_duration:
            frac = ease_in_out((t - end_offset) / outro_duration)
            start = tracking_rect(path_pts, end_offset - offset, src_w, src_h, crop_w, crop_h)
            return lerp_rect(start, full_rect, frac)
        return full_rect

    with tempfile.TemporaryDirectory() as tmp:
        raw_dir, cropped_dir = Path(tmp, "raw"), Path(tmp, "cropped")
        raw_dir.mkdir()
        cropped_dir.mkdir()

        print("Extracting frames..." + (f" (cutting at {real_cutoff:.1f}s)" if real_cutoff is not None else ""))
        extract_cmd = ["ffmpeg", "-y"]
        if real_cutoff is not None:
            extract_cmd += ["-t", str(real_cutoff)]  # input option -- skips decoding the discarded tail entirely, not just trimming after
        extract_cmd += ["-i", str(args.recording), "-vf", f"fps={out_fps}", "-qscale:v", "3", str(raw_dir / "f_%06d.jpg")]
        subprocess.run(extract_cmd,
            check=True, capture_output=True,
        )

        frame_paths = sorted(raw_dir.glob("f_*.jpg"))
        if not frame_paths:
            raise SystemExit("no frames extracted -- check the recording is a valid video")
        # outro-hold seconds beyond real_cutoff are never decoded from the
        # recording (that's the whole point -- the popup lands seconds
        # into that window) -- instead the last real frame (by then already
        # the full, letterboxed bookend view) is simply repeated as a
        # freeze-frame for the remaining count.
        freeze_count = round(args.outro_hold * out_fps) if args.bookend else 0
        total_frames = len(frame_paths) + freeze_count
        print(f"Cropping {total_frames} frames..." + (f" ({freeze_count} frozen)" if freeze_count else ""))
        last_img = None
        for i in range(total_frames):
            rect = rect_at(i / out_fps)
            if i < len(frame_paths):
                last_img = Image.open(frame_paths[i])
            out_frame = render_frame(last_img, rect, out_w, out_h)
            if watermark is not None:
                out_frame.paste(watermark, wm_pos, watermark)  # watermark's own alpha as the paste mask -- fixed size/position, independent of rect's zoom
            out_frame.save(cropped_dir / f"f_{i + 1:06d}.jpg", quality=95)
            if i % 100 == 0:
                print(f"  {i}/{total_frames}")

        print("Re-encoding...")
        subprocess.run(
            ["ffmpeg", "-y", "-framerate", str(out_fps), "-i", str(cropped_dir / "f_%06d.jpg"),
             "-i", str(args.recording), "-map", "0:v", "-map", "1:a?",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
             str(output)],
            check=True, capture_output=True,
        )

    print(f"{args.recording} -> {output} (crop {crop_w}x{crop_h} -> {out_w}x{out_h}, "
          f"fps={out_fps} (source: {src_fps:.2f}), zoom={args.zoom}, smooth={args.smooth}s, "
          f"offset={offset:.3f}s, bookend={args.bookend}, end_offset={end_offset:.3f}s)")


if __name__ == "__main__":
    main()
