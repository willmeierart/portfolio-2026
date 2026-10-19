import { thumbHashToRGBA } from 'thumbhash'
import { cellUrl, sizeFor } from './manifest'
import type { Manifest } from './types'

/** What the renderer needs to paint a cell. */
export interface PictureSource {
  /** The decoded photo, if it is in memory. Asking for a downloaded one starts its decode. */
  bitmap(id: string): ImageBitmap | undefined
  isDecoded(id: string): boolean
  /** Paint the blurred preview into a cell. False until the preview file has arrived. */
  drawPlaceholder(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, size: number): boolean
  /** The download failed. The cell should show a different picture. */
  isFailed(id: string): boolean
}

/**
 * 0: cells in the current view, nearest the pointer first.
 * 1: cells the next moment is likely to want (direction of travel, next sort mode).
 * 2: background growth of the pool the sorter can pick ready pictures from.
 */
export type Tier = 0 | 1 | 2

type NetInfo = { saveData?: boolean; effectiveType?: string }

/** Requests in flight before each tier may start another. Lower tiers leave room for the view. */
const TIER_INFLIGHT = [12, 6, 3] as const
const MAX_BLOBS = 3000
const MAX_PREVIEWS = 1500

function connection(): NetInfo | undefined {
  return (navigator as Navigator & { connection?: NetInfo }).connection
}

/** Data saver on, or 3G or slower. False where the browser doesn't say (Safari, Firefox). */
export function slowConnection(): boolean {
  const c = connection()
  if (!c) return false
  return !!c.saveData || (c.effectiveType !== undefined && c.effectiveType !== '4g')
}

/** Pictures fetched in the background per visit, on top of what the view asks for. */
function idleBudget(): number {
  const c = connection()
  if (!c) return 400
  if (c.saveData) return 0
  if (c.effectiveType === '4g') return 400
  if (c.effectiveType === '3g') return 60
  return 0
}

/** Decoded pictures kept in memory (256 KB each at 256px, 64 KB at 128px). */
function bitmapBudget(minimum: number): number {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const base = mem === undefined ? 400 : mem <= 4 ? 260 : 520
  return Math.max(base, Math.ceil(minimum))
}

