import type { CellFeatures, Manifest, ManifestItem } from './types'

const DEFAULT_BASE = import.meta.env.VITE_ASSETS_BASE ?? '/prepared'
const SUPPORTED_VERSION = 3
const FEATURE_KEYS: (keyof CellFeatures)[] = ['hue', 'luminance', 'saturation', 'contrast', 'edgeDensity']

type ManifestFile = {
  version: number
  cellSize: number
  sizes?: number[]
  fields: string[]
  thumbs?: string
  thumbStride?: number
  items: (string | number)[][]
}

export function assetsBase(): string {
  return DEFAULT_BASE.replace(/\/$/, '')
}

/** The smallest published size that still covers `px`, so cells are never upscaled. */
export function sizeFor(manifest: Manifest, px: number): number {
  let best = manifest.cellSize
  for (const s of manifest.sizes) if (s >= px && s < best) best = s
  return best
}

export function cellUrl(manifest: Manifest, id: string, size: number): string {
  const dir = size === manifest.cellSize ? 'cells' : `cells-${size}`
  return `${assetsBase()}/${dir}/${id}.webp`
}

/** index.html preloads this exact URL, so the request must stay a plain CORS GET. */
export async function loadManifest(): Promise<Manifest> {
  const url = `${assetsBase()}/manifest.json`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to load manifest from ${url} (${res.status})`)
  }
  const raw = (await res.json()) as ManifestFile
  if (raw.version !== SUPPORTED_VERSION) {
    throw new Error(`Manifest version ${raw.version} is not supported; run pipeline/publish.py`)
  }
  const col = (name: string) => {
    const i = raw.fields.indexOf(name)
    if (i < 0) throw new Error(`Manifest is missing the "${name}" field`)
    return i
  }
  const idCol = col('id')
  const featureCols = FEATURE_KEYS.map(col)
  const items: ManifestItem[] = raw.items.map((row, index) => {
    const features = {} as CellFeatures
    FEATURE_KEYS.forEach((key, k) => {
      features[key] = Number(row[featureCols[k]])
    })
    return { id: String(row[idCol]), index, features }
  })
  return {
    version: raw.version,
    cellSize: raw.cellSize,
    sizes: [...new Set([raw.cellSize, ...(raw.sizes ?? [])])].sort((a, b) => b - a),
    items,
    thumbs:
      raw.thumbs && raw.thumbStride ? { url: `${assetsBase()}/${raw.thumbs}`, stride: raw.thumbStride } : null,
  }
}
