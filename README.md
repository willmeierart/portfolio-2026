# Portfolio 2026

Interactive artwork / personal site. One git root, two packages:

| Path | Role |
|------|------|
| `site/` | Vite + React + Three.js app (deploy on Vercel) |
| `pipeline/` | Python intake: 3×3 mosaics → cells + manifest |

Originals and prepared atlases are **gitignored**. AI plan dumps stay local / ignored.

## Quick start

```bash
# 1) Prepare sample mosaics (once)
cd pipeline
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python inspect_archive.py ../sample_imgs
python prepare_archive.py ../sample_imgs \
  --out ../assets/prepared \
  --size 128 \
  --also-copy-to ../site/public/prepared

# 2) Run the site
cd ../site
pnpm install
pnpm dev
```

Open http://127.0.0.1:5173 — move the pointer to reorganize; click or press Enter for identity overlay. Dev panel (bottom-left) toggles sort / transition / atmosphere / gyro.

## Tattoo / content exclusion

Edit `pipeline/denylist.json` (`sourceIds` / `cellIds`), then re-run `prepare_archive.py`.

## Vercel + CDN

- Vercel project root: `site/`
- Do **not** commit `site/public/prepared/`
- Upload `assets/prepared/` to Blob/R2/S3 and set `VITE_ASSETS_BASE` (see `site/.env.example` and `site/scripts/upload-prepared.md`)

## Cursor rules

- User-global: never co-author commits (`~/.cursor/rules/no-co-author-commits.mdc`)
- Project: no silent assumptions, no shipping AI artifacts or image archives (`.cursor/rules/portfolio-2026.mdc`)
