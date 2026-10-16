import type { CellFeatures, FeatureKey, ManifestItem } from '../data/types'

export type OrgWeights = {
  hue: number
  luminance: number
  saturation: number
  edgeDensity: number
  contrast: number
}

/** Pointer in [0,1]² → blend of feature weights (deterministic). */
export function weightsFromPointer(nx: number, ny: number): OrgWeights {
  const x = clamp01(nx)
  const y = clamp01(ny)
  return {
    hue: 0.15 + x * 0.85,
    luminance: 0.15 + y * 0.85,
    saturation: 0.15 + (1 - x) * 0.55,
    edgeDensity: 0.1 + (1 - y) * 0.7,
    contrast: 0.1 + Math.abs(x - y) * 0.6,
  }
}

export function scoreItem(item: ManifestItem, weights: OrgWeights): number {
  const f = item.features
  return (
    weights.hue * circularDistance(f.hue, 0) * -1 +
    weights.luminance * f.luminance +
    weights.saturation * f.saturation +
    weights.edgeDensity * f.edgeDensity +
    weights.contrast * f.contrast
  )
}

export function sortByFeature(items: ManifestItem[], key: FeatureKey): ManifestItem[] {
  return [...items].sort((a, b) => {
    if (key === 'hue') return a.features.hue - b.features.hue
    return a.features[key] - b.features[key]
  })
}

export function sortByWeights(items: ManifestItem[], weights: OrgWeights): ManifestItem[] {
  return [...items]
    .map((item) => ({ item, s: scoreItem(item, weights) }))
    .sort((a, b) => a.s - b.s)
    .map((x) => x.item)
}

/* ------------------------------------------------------------------ */
/* Palette world                                                       */
/* ------------------------------------------------------------------ */

export type PaletteIndex = { pts: Float32Array }

/**
 * Every item becomes a point in (chroma-x, chroma-y, luminance) space.
 * Luminance and saturation are rank-normalised so the whole archive
 * covers the space evenly regardless of how the raw features are skewed.
 */
export function buildPaletteIndex(items: ManifestItem[]): PaletteIndex {
  const n = items.length
  const rank = (key: 'luminance' | 'saturation'): Float32Array => {
    const order = items.map((_, i) => i).sort((a, b) => items[a].features[key] - items[b].features[key])
    const r = new Float32Array(n)
    order.forEach((idx, pos) => {
      r[idx] = n > 1 ? pos / (n - 1) : 0.5
    })
    return r
  }
  const lr = rank('luminance')
  const sr = rank('saturation')
  const pts = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const ang = items[i].features.hue * Math.PI * 2
    const s = sr[i] * 0.8
    pts[i * 3] = Math.cos(ang) * s
    pts[i * 3 + 1] = Math.sin(ang) * s
    pts[i * 3 + 2] = lr[i]
  }
  return { pts }
}

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Smooth, non-repeating palette target for a world cell. */
function paletteTarget(wx: number, wy: number, ph: number): [number, number, number] {
  const a =
    0.5 +
    0.34 * Math.sin(wx * 0.17 + wy * 0.11 + ph * 0.9) +
    0.24 * Math.sin(wx * 0.07 - wy * 0.19 + ph * 0.5 + 1.3) +
    0.14 * Math.sin(wx * 0.29 + wy * 0.23 - ph * 0.7 + 2.9)
  const ang = a * Math.PI * 2
  const s = 0.8 * (0.5 + 0.5 * Math.sin(wx * 0.13 - wy * 0.08 + ph * 0.4 + 2.0))
  const l =
    0.5 +
    0.46 * Math.sin(wx * 0.09 + wy * 0.14 + ph * 0.6 + 4.0) * Math.cos(wx * 0.05 - wy * 0.04 - ph * 0.3)
  return [Math.cos(ang) * s, Math.sin(ang) * s, l]
}

/**
 * Deterministic world: cell (gx, gy) always resolves to the same image for a
 * given palette phase. Each cell takes the best of K hashed candidates drawn
 * from the WHOLE archive, so a viewport is varied but regionally coherent, and
 * travelling (or advancing `phase`) drifts through the full colour space.
 */
export function sampleWorldPalette(
  items: ManifestItem[],
  index: PaletteIndex,
  cols: number,
  rows: number,
  originX: number,
  originY: number,
  phase: number,
  candidates = 40,
  /**
   * Re-rolls every cell's candidate pool. It only ever increases as you travel, so
   * a cell you come back to draws from a pool it has never drawn from before
   * (nudging `phase` alone just walks a fixed pool of 40 and often lands on the
   * same pick again).
   */
  epoch = 0,
): ManifestItem[] {
  const n = items.length
  const out: ManifestItem[] = new Array(cols * rows)
  if (n === 0) return out
  const pts = index.pts
  const ph = phase * 0.35
  const salt = epoch * 1013

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const gx = Math.floor(originX) + x
      const gy = Math.floor(originY) + y
      const [tx, ty, tz] = paletteTarget(gx, gy, ph)
      let best = 0
      let bestD = Infinity
      for (let k = 0; k < candidates; k++) {
        const i = hash3(gx, gy, k + 1 + salt) % n
        const dx = pts[i * 3] - tx
        const dy = pts[i * 3 + 1] - ty
        const dz = pts[i * 3 + 2] - tz
        const d = dx * dx + dy * dy + dz * dz
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      out[y * cols + x] = items[best]
    }
  }
  return out
}

/**
 * Unique viewport from a pre-sorted field (used by the debug sort modes).
 */
export function sampleInfiniteField(
  field: ManifestItem[],
  cols: number,
  rows: number,
  originX: number,
  originY: number,
  _twist = 0,
): { items: ManifestItem[]; panX: number; panY: number } {
  const n = field.length
  const out: ManifestItem[] = new Array(cols * rows)
  if (n === 0) return { items: out, panX: 0, panY: 0 }

  const ox = Math.floor(originX)
  const oy = Math.floor(originY)
  const panX = originX - ox
  const panY = originY - oy
  const used = new Set<string>()

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let i = mod((ox + x) * 31 + (oy + y) * 47, n)
      let hops = 0
      while (used.has(field[i].id) && hops++ < n) i = (i + 1) % n
      used.add(field[i].id)
      out[y * cols + x] = field[i]
    }
  }

  return { items: out, panX, panY }
}

export function assignSpatial(
  sorted: ManifestItem[],
  cols: number,
  rows: number,
  serpentine = true,
): ManifestItem[] {
  const n = cols * rows
  const out: ManifestItem[] = new Array(n)
  if (sorted.length === 0) return out
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const col = serpentine && y % 2 === 1 ? cols - 1 - x : x
      const slot = y * cols + col
      out[slot] = sorted[mod(y * cols + x, sorted.length)]
    }
  }
  return out
}

function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1
  return Math.min(d, 1 - d)
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m
}

export function featureVector(f: CellFeatures): number[] {
  return [f.hue, f.luminance, f.saturation, f.edgeDensity, f.contrast]
}
