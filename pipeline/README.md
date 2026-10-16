# Pipeline

Python tools that turn Instagram 3×3 mosaic screenshots into prepared cells + a manifest.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python inspect_archive.py ../sample_imgs
python prepare_archive.py ../sample_imgs \
  --out ../assets/prepared \
  --size 128 \
  --also-copy-to ../site/public/prepared
```

## Denylist

Edit `denylist.json` to exclude `sourceIds` or `cellIds` (e.g. tattoo-heavy mosaics) from the published manifest.

## Production CDN

Upload `assets/prepared/` (cells + `manifest.json`) to Vercel Blob / R2 / S3, then set in `site/`:

```bash
VITE_ASSETS_BASE=https://your-cdn.example.com/prepared
```

Do not commit prepared atlases to git.