/** Seeded shuffle, so background growth covers the set evenly instead of in manifest order. */
function shuffledIds(ids: string[]): string[] {
  const out = ids.slice()
  let s = 0x9e3779b9
  for (let i = out.length - 1; i > 0; i--) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const j = (s >>> 0) % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export class ImageStore implements PictureSource {
  /** Fires (at most once per task) when a photo is decoded or the previews arrive. */
  onArrive?: () => void
  /** By manifest index: 1 once the photo's bytes are here, so it can be shown without a network wait. */
  readonly ready: Uint8Array

  private readonly index = new Map<string, number>()
  private readonly blobs = new Map<string, Blob>()
  /** Insertion order is recency: touched entries move to the end, eviction takes the front. */
  private readonly bitmaps = new Map<string, ImageBitmap>()
  private readonly decoding = new Set<string>()
  private readonly inflight = new Set<string>()
  private readonly failed = new Set<string>()
  private readonly lists: string[][] = [[], [], []]
  private readonly cursors = [0, 0, 0]
  private readonly maxBitmaps: number
  private idleLeft: number

  private thumbs: Uint8Array | null = null
  private thumbsSettled = false
  private readonly previews = new Map<string, ImageData>()
  private readonly previewCanvas = document.createElement('canvas')
  private arriveQueued = false
  private disposed = false
  private readonly manifest: Manifest
  /** Which published size this visit downloads. */
  readonly size: number

  /** `cellPx` is the resolution the renderer draws cells at. */
  constructor(manifest: Manifest, viewCells: number, cellPx: number) {
    this.manifest = manifest
    this.size = sizeFor(manifest, cellPx)
    manifest.items.forEach((it, i) => this.index.set(it.id, i))
    this.ready = new Uint8Array(manifest.items.length)
    this.maxBitmaps = bitmapBudget(viewCells * 1.6)
    this.idleLeft = idleBudget()
    this.lists[2] = shuffledIds(manifest.items.map((it) => it.id))
  }

  isFailed(id: string): boolean {
    return this.failed.has(id)
  }

  /** By manifest index. The sorter uses this to pick a different picture. */
  isFailedIndex(index: number): boolean {
    const id = this.manifest.items[index]?.id
    return !!id && this.failed.has(id)
  }

  /** Replace what a tier wants, most important first. Queued requests that fell out are dropped. */
  demand(tier: Tier, ids: string[]): void {
    if (tier === 2) return
    this.lists[tier] = ids
    this.cursors[tier] = 0
    for (const id of ids) {
      if (tier === 0 && this.bitmaps.has(id)) this.touch(id)
    }
    this.pump()
  }

  /**
   * Start the preview file. Call it after the first view has been demanded: it goes
   * out at low priority on the same connection, so it only takes bandwidth the
   * photos leave over.
   */
  loadThumbs(): void {
    const t = this.manifest.thumbs
    if (!t) {
      this.thumbsSettled = true
      this.pump()
      return
    }
    fetch(t.url, { priority: 'low' })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.arrayBuffer()
      })
      .then((buf) => {
        this.thumbs = new Uint8Array(buf)
        this.arrived()
      })
      .catch(() => {})
      .finally(() => {
        this.thumbsSettled = true
        this.pump()
      })
  }

  bitmap(id: string): ImageBitmap | undefined {
    const b = this.bitmaps.get(id)
    if (b) {
      this.touch(id)
      return b
    }
    const blob = this.blobs.get(id)
    if (blob) void this.decode(id, blob, true)
    return undefined
  }

  isDecoded(id: string): boolean {
    return this.bitmaps.has(id)
  }

  drawPlaceholder(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, size: number): boolean {
    const img = this.preview(id)
    if (!img) return false
    const c = this.previewCanvas
    if (c.width !== img.width || c.height !== img.height) {
      c.width = img.width
      c.height = img.height
    }
    c.getContext('2d')?.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(c, x, y, size, size)
    return true
  }

  dispose(): void {
    this.disposed = true
    for (const b of this.bitmaps.values()) b.close()
    this.bitmaps.clear()
    this.blobs.clear()
  }

  private preview(id: string): ImageData | undefined {
    const hit = this.previews.get(id)
    if (hit) return hit
    const t = this.manifest.thumbs
    const i = this.index.get(id)
    if (!this.thumbs || !t || i === undefined) return undefined
    const start = i * t.stride
    if (start + t.stride > this.thumbs.length) return undefined
    const { w, h, rgba } = thumbHashToRGBA(this.thumbs.subarray(start, start + t.stride))
    const img = new ImageData(new Uint8ClampedArray(rgba), w, h)
    if (this.previews.size >= MAX_PREVIEWS) {
      const oldest = this.previews.keys().next().value
      if (oldest !== undefined) this.previews.delete(oldest)
    }
    this.previews.set(id, img)
    return img
  }

  private touch(id: string): void {
    const b = this.bitmaps.get(id)
    if (!b) return
    this.bitmaps.delete(id)
    this.bitmaps.set(id, b)
  }

  private wanted(id: string): boolean {
    return !this.blobs.has(id) && !this.inflight.has(id) && !this.failed.has(id)
  }

  private next(): { id: string; tier: Tier } | null {
    for (const tier of [0, 1, 2] as Tier[]) {
      if (this.inflight.size >= TIER_INFLIGHT[tier]) return null
      if (tier === 2 && (!this.thumbsSettled || this.idleLeft <= 0)) return null
      const list = this.lists[tier]
      while (this.cursors[tier] < list.length) {
        const id = list[this.cursors[tier]++]
        if (this.wanted(id)) return { id, tier }
      }
    }
    return null
  }

  private pump(): void {
    if (this.disposed) return
    for (let job = this.next(); job; job = this.next()) this.fetchOne(job.id, job.tier)
  }

  private fetchOne(id: string, tier: Tier): void {
    this.inflight.add(id)
    if (tier === 2) this.idleLeft--
    fetch(cellUrl(this.manifest, id, this.size), { priority: tier === 0 ? 'high' : 'low' })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.blob()
      })
      .then((blob) => {
        if (this.disposed) return
        this.storeBlob(id, blob)
        // Background pictures only take free decode slots; they never push out ones in use.
        if (tier < 2 || this.bitmaps.size < this.maxBitmaps) return this.decode(id, blob, tier < 2)
      })
      .catch(() => {
        this.failed.add(id)
        // The cell showing this picture needs a replacement, same path as an arrival.
        this.arrived()
      })
      .finally(() => {
        this.inflight.delete(id)
        this.pump()
      })
  }

  private storeBlob(id: string, blob: Blob): void {
    this.blobs.set(id, blob)
    const i = this.index.get(id)
    if (i !== undefined) this.ready[i] = 1
    while (this.blobs.size > MAX_BLOBS) {
      const oldest = this.blobs.keys().next().value
      if (oldest === undefined || this.bitmaps.has(oldest)) break
      this.blobs.delete(oldest)
      const j = this.index.get(oldest)
      if (j !== undefined) this.ready[j] = 0
    }
  }

  private async decode(id: string, blob: Blob, evict: boolean): Promise<void> {
    if (this.bitmaps.has(id) || this.decoding.has(id)) return
    this.decoding.add(id)
    try {
      const bmp = await createImageBitmap(blob)
      if (this.disposed) {
        bmp.close()
        return
      }
      if (!evict && this.bitmaps.size >= this.maxBitmaps) {
        bmp.close()
        return
      }
      this.bitmaps.set(id, bmp)
      while (this.bitmaps.size > this.maxBitmaps) {
        const oldest = this.bitmaps.keys().next().value
        if (oldest === undefined) break
        this.bitmaps.get(oldest)?.close()
        this.bitmaps.delete(oldest)
      }
      this.arrived()
    } catch {
      this.failed.add(id)
      this.blobs.delete(id)
      const i = this.index.get(id)
      if (i !== undefined) this.ready[i] = 0
      this.arrived()
    } finally {
      this.decoding.delete(id)
    }
  }

  private arrived(): void {
    if (this.arriveQueued) return
    this.arriveQueued = true
    queueMicrotask(() => {
      this.arriveQueued = false
      this.onArrive?.()
    })
  }
}
