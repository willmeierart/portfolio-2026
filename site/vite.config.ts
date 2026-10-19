import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type HtmlTagDescriptor, type Plugin } from 'vite'

/**
 * Start the manifest download while the HTML is parsed, in parallel with the
 * script bundle, instead of after the bundle has run. With a CDN origin, the
 * connection is opened up front too. The preload has to match the app's
 * `fetch(url)` (CORS, no credentials) or the browser downloads it twice.
 */
function assetHints(base: string): Plugin {
  let outDir = 'dist'
  return {
    name: 'asset-hints',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    // public/prepared is the local dev copy of the CDN. A CDN build must not ship it.
    closeBundle() {
      if (/^https?:\/\//.test(base)) rmSync(resolve(outDir, 'prepared'), { recursive: true, force: true })
    },
    transformIndexHtml() {
      const tags: HtmlTagDescriptor[] = []
      if (/^https?:\/\//.test(base)) {
        tags.push({
          tag: 'link',
          attrs: { rel: 'preconnect', href: new URL(base).origin, crossorigin: 'anonymous' },
          injectTo: 'head-prepend',
        })
      }
      tags.push({
        tag: 'link',
        attrs: {
          rel: 'preload',
          href: `${base}/manifest.json`,
          as: 'fetch',
          crossorigin: 'anonymous',
          fetchpriority: 'high',
        },
        injectTo: 'head-prepend',
      })
      return tags
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const assetsBase = (env.VITE_ASSETS_BASE || '/prepared').replace(/\/$/, '')
  return {
    plugins: [react(), assetHints(assetsBase)],
    server: {
      port: 5173,
      watch: {
        usePolling: true,
        interval: 400,
      },
      fs: {
        allow: ['..'],
      },
    },
    preview: {
      port: 4173,
    },
  }
})
