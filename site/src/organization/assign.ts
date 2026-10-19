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
 * `ideal` is what the full set wants in each cell; it is what gets downloaded.
 * `shown` is what can be painted now: the best candidate whose photo has arrived,
 * or the ideal (as its blurred preview) when none has.
 */
export type Pick = { ideal: ManifestItem[]; shown: ManifestItem[] }

/** True once an item's photo is here (by manifest index). */
export type Readiness = (index: number) => boolean

/** True when a picture's download failed, so a cell must take a different one. */
export type Missing = (index: number) => boolean

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
  ready?: Readiness,
  missing?: Missing,
): Pick {
  const n = items.length
  const cells = cols * rows
  const out: ManifestItem[] = new Array(cells)
  if (n === 0) return { ideal: out, shown: out }
  const pts = index.pts
  const ph = phase * 0.35
  const salt = epoch * 1013
  const kCount = Math.max(1, candidates)

  // Every cell offers its K nearest hashed pictures. Closest claims are
  // granted first, and a picture already used in this matrix is skipped,
  // so the view never shows the same image twice while the archive allows it.
  const pairN = cells * kCount
  const dist = new Float32Array(pairN)
  const cellOf = new Uint16Array(pairN)
  const itemOf = new Uint32Array(pairN)
  const order = new Uint32Array(pairN)
  let p = 0
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = y * cols + x
      const gx = Math.floor(originX) + x
      const gy = Math.floor(originY) + y
      const [tx, ty, tz] = paletteTarget(gx, gy, ph)
      for (let k = 0; k < kCount; k++) {
        const i = hash3(gx, gy, k + 1 + salt) % n
        const dx = pts[i * 3] - tx
        const dy = pts[i * 3 + 1] - ty
        const dz = pts[i * 3 + 2] - tz
        dist[p] = dx * dx + dy * dy + dz * dz
        cellOf[p] = cell
        itemOf[p] = i
        order[p] = p
        p++
      }
    }
  }
  order.sort((a, b) => dist[a] - dist[b] || cellOf[a] - cellOf[b] || itemOf[a] - itemOf[b])

  const cellTaken = new Uint8Array(cells)
  const usedIds = new Set<string>()
  let filled = 0
  for (let s = 0; s < pairN && filled < cells; s++) {
    const pi = order[s]
    const cell = cellOf[pi]
    if (cellTaken[cell]) continue
    const item = items[itemOf[pi]]
    if (!item || usedIds.has(item.id) || missing?.(item.index)) continue
    cellTaken[cell] = 1
    usedIds.add(item.id)
    out[cell] = item
    filled++
  }

  const nearestUnused = (cell: number, allowUsed: boolean): ManifestItem | undefined => {
    const x = cell % cols
    const y = (cell / cols) | 0
    const gx = Math.floor(originX) + x
    const gy = Math.floor(originY) + y
    const [tx, ty, tz] = paletteTarget(gx, gy, ph)
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < n; i++) {
      if (missing?.(i)) continue
      if (!allowUsed && usedIds.has(items[i].id)) continue
      const dx = pts[i * 3] - tx
      const dy = pts[i * 3 + 1] - ty
      const dz = pts[i * 3 + 2] - tz
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best >= 0 ? items[best] : undefined
  }

  if (filled < cells && usedIds.size < n) {
    for (let cell = 0; cell < cells && filled < cells; cell++) {
      if (cellTaken[cell]) continue
      const item = nearestUnused(cell, false)
      if (!item) break
      cellTaken[cell] = 1
      usedIds.add(item.id)
      out[cell] = item
      filled++
    }
  }
  // Fewer unique pictures than cells: only then may one repeat.
  for (let cell = 0; cell < cells; cell++) {
    if (cellTaken[cell]) continue
    const item = nearestUnused(cell, true)
    if (item) out[cell] = item
  }
  if (!ready) return { ideal: out, shown: out }

  // Same claims in the same order, restricted to pictures that have arrived.
  const shown: ManifestItem[] = new Array(cells)
  const shownTaken = new Uint8Array(cells)
  const shownUsed = new Uint8Array(n)
  let shownFilled = 0
  for (let s = 0; s < pairN && shownFilled < cells; s++) {
    const pi = order[s]
    const cell = cellOf[pi]
    if (shownTaken[cell]) continue
    const i = itemOf[pi]
    if (shownUsed[i] || !ready(i)) continue
    shownTaken[cell] = 1
    shownUsed[i] = 1
    shown[cell] = items[i]
    shownFilled++
  }
  // No candidate has arrived: the cell waits on its ideal, painted as a preview.
  // A picture that failed to download is skipped, so the cell waits on another one.
  const blocked = (i: number) => shownUsed[i] || !!missing?.(i)
  for (let cell = 0; cell < cells; cell++) {
    if (shownTaken[cell]) continue
    let pick: ManifestItem | undefined = out[cell]
    if (pick && blocked(pick.index)) {
      pick = undefined
      for (let k = 0; k < kCount; k++) {
        const i = itemOf[cell * kCount + k]
        if (!blocked(i)) {
          pick = items[i]
          break
        }
      }
    }
    if (!pick) {
      const x = cell % cols
      const y = (cell / cols) | 0
      const gx = Math.floor(originX) + x
      const gy = Math.floor(originY) + y
      const [tx, ty, tz] = paletteTarget(gx, gy, ph)
      let best = -1
      let bestD = Infinity
      for (let i = 0; i < n; i++) {
        if (blocked(i)) continue
        const dx = pts[i * 3] - tx
        const dy = pts[i * 3 + 1] - ty
        const dz = pts[i * 3 + 2] - tz
        const d = dx * dx + dy * dy + dz * dz
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best >= 0) pick = items[best]
    }
    pick ??= out[cell]
    if (!pick) continue
    shownUsed[pick.index] = 1
    shown[cell] = pick
  }
  return { ideal: out, shown }
}

