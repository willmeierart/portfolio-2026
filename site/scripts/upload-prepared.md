# Uploading the picture set (CDN)

Pictures must not live in git. For production:

1. Run `pipeline/publish.py` → `assets/publish/` (`manifest.json`, `cells/`, `cells-128/`, `thumbs/`).
2. Upload that folder to object storage (Cloudflare R2). Both cell folders and thumbs first with
   `Cache-Control: public, max-age=31536000, immutable`, then `manifest.json` with
   `Cache-Control: public, max-age=60`.
3. Add a CORS rule allowing `GET`/`HEAD` from the site's origin. The site fetches the
   pictures with `fetch()` and draws them in WebGL; without CORS every request is blocked.
4. Set `VITE_ASSETS_BASE` to the public base URL (no trailing slash), e.g. `https://img.willmeier.cool`.
5. Deploy only `site/` on Vercel (project root = `site`).

Local/dev uses `site/public/prepared`, which `publish.py` refreshes on every run.
