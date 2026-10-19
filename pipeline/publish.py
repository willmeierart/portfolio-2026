#!/usr/bin/env python3
"""
Build the set the site downloads.

Reads `<src>/manifest.json` and `<src>/cells/*.webp` (the output of
prepare_archive.py, after any hand deletions) and writes:

  <out>/manifest.json        compact, version 3
  <out>/cells/<hash>.webp    one small file per picture, full cell size (256px)
  <out>/cells-128/<hash>.webp  the same pictures at 128px, for small screens
  <out>/thumbs/<hash>.bin    a ThumbHash per picture, in manifest order

Rules:
  - A manifest entry whose cell file is gone is dropped. Deleting a webp from
    cells/ is enough to cut it.
  - Denylisted cell ids and source ids are dropped.
  - Near-identical cells (the same photo cut from two mosaics) keep one copy.
  - Filenames are content hashes, so every file can be cached forever. A
    republish writes new names; only the manifest has to be fetched again.
    The hash covers every size of a picture, so changing any one renames all.
  - Every picture gets a ThumbHash (~24 bytes): a blurred preview the site
    paints while the photo is still downloading. They live in one binary file
    the site fetches at low priority, so they never hold up the photos.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

MANIFEST_VERSION = 3
FEATURE_KEYS = ("hue", "luminance", "saturation", "contrast", "edgeDensity")
FIELDS = ("id", *FEATURE_KEYS)


def load_denylist(path: Path) -> tuple[set[str], set[str]]:
    if not path.exists():
        return set(), set()
    data = json.loads(path.read_text())
    return set(data.get("sourceIds", [])), set(data.get("cellIds", []))


def ahash(im: Image.Image) -> bytes:
    small = np.asarray(im.resize((8, 8), Image.Resampling.BOX), dtype=np.float32)
    return (small.mean(axis=2) >= small.mean()).tobytes()


def rmse64(a: Image.Image, b: Image.Image) -> float:
    A = np.asarray(a.resize((64, 64), Image.Resampling.BOX), dtype=np.float32)
    B = np.asarray(b.resize((64, 64), Image.Resampling.BOX), dtype=np.float32)
    return float(np.sqrt(((A - B) ** 2).mean()))


def drop_near_duplicates(items: list[dict], images: dict[str, Image.Image], limit: float) -> list[dict]:
    groups: dict[bytes, list[dict]] = defaultdict(list)
    for it in items:
        groups[ahash(images[it["id"]])].append(it)
    drop: set[str] = set()
    for group in groups.values():
        anchors: list[dict] = []
        for it in group:
            if any(rmse64(images[a["id"]], images[it["id"]]) < limit for a in anchors):
                drop.add(it["id"])
            else:
                anchors.append(it)
    return [it for it in items if it["id"] not in drop]


THUMB_PX = 32


def _round(x: float) -> int:
    return int(np.floor(x + 0.5))


def _dct_channel(ch: np.ndarray, nx: int, ny: int) -> tuple[float, list[float], float]:
    h, w = ch.shape
    xs = np.arange(w) + 0.5
    ys = np.arange(h) + 0.5
    dc, ac, scale = 0.0, [], 0.0
    for cy in range(ny):
        fy = np.cos(np.pi / h * cy * ys)
        cx = 0
        while cx * ny < nx * (ny - cy):
            fx = np.cos(np.pi / w * cx * xs)
            f = float((ch * fy[:, None] * fx[None, :]).sum() / (w * h))
            if cx or cy:
                ac.append(f)
                scale = max(scale, abs(f))
            else:
                dc = f
            cx += 1
    if scale:
        ac = [0.5 + 0.5 / scale * a for a in ac]
    return dc, ac, scale


def thumbhash(im: Image.Image) -> bytes:
    """ThumbHash of an opaque image. Port of rgbaToThumbHash from the `thumbhash` npm package."""
    rgb = np.asarray(im.resize((THUMB_PX, THUMB_PX), Image.Resampling.BOX), dtype=np.float64) / 255.0
    h, w = rgb.shape[:2]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    lx = max(1, _round(7 * w / max(w, h)))
    ly = max(1, _round(7 * h / max(w, h)))
    l_dc, l_ac, l_scale = _dct_channel((r + g + b) / 3, max(3, lx), max(3, ly))
    p_dc, p_ac, p_scale = _dct_channel((r + g) / 2 - b, 3, 3)
    q_dc, q_ac, q_scale = _dct_channel(r - g, 3, 3)
    landscape = int(w > h)
    header24 = (
        _round(63 * l_dc)
        | (_round(31.5 + 31.5 * p_dc) << 6)
        | (_round(31.5 + 31.5 * q_dc) << 12)
        | (_round(31 * l_scale) << 18)
    )
    header16 = (ly if landscape else lx) | (_round(63 * p_scale) << 3) | (_round(63 * q_scale) << 9) | (landscape << 15)
    out = [header24 & 255, (header24 >> 8) & 255, header24 >> 16, header16 & 255, header16 >> 8]
    for i, f in enumerate(l_ac + p_ac + q_ac):
        if i % 2 == 0:
            out.append(0)
        out[-1] |= _round(15 * f) << ((i & 1) * 4)
    return bytes(out)


def main() -> int:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Build the published cell set and manifest")
    parser.add_argument("--src", type=Path, default=here / "../assets/prepared")
    parser.add_argument("--out", type=Path, default=here / "../assets/publish")
    parser.add_argument("--also-copy-to", type=Path, default=here / "../site/public/prepared")
    parser.add_argument("--no-copy", action="store_true", help="skip the local site copy")
    parser.add_argument("--quality", type=int, default=80)
    parser.add_argument(
        "--small-sizes",
        type=int,
        nargs="*",
        default=[128],
        help="extra downscaled sets, written to cells-<px>/",
    )
    parser.add_argument("--denylist", type=Path, default=here / "denylist.json")
    parser.add_argument("--dupe-limit", type=float, default=18.0, help="RMSE on 64px thumbs; 0 disables")
    args = parser.parse_args()

    src_manifest = args.src / "manifest.json"
    cells_dir = args.src / "cells"
    if not src_manifest.is_file() or not cells_dir.is_dir():
        print(f"Expected {src_manifest} and {cells_dir}", file=sys.stderr)
        return 1

    source = json.loads(src_manifest.read_text())
    if source.get("version") == MANIFEST_VERSION:
        print(f"{src_manifest} is already a published manifest. Point --src at assets/prepared.", file=sys.stderr)
        return 1
    cell_px = int(source.get("cellSize", 256))
    deny_sources, deny_cells = load_denylist(args.denylist)

    items: list[dict] = []
    images: dict[str, Image.Image] = {}
    missing = denied = 0
    for it in source["items"]:
        if it.get("excluded"):
            continue
        if it["id"] in deny_cells or it.get("sourceId") in deny_sources:
            denied += 1
            continue
        path = cells_dir / Path(it["asset"]).name
        if not path.is_file():
            missing += 1
            continue
        with Image.open(path) as im:
            img = im.convert("RGB")
        if img.size != (cell_px, cell_px):
            img = img.resize((cell_px, cell_px), Image.Resampling.LANCZOS)
        images[it["id"]] = img
        items.append(it)

    before = len(items)
    if args.dupe_limit > 0:
        items = drop_near_duplicates(items, images, args.dupe_limit)
    dupes = before - len(items)

    out = args.out
    if out.exists():
        shutil.rmtree(out)
    small_sizes = sorted({s for s in args.small_sizes if 0 < s < cell_px}, reverse=True)
    sizes = [cell_px, *small_sizes]
    dirs = {px: ("cells" if px == cell_px else f"cells-{px}") for px in sizes}
    for d in dirs.values():
        (out / d).mkdir(parents=True)

    def encode(img: Image.Image) -> bytes:
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=args.quality, method=6)
        return buf.getvalue()

    rows: list[list] = []
    thumbs: list[bytes] = []
    seen: set[str] = set()
    size_bytes = {px: 0 for px in sizes}
    for it in items:
        img = images[it["id"]]
        encoded = {cell_px: encode(img)}
        for px in small_sizes:
            encoded[px] = encode(img.resize((px, px), Image.Resampling.LANCZOS))
        key = hashlib.sha1(b"".join(encoded[px] for px in sizes)).hexdigest()[:12]
        if key in seen:
            continue
        seen.add(key)
        for px, data in encoded.items():
            (out / dirs[px] / f"{key}.webp").write_bytes(data)
            size_bytes[px] += len(data)
        f = it["features"]
        rows.append([key, *[round(float(f[k]), 3) for k in FEATURE_KEYS]])
        thumbs.append(thumbhash(img))

    stride = len(thumbs[0]) if thumbs else 0
    if any(len(t) != stride for t in thumbs):
        print("ThumbHashes differ in length; cells must all be square.", file=sys.stderr)
        return 1
    thumb_blob = b"".join(thumbs)
    thumb_name = f"thumbs/{hashlib.sha1(thumb_blob).hexdigest()[:12]}.bin"
    (out / "thumbs").mkdir()
    (out / thumb_name).write_bytes(thumb_blob)

    manifest = {
        "version": MANIFEST_VERSION,
        "cellSize": cell_px,
        "sizes": sizes,
        "fields": list(FIELDS),
        "thumbs": thumb_name,
        "thumbStride": stride,
        "items": rows,
    }
    text = json.dumps(manifest, separators=(",", ":"))
    (out / "manifest.json").write_text(text)

    if not args.no_copy and args.also_copy_to:
        dest = args.also_copy_to
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(out, dest)

    print(f"pictures published: {len(rows)}")
    print(f"  missing files:    {missing}")
    print(f"  denylisted:       {denied}")
    print(f"  near duplicates:  {dupes}")
    for px in sizes:
        b = size_bytes[px]
        label = f"{dirs[px]}:"
        print(f"{label:<20}{b / 1e6:.1f} MB, {b / max(len(rows), 1) / 1e3:.1f} KB average ({px}px)")
    print(f"manifest:           {len(text) / 1e3:.0f} KB -> {out / 'manifest.json'}")
    print(f"previews:           {len(thumb_blob) / 1e3:.0f} KB ({stride} bytes each) -> {out / thumb_name}")
    if not args.no_copy and args.also_copy_to:
        print(f"copied to:          {args.also_copy_to.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
