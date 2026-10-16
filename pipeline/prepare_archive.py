#!/usr/bin/env python3
"""Split 3x3 Instagram mosaics into clean single cells (no gutters / UI chrome)."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}
DATASET_VERSION = 2


def source_id_for(path: Path) -> str:
    return hashlib.sha1(path.name.encode("utf-8")).hexdigest()[:12]


def load_denylist(path: Path | None) -> tuple[set[str], set[str]]:
    if path is None or not path.exists():
        return set(), set()
    data = json.loads(path.read_text())
    return set(data.get("sourceIds", [])), set(data.get("cellIds", []))


def to_rgb_array(im: Image.Image) -> np.ndarray:
    return np.asarray(im.convert("RGB"), dtype=np.uint8)


def find_content_bbox(arr: np.ndarray, threshold: int = 18) -> tuple[int, int, int, int]:
    lum = arr.mean(axis=2)
    mask = lum > threshold
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    if len(rows) == 0 or len(cols) == 0:
        h, w = lum.shape
        return 0, 0, w, h
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def refine_gutter(profile: np.ndarray, approx: int, search: int = 8) -> tuple[int, int]:
    """
    Instagram gutters are thin dark lines near equal thirds.
    Search a narrow window around `approx` and return (center, half_width).
    """
    n = len(profile)
    lo = max(0, approx - search)
    hi = min(n, approx + search + 1)
    window = profile[lo:hi]
    if window.size == 0:
        return approx, 1

    # Prefer the darkest contiguous run that is thin
    dark = window < 45
    best_center = int(np.argmin(window)) + lo
    best_score = float(window.min())

    # Expand to measure gutter thickness around darkest pixel
    i = best_center
    while i > 0 and profile[i - 1] < 55:
        i -= 1
    j = best_center
    while j < n - 1 and profile[j + 1] < 55:
        j += 1
    thickness = j - i + 1
    # If "gutter" is huge, it's image content — fall back to approx with 1px pad
    if thickness > 10 or best_score > 60:
        return approx, 2
    half = max(1, thickness // 2 + 1)
    return (i + j) // 2, half


def find_regular_gutters(arr: np.ndarray) -> tuple[list[int], list[int], list[int], list[int]]:
    """Equal-third gutters refined to thin dark lines. Returns vx, hy, vx_pad, hy_pad."""
    h, w = arr.shape[:2]
    col_min = arr.min(axis=(0, 2)).astype(np.float64)
    row_min = arr.min(axis=(1, 2)).astype(np.float64)

    vx, vx_pad = [], []
    hy, hy_pad = [], []
    for k in (1, 2):
        cx, px = refine_gutter(col_min, int(round(w * k / 3.0)), search=max(6, w // 80))
        cy, py = refine_gutter(row_min, int(round(h * k / 3.0)), search=max(6, h // 80))
        vx.append(cx)
        vx_pad.append(px)
        hy.append(cy)
        hy_pad.append(py)

    # Sanity: gutters must be roughly evenly spaced
    if abs((vx[1] - vx[0]) - (w / 3)) > w * 0.12:
        vx = [w // 3, 2 * w // 3]
        vx_pad = [2, 2]
    if abs((hy[1] - hy[0]) - (h / 3)) > h * 0.12:
        hy = [h // 3, 2 * h // 3]
        hy_pad = [2, 2]
    return vx, hy, vx_pad, hy_pad


def cell_rects(
    w: int,
    h: int,
    vx: list[int],
    hy: list[int],
    vx_pad: list[int],
    hy_pad: list[int],
) -> list[tuple[int, int, int, int]]:
    xs = [0, vx[0], vx[1], w]
    ys = [0, hy[0], hy[1], h]
    # per-boundary pads
    xpad = [0, vx_pad[0], vx_pad[1], 0]
    ypad = [0, hy_pad[0], hy_pad[1], 0]

    rects: list[tuple[int, int, int, int]] = []
    for row in range(3):
        for col in range(3):
            x0 = xs[col] + xpad[col]
            x1 = xs[col + 1] - xpad[col + 1]
            y0 = ys[row] + ypad[row]
            y1 = ys[row + 1] - ypad[row + 1]

            cw, ch = max(1, x1 - x0), max(1, y1 - y0)
            # Aggressive inset: kills gutters, rounded corners, most IG chrome
            inset_x = max(4, int(cw * 0.08))
            inset_y = max(4, int(ch * 0.08))
            # Extra top-right for play / carousel / more icons
            tr_x = max(inset_x, int(cw * 0.16))
            tr_y = max(inset_y, int(ch * 0.14))

            x0i = x0 + inset_x
            y0i = y0 + tr_y
            x1i = x1 - tr_x
            y1i = y1 - inset_y

            if x1i - x0i < cw * 0.5 or y1i - y0i < ch * 0.5:
                x0i, y0i = x0 + inset_x, y0 + inset_y
                x1i, y1i = x1 - inset_x, y1 - inset_y
            rects.append((x0i, y0i, x1i, y1i))
    return rects


def scrub_chrome(cell: Image.Image) -> Image.Image:
    """
    Obliterate residual bright IG icons in the top-right corner by cloning
    nearby interior pixels — no generative fill, just local copy.
    """
    arr = to_rgb_array(cell).copy()
    h, w = arr.shape[:2]
    zone_w = max(8, int(w * 0.22))
    zone_h = max(8, int(h * 0.18))
    zone = arr[0:zone_h, w - zone_w : w]
    lum = zone.mean(axis=2)

    # Bright-and-compact = icon candidate
    bright = lum > 175
    if bright.mean() < 0.02:
        return cell

    # Sample patch from just inside the safe area
    src = arr[zone_h : min(h, zone_h + zone_h), w - zone_w * 2 : w - zone_w]
    if src.size == 0:
        return cell
    fill = np.median(src.reshape(-1, 3), axis=0).astype(np.uint8)

    # Softly replace bright pixels and a small neighborhood
    yy, xx = np.where(bright)
    for y, x in zip(yy, xx, strict=False):
        y0, y1 = max(0, y - 1), min(zone_h, y + 2)
        x0, x1 = max(0, x - 1), min(zone_w, x + 2)
        zone[y0:y1, x0:x1] = fill

    arr[0:zone_h, w - zone_w : w] = zone
    return Image.fromarray(arr, mode="RGB")


def looks_like_intersection(cell: Image.Image) -> bool:
    """Reject crops that still contain a strong cross of gutters."""
    arr = to_rgb_array(cell).astype(np.float64)
    h, w = arr.shape[:2]
    lum = arr.mean(axis=2)
    # Middle third cross test
    mid_x = lum[:, w // 2 - 1 : w // 2 + 2].mean()
    mid_y = lum[h // 2 - 1 : h // 2 + 2, :].mean()
    overall = lum.mean()
    # Dark cross relative to content → intersection framing
    return (overall - mid_x > 35 and overall - mid_y > 35) or (mid_x < 25 and mid_y < 25)


def extract_features(cell: Image.Image) -> dict[str, float]:
    arr = to_rgb_array(cell).astype(np.float64) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = np.where(mx > 1e-6, (mx - mn) / (mx + 1e-6), 0.0)
    hue = np.zeros_like(lum)
    d = mx - mn + 1e-6
    mask = mx == r
    hue[mask] = ((g[mask] - b[mask]) / d[mask]) % 6
    mask = mx == g
    hue[mask] = (b[mask] - r[mask]) / d[mask] + 2
    mask = mx == b
    hue[mask] = (r[mask] - g[mask]) / d[mask] + 4
    hue = (hue / 6.0) % 1.0

    gray = (lum * 255).astype(np.uint8)
    dx = np.abs(gray.astype(np.int16)[:, 1:] - gray.astype(np.int16)[:, :-1])
    dy = np.abs(gray.astype(np.int16)[1:, :] - gray.astype(np.int16)[:-1, :])
    edge = float(((dx > 24).mean() + (dy > 24).mean()) / 2.0)

    ang = hue * 2 * math.pi
    w = sat + 1e-6
    hx = float((np.cos(ang) * w).sum() / w.sum())
    hy = float((np.sin(ang) * w).sum() / w.sum())
    hue_mean = (math.atan2(hy, hx) / (2 * math.pi)) % 1.0

    return {
        "luminance": float(lum.mean()),
        "saturation": float(sat.mean()),
        "hue": hue_mean,
        "contrast": float(lum.std()),
        "edgeDensity": edge,
    }


def build_contact_sheet(
    pairs: list[tuple[Image.Image, list[Image.Image], str]],
    out_path: Path,
    thumb: int = 120,
) -> None:
    if not pairs:
        return
    mosaic_w = thumb * 3
    cell_w = thumb
    gap = 8
    width = mosaic_w + gap + cell_w * 3 + gap * 2
    height = len(pairs) * (thumb * 3 + gap) + gap
    sheet = Image.new("RGB", (width, height), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()

    y = gap
    for src, cells, label in pairs:
        sheet.paste(src.resize((mosaic_w, mosaic_w), Image.Resampling.LANCZOS), (gap, y))
        for i, cell in enumerate(cells):
            cx = gap + mosaic_w + gap + (i % 3) * cell_w
            cy = y + (i // 3) * cell_w
            sheet.paste(cell.resize((cell_w, cell_w), Image.Resampling.LANCZOS), (cx, cy))
        draw.text((gap, y + mosaic_w - 12), label[:48], fill=(220, 220, 220), font=font)
        y += mosaic_w + gap

    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path, quality=90)


def process_one(
    path: Path,
    out_cells: Path,
    size: int,
    denylist_sources: set[str],
    quality: int = 92,
) -> tuple[list[dict], list[Image.Image], Image.Image] | None:
    sid = source_id_for(path)
    if sid in denylist_sources:
        return None

    with Image.open(path) as im:
        rgb = im.convert("RGB")
        arr = to_rgb_array(rgb)
        x0, y0, x1, y1 = find_content_bbox(arr)
        cropped = rgb.crop((x0, y0, x1, y1))
        carr = to_rgb_array(cropped)
        h, w = carr.shape[:2]

        vx, hy, vx_pad, hy_pad = find_regular_gutters(carr)
        rects = cell_rects(w, h, vx, hy, vx_pad, hy_pad)

        items: list[dict] = []
        cell_imgs: list[Image.Image] = []
        for idx, (cx0, cy0, cx1, cy1) in enumerate(rects):
            cell = cropped.crop((cx0, cy0, cx1, cy1))
            cell = scrub_chrome(cell)
            cell = cell.resize((size, size), Image.Resampling.LANCZOS)
            excluded = bool(looks_like_intersection(cell))
            features = extract_features(cell)
            cid = f"{sid}:{idx:02d}"
            fname = f"{sid}-{idx:02d}.webp"
            cell.save(out_cells / fname, "WEBP", quality=quality, method=6)
            items.append(
                {
                    "id": cid,
                    "sourceId": sid,
                    "cellIndex": idx,
                    "sourceFile": path.name,
                    "crop": [int(cx0), int(cy0), int(cx1), int(cy1)],
                    "asset": f"cells/{fname}",
                    "features": features,
                    "excluded": excluded,
                }
            )
            cell_imgs.append(cell)

        return items, cell_imgs, cropped


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare 3x3 mosaic archive into cells")
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--size", type=int, default=256)
    parser.add_argument("--quality", type=int, default=92)
    parser.add_argument("--denylist", type=Path, default=Path(__file__).with_name("denylist.json"))
    parser.add_argument("--contact-limit", type=int, default=12)
    parser.add_argument("--also-copy-to", type=Path, default=None)
    args = parser.parse_args()

    if not args.input_dir.is_dir():
        print(f"Not a directory: {args.input_dir}", file=sys.stderr)
        return 1

    denylist_sources, denylist_cells = load_denylist(args.denylist)
    out = args.out
    cells_dir = out / "cells"
    if cells_dir.exists():
        shutil.rmtree(cells_dir)
    cells_dir.mkdir(parents=True, exist_ok=True)

    files = [p for p in sorted(args.input_dir.iterdir()) if p.is_file() and p.suffix.lower() in IMAGE_EXTS]
    all_items: list[dict] = []
    contact_pairs: list[tuple[Image.Image, list[Image.Image], str]] = []
    failures: list[dict] = []
    skipped = 0
    rejected = 0

    for path in files:
        try:
            result = process_one(path, cells_dir, args.size, denylist_sources, args.quality)
            if result is None:
                skipped += 1
                continue
            items, cell_imgs, cropped = result
            for item in items:
                if item["id"] in denylist_cells:
                    item["excluded"] = True
                if item["excluded"]:
                    rejected += 1
            all_items.extend(items)
            if len(contact_pairs) < args.contact_limit:
                contact_pairs.append((cropped, cell_imgs, path.name))
        except Exception as exc:  # noqa: BLE001
            failures.append({"path": str(path), "error": str(exc)})
            print(f"FAIL {path.name}: {exc}", file=sys.stderr)

    published = [i for i in all_items if not i["excluded"]]
    manifest = {
        "datasetVersion": DATASET_VERSION,
        "cellSize": args.size,
        "sourceCount": len(files) - skipped,
        "cellCount": len(published),
        "excludedCount": len(all_items) - len(published),
        "items": published,
        "failures": failures,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    build_contact_sheet(contact_pairs, out / "contact_sheet.jpg")

    if args.also_copy_to:
        dest = args.also_copy_to
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(out, dest)

    print(f"sources processed: {len(files) - skipped}")
    print(f"skipped denylist sources: {skipped}")
    print(f"cells published: {len(published)}")
    print(f"intersection rejects: {rejected}")
    print(f"failures: {len(failures)}")
    print(f"manifest: {out / 'manifest.json'}")
    return 0 if not failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
