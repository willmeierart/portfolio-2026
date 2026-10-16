#!/usr/bin/env python3
"""Non-destructive inventory of mosaic screenshots."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff"}


def list_images(root: Path) -> list[Path]:
    files = [p for p in sorted(root.iterdir()) if p.is_file() and p.suffix.lower() in IMAGE_EXTS]
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect archive of 3x3 mosaic screenshots")
    parser.add_argument("input_dir", type=Path, help="Directory of source mosaics")
    parser.add_argument("--json-out", type=Path, default=None, help="Optional JSON report path")
    args = parser.parse_args()

    if not args.input_dir.is_dir():
        print(f"Not a directory: {args.input_dir}", file=sys.stderr)
        return 1

    files = list_images(args.input_dir)
    if not files:
        print(f"No images found in {args.input_dir}")
        return 1

    sizes: Counter[tuple[int, int]] = Counter()
    formats: Counter[str] = Counter()
    failures: list[dict] = []
    records: list[dict] = []

    for path in files:
        try:
            with Image.open(path) as im:
                w, h = im.size
                fmt = im.format or path.suffix.lower()
                sizes[(w, h)] += 1
                formats[str(fmt)] += 1
                records.append(
                    {
                        "path": str(path),
                        "width": w,
                        "height": h,
                        "format": fmt,
                        "mode": im.mode,
                        "nearlySquare": abs(w - h) <= max(8, int(0.02 * max(w, h))),
                    }
                )
        except Exception as exc:  # noqa: BLE001 — report and continue
            failures.append({"path": str(path), "error": str(exc)})

    print(f"files: {len(files)}")
    print(f"readable: {len(records)}")
    print(f"failures: {len(failures)}")
    print("formats:")
    for k, v in formats.most_common():
        print(f"  {k}: {v}")
    print("top sizes:")
    for (w, h), v in sizes.most_common(12):
        print(f"  {w}x{h}: {v}")
    nearly = sum(1 for r in records if r["nearlySquare"])
    print(f"nearly square: {nearly}/{len(records)}")

    report = {
        "inputDir": str(args.input_dir.resolve()),
        "fileCount": len(files),
        "readable": len(records),
        "failures": failures,
        "formats": dict(formats),
        "sizes": {f"{w}x{h}": c for (w, h), c in sizes.items()},
        "items": records,
    }
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, indent=2))
        print(f"wrote {args.json_out}")

    return 0 if not failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
