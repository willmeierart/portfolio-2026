# Uploading prepared assets (Vercel / CDN)

Prepared cells must not live in git. For production:

1. Run the pipeline against the full archive → `assets/prepared/`.
2. Upload that folder to object storage (Vercel Blob, Cloudflare R2, S3, etc.).
3. Set `VITE_ASSETS_BASE` to the public base URL (no trailing slash), e.g. `https://xxx.public.blob.vercel-storage.com/prepared`.
4. Deploy only `site/` on Vercel (project root = `site`).

Local/dev can keep using `site/public/prepared` via `pipeline/sync_to_site.sh` or `--also-copy-to`.

## Example: Vercel Blob (CLI)

```bash
# from repo root, after prepare
pnpm dlx blob-cli upload --cwd assets/prepared
# then set VITE_ASSETS_BASE in the Vercel project env
```

Exact CLI flags vary by provider — keep the folder layout (`manifest.json` + `cells/*.webp`).
