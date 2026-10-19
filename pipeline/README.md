# Pipeline

Python tools that turn Instagram 3×3 mosaic screenshots into the picture set the site downloads.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 1) Mosaics → 256px cells + features (working set; prune by deleting webps here)
python inspect_archive.py ../sample_imgs
python prepare_archive.py ../sample_imgs --out ../assets/prepared

# 2) Working set → published set (also refreshes ../site/public/prepared for dev)
python publish.py
```

## What `publish.py` writes

`assets/publish/`, uploaded to the CDN as-is:

| Path | Contents | Cache |
|------|----------|-------|
| `manifest.json` | id + color features per picture (version 3) | 60 s |
| `cells/<hash>.webp` | one 256px picture, ~9 KB | immutable |
| `cells-128/<hash>.webp` | the same picture at 128px for small screens, ~3.3 KB (`--small-sizes`) | immutable |
| `thumbs/<hash>.bin` | a 24-byte ThumbHash per picture, in manifest order | immutable |

It drops entries whose webp was deleted, denylisted ids, and near-duplicate cells. Filenames are content hashes, so a republish never overwrites a cached file.

## Denylist

Edit `denylist.json` to exclude `sourceIds` or `cellIds` (e.g. tattoo-heavy mosaics). Both `prepare_archive.py` and `publish.py` honor it.

## Production CDN

See `DEPLOY.md` at the repo root (local only) for the R2 upload, CORS rule and cache headers. Point the site at the bucket with:

```bash
VITE_ASSETS_BASE=https://img.willmeier.cool
```

Never commit `assets/` or `site/public/prepared/`.