/**
 * Unique viewport from a pre-sorted field (used by the sort modes). A cell whose
 * pick hasn't arrived shows the nearest arrived neighbour in the field instead,
 * which is close in that feature by construction.
 */
export function sampleInfiniteField(
  field: ManifestItem[],
  cols: number,
  rows: number,
  originX: number,
  originY: number,
  ready?: Readiness,
  missing?: Missing,
): Pick {
  const n = field.length
  const out: ManifestItem[] = new Array(cols * rows)
  if (n === 0) return { ideal: out, shown: out }

  const ox = Math.floor(originX)
  const oy = Math.floor(originY)
  const used = new Set<string>()
  const start = new Int32Array(cols * rows)

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let i = mod((ox + x) * 31 + (oy + y) * 47, n)
      let hops = 0
      while ((used.has(field[i].id) || !!missing?.(field[i].index)) && hops++ < n) i = (i + 1) % n
      used.add(field[i].id)
      out[y * cols + x] = field[i]
      start[y * cols + x] = i
    }
  }
  if (!ready) return { ideal: out, shown: out }

  const reach = Math.min(n, 32)
  const shown: ManifestItem[] = new Array(cols * rows)
  const shownUsed = new Set<string>()
  for (let cell = 0; cell < out.length; cell++) {
    let pick: ManifestItem | undefined
    for (let h = 0; h < reach && !pick; h++) {
      const it = field[(start[cell] + h) % n]
      if (!shownUsed.has(it.id) && ready(it.index)) pick = it
    }
    if (!pick) {
      const ideal = out[cell]
      if (ideal && !shownUsed.has(ideal.id) && !missing?.(ideal.index)) pick = ideal
    }
    if (!pick) {
      for (let h = 1; h < n && !pick; h++) {
        const it = field[(start[cell] + h) % n]
        if (!shownUsed.has(it.id) && !missing?.(it.index)) pick = it
      }
    }
    pick ??= out[cell]
    shownUsed.add(pick.id)
    shown[cell] = pick
  }
  return { ideal: out, shown }
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
