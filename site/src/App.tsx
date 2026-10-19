import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { ImageStore, slowConnection } from './data/imageStore'
import { loadManifest } from './data/manifest'
import type { Manifest, ManifestItem } from './data/types'
import { createPointerState, smoothPointer, updatePointerFromClient } from './interaction/pointer'
import {
  buildPaletteIndex,
  sampleInfiniteField,
  sampleWorldPalette,
  sortByFeature,
  type PaletteIndex,
  type Pick,
  type Readiness,
  type Missing,
} from './organization/assign'
import { GridEngine, MAX_PIXEL_RATIO } from './render/GridEngine'
import { IdentityOverlay, PageName } from './ui/IdentityOverlay'
import './App.css'

type SortMode = 'weighted' | 'hue' | 'luminance' | 'edge'

/** Every new gesture (mouse starts moving again after settling) advances to the next mode. */
const SORT_CYCLE: SortMode[] = ['weighted', 'hue', 'luminance', 'edge']

/** Pointer counts as "travelling" while real movement happened within this many ms. */
const MOVING_MS = 110
/** The mouse must be still this long before the settle transition (fade + glide) begins. */
const SETTLE_MS = 400
/** Re-pick what cells show at most this often while photos are arriving. */
const ARRIVAL_SYNC_MS = 120
/** How often the look-ahead prefetch is recomputed. */
const PREFETCH_MS = 200
/** On the white page, cells this close to the pointer (in cells) can be seen, so their ideal picks are fetched. */
const WHITE_REACH = 3
/** How often the fetch list is rebuilt from what the grid is waiting on. */
const DEMAND_MS = 200
/** Seconds of pointer travel the look-ahead predicts. */
const LOOKAHEAD_S = 0.3
/** The wake stays open behind the pointer about this long, so its cells are fetched too. */
const TRAIL_MS = 1500
/** Reach (in cells) around each point of the recent pointer path. */
const TRAIL_REACH = 1.5

const DISPLAY_NAME = 'Will Meier'

/** Tab title. The gap is non-breaking spaces so the browser keeps them when the loop wraps. */
const HEADLINE =
  "Hi my name is Will and I like to create fun interactive experiences like the one you're currently having :)"
const HEADLINE_LOOP = HEADLINE + '\u00A0'.repeat(48)
/** How often the tab title steps one character. A title can only move a whole character at a time. */
const HEADLINE_STEP_MS = 90
const LINKS = [
  { label: 'Email', href: 'mailto:willmeierart@gmail.com' },
  { label: 'GitHub', href: 'https://github.com/willmeierart' },
  { label: 'LinkedIn', href: 'https://linkedin.com/in/willmeierart' },
  { label: 'Soundcloud', href: 'https://soundcloud.com/aenemonae' },
  { label: 'Bandcamp', href: 'https://aenemonae.bandcamp.com' },
]

/** Preferred cell size in CSS px; smaller when needed so the short side still spans 5 cells. */
const CELL_TARGET = 140
const MIN_CELLS = 5

/**
 * Cells are always square. The screen spans a fractional number of them
 * (viewCols × viewRows); the atlas holds the whole cells that covers.
 */
function gridForViewport(
  w: number,
  h: number,
): { cols: number; rows: number; viewCols: number; viewRows: number } {
  const cell = Math.min(CELL_TARGET, Math.min(w, h) / MIN_CELLS)
  const viewCols = w / cell
  const viewRows = h / cell
  return {
    cols: Math.ceil(viewCols - 1e-6),
    rows: Math.ceil(viewRows - 1e-6),
    viewCols,
    viewRows,
  }
}

/**
 * Resolution cells are drawn and downloaded at, chosen once per visit. Sized from
 * the screen rather than the window, so narrowing a desktop window does not
 * leave it with soft pictures when it widens again. Slow connections get the
 * small set regardless.
 */
const CELL_PX = (() => {
  if (slowConnection()) return 128
  const short = Math.min(window.screen.width, window.screen.height)
  const css = Math.min(CELL_TARGET, short / MIN_CELLS)
  const device = css * Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
  return device <= 128 ? 128 : 256
})()

function nextMode(mode: SortMode): SortMode {
  return SORT_CYCLE[(SORT_CYCLE.indexOf(mode) + 1) % SORT_CYCLE.length]
}

/** Palette phase and re-roll epoch for a distance travelled (in cells). */
function travelClock(odometer: number): { phase: number; epoch: number } {
  // Phase in quarter steps so each tick only turns over a fraction of the cells
  // (a rolling shuffle, not a reset). Every ~1.5 cells of travel every cell's
  // candidate pool is re-rolled, so coming back to a spot shows something new.
  return { phase: Math.floor((odometer / 3) * 4) / 4, epoch: Math.floor(odometer / 1.5) }
}

/**
 * Atlas cells in fetch order. Cells within `reach` of the pointer cell, nearest
 * first; with no reach, every on-screen cell by distance, then the hidden border.
 */
function cellsByDistance(
  cols: number,
  rows: number,
  pad: number,
  pcx: number,
  pcy: number,
  reach: number | null,
): number[] {
  const scored: { i: number; d: number }[] = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const d = Math.hypot(x + 0.5 - pcx, y + 0.5 - pcy)
      if (reach !== null && d > reach) continue
      const border = x < pad || y < pad || x >= cols - pad || y >= rows - pad
      scored.push({ i: y * cols + x, d: border ? d + 1e4 : d })
    }
  }
  scored.sort((a, b) => a.d - b.d)
  return scored.map((s) => s.i)
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<GridEngine | null>(null)
  const pointerRef = useRef(createPointerState())
  const itemsRef = useRef<ManifestItem[]>([])
  /** The set pre-sorted for each field mode; static, so sorted once. */
  const fieldsRef = useRef<Record<Exclude<SortMode, 'weighted'>, ManifestItem[]> | null>(null)
  const storeRef = useRef<ImageStore | null>(null)
  const arrivalsRef = useRef(false)
  const lastArrivalSync = useRef(0)
  const lastPrefetch = useRef(0)
  const lastDemand = useRef(0)
  /** The latest pick, so the fetch list can be rebuilt between syncs. */
  const pickRef = useRef<Pick | null>(null)
  /** Recent pointer positions in atlas cells, oldest first. */
  const trailRef = useRef<{ cx: number; cy: number; t: number }[]>([])
  const worldRef = useRef({ x: 0, y: 0 })
  const velWorldRef = useRef({ x: 0, y: 0 })
  const prevPointerRef = useRef({ x: 0.5, y: 0.5 })
  const pointerVelRef = useRef({ x: 0, y: 0 })
  const lastCellOrigin = useRef({ x: Number.NaN, y: Number.NaN })
  const lastSig = useRef('')
  const travelingRef = useRef(false)
  const paletteRef = useRef<PaletteIndex | null>(null)
  /** Cells of pointer path travelled; drives palette phase so going back never returns the same images. */
  const odometerRef = useRef(0)
  const lastPhase = useRef(-1)
  /** Time of the last real (≥1.5px) pointer movement. */
  const lastMoveAt = useRef(0)
  const lastRawPx = useRef({ x: -1e6, y: -1e6 })
  const sortModeRef = useRef<SortMode>('weighted')

  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const overlayOpenRef = useRef(false)
  overlayOpenRef.current = overlayOpen
  const apertureRef = useRef({
    x: window.innerWidth * 0.5,
    y: window.innerHeight * 0.5,
    r: 0,
    cx: window.innerWidth * 0.5,
    cy: window.innerHeight * 0.5,
  })
  const namePlateRef = useRef<HTMLCanvasElement | null>(null)

  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  /** Pick the whole atlas (view plus hidden border) for a mode at a world origin. */
  const pickView = (
    engine: GridEngine,
    mode: SortMode,
    ox: number,
    oy: number,
    odometer: number,
    ready?: Readiness,
    missing?: Missing,
  ): Pick | null => {
    const items = itemsRef.current
    const fields = fieldsRef.current
    if (items.length === 0 || !fields) return null
    const pad = engine.pad
    const cols = engine.cols + pad * 2
    const rows = engine.rows + pad * 2
    const { phase, epoch } = travelClock(odometer)
    const palette = paletteRef.current
    if (mode === 'weighted' && palette) {
      return sampleWorldPalette(items, palette, cols, rows, ox - pad, oy - pad, phase, 40, epoch, ready, missing)
    }
    return sampleInfiniteField(fields[mode === 'weighted' ? 'hue' : mode], cols, rows, ox - pad, oy - pad, ready, missing)
  }

  /** Ideal picture ids for the given cells, in that order. */
  const idsFor = (pick: Pick, cells: number[]): string[] => {
    const out: string[] = []
    for (const i of cells) {
      const it = pick.ideal[i]
      if (it) out.push(it.id)
    }
    return out
  }

  /** Atlas coordinates (in cells) of the pointer, optionally projected ahead. */
  const pointerCell = (engine: GridEngine, ahead = 0) => {
    const p = pointerRef.current
    const v = pointerVelRef.current
    // pointerVel is a per-frame sum with decay 0.8, about 5 frames of travel.
    const k = (ahead * 60) / 5
    const x = Math.min(1, Math.max(0, p.sx + v.x * k))
    const y = Math.min(1, Math.max(0, p.sy + v.y * k))
    return engine.screenToCell(x, y)
  }

  /** Cells that can be seen right now: around the pointer on the white page, everything on the black one. */
  const visibleOrder = (engine: GridEngine, ahead = 0): number[] => {
    const { cx, cy } = pointerCell(engine, ahead)
    const cols = engine.cols + engine.pad * 2
    const rows = engine.rows + engine.pad * 2
    return cellsByDistance(cols, rows, engine.pad, cx, cy, overlayOpenRef.current ? null : WHITE_REACH)
  }

  /**
   * Rebuild what is fetched first. Every cell still showing a preview (or nothing)
   * keeps its photo in the list until it lands, on both pages and while moving,
   * so re-rolls never strand a blurred cell. Cells that can be seen also fetch
   * their ideal pick: the whole grid on the black page; on the white page, the
   * cells around the pointer and along the recent wake.
   */
  const refreshDemand = useEffectEvent(() => {
    const engine = engineRef.current
    const store = storeRef.current
    if (!engine || !store) return
    const pad = engine.pad
    const cols = engine.cols + pad * 2
    const rows = engine.rows + pad * 2
    const { cx, cy } = pointerCell(engine)
    const now = performance.now()
    const trail = trailRef.current.filter((pt) => now - pt.t <= TRAIL_MS)
    trailRef.current = trail
    const open = overlayOpenRef.current
    const seen = (i: number) => {
      if (open) return true
      const x = (i % cols) + 0.5
      const y = Math.floor(i / cols) + 0.5
      if (Math.hypot(x - cx, y - cy) <= WHITE_REACH) return true
      return trail.some((pt) => Math.hypot(x - pt.cx, y - pt.cy) <= TRAIL_REACH)
    }
    const pick = pickRef.current
    const ids: string[] = []
    for (const i of cellsByDistance(cols, rows, pad, cx, cy, null)) {
      const waiting = engine.waitingOn(i)
      if (waiting) ids.push(waiting.id)
      if (!pick || !seen(i)) continue
      const ideal = pick.ideal[i]
      if (ideal) ids.push(ideal.id)
      const shown = pick.shown[i]
      if (shown && shown !== ideal && !store.ready[shown.index]) ids.push(shown.id)
    }
    store.demand(0, ids)
  })

  const syncWorld = useEffectEvent((force = false) => {
    const engine = engineRef.current
    if (!engine) return
    const sortMode = sortModeRef.current
    const store = storeRef.current

    const ox = Math.floor(worldRef.current.x)
    const oy = Math.floor(worldRef.current.y)
    const { phase, epoch } = travelClock(odometerRef.current)
    const phaseKey = epoch * 1e6 + phase * 4
    const hadOrigin = Number.isFinite(lastCellOrigin.current.x)
    const cellMoved = ox !== lastCellOrigin.current.x || oy !== lastCellOrigin.current.y
    const phaseMoved = phaseKey !== lastPhase.current
    if (!force && !cellMoved && !phaseMoved && lastSig.current) return

    const ready: Readiness | undefined = store ? (i) => store.ready[i] === 1 : undefined
    const missing: Missing | undefined = store ? (i) => store.isFailedIndex(i) : undefined
    const pick = pickView(engine, sortMode, ox, oy, odometerRef.current, ready, missing)
    if (!pick) return
    pickRef.current = pick

    const sig = `${sortMode}|` + pick.shown.map((a) => a?.id).join(',')
    if (sig !== lastSig.current) {
      lastSig.current = sig
      lastPhase.current = phaseKey
      lastCellOrigin.current = { x: ox, y: oy }
      engine.instantSwap = false
      engine.setAssignment(pick.shown, hadOrigin && (cellMoved || phaseMoved || force))
    }
    // After setAssignment, so blank cells already wait on their new targets.
    refreshDemand()
  })

  /**
   * Fetch what the next moment will want. Moving: the view where the pointer and
   * world will be shortly, at the travel clock they will have reached. Still: the
   * next gesture switches sort mode, so that mode's cells here.
   */
  const prefetchAhead = useEffectEvent((moving: boolean) => {
    const engine = engineRef.current
    const store = storeRef.current
    if (!engine || !store) return
    let pick: Pick | null
    let order: number[]
    if (moving) {
      const v = pointerVelRef.current
      const k = (LOOKAHEAD_S * 60) / 5
      const travel = Math.hypot(v.x * k * engine.viewCols, v.y * k * engine.viewRows)
      const wv = velWorldRef.current
      const frames = LOOKAHEAD_S * 60
      const ox = Math.floor(worldRef.current.x + wv.x * 0.08 * frames)
      const oy = Math.floor(worldRef.current.y + wv.y * 0.08 * frames)
      pick = pickView(
        engine,
        sortModeRef.current,
        ox,
        oy,
        odometerRef.current + travel,
        undefined,
        (i) => store.isFailedIndex(i),
      )
      order = visibleOrder(engine, LOOKAHEAD_S)
    } else {
      const ox = Math.floor(worldRef.current.x)
      const oy = Math.floor(worldRef.current.y)
      pick = pickView(engine, nextMode(sortModeRef.current), ox, oy, odometerRef.current, undefined, (i) =>
        store.isFailedIndex(i),
      )
      order = visibleOrder(engine).filter((i) => {
        const cols = engine.cols + engine.pad * 2
        const x = i % cols
        const y = Math.floor(i / cols)
        return x >= engine.pad && y >= engine.pad && x < cols - engine.pad && y < engine.rows + engine.pad
      })
    }
    if (pick) store.demand(1, idsFor(pick, order))
  })

  useEffect(() => {
    let cancelled = false
    loadManifest()
      .then((m) => {
        if (!cancelled) setManifest(m)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!manifest) return
    itemsRef.current = manifest.items
    paletteRef.current = buildPaletteIndex(manifest.items)
    fieldsRef.current = {
      hue: sortByFeature(manifest.items, 'hue'),
      luminance: sortByFeature(manifest.items, 'luminance'),
      edge: sortByFeature(manifest.items, 'edgeDensity'),
    }
    const engine = engineRef.current
    const viewCells = engine ? (engine.cols + engine.pad * 2) * (engine.rows + engine.pad * 2) : 300
    const store = new ImageStore(manifest, viewCells, CELL_PX)
    store.onArrive = () => {
      arrivalsRef.current = true
    }
    storeRef.current = store
    if (engine) engine.source = store
    lastSig.current = ''
    lastCellOrigin.current = { x: Number.NaN, y: Number.NaN }
    syncWorld(true)
    // After the first view is queued, so the previews only take bandwidth the photos leave.
    store.loadThumbs()
    return () => {
      if (engineRef.current?.source === store) engineRef.current.source = null
      store.dispose()
      storeRef.current = null
    }
  }, [manifest])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const grid = gridForViewport(window.innerWidth, window.innerHeight)
    const engine = new GridEngine({ canvas, ...grid, cellPx: CELL_PX })
    engine.reducedMotion = !!reducedMotion
    engine.atmosphereEnabled = true
    engine.source = storeRef.current
    engineRef.current = engine
    if (overlayOpen) {
      engine.stage = 'grid'
      engine.blend = GridEngine.BLENDS.indexOf('exclusion')
      engine.liveShuffle = true
    }
    lastCellOrigin.current = { x: Number.NaN, y: Number.NaN }
    lastSig.current = ''

    const resize = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      engine.resize(w, h)
      const g = gridForViewport(w, h)
      if (g.cols !== engine.cols || g.rows !== engine.rows) {
        engine.setGrid(g.cols, g.rows)
        engine.setView(g.viewCols, g.viewRows)
        lastSig.current = ''
        lastCellOrigin.current = { x: Number.NaN, y: Number.NaN }
        syncWorld(true)
      } else {
        engine.setView(g.viewCols, g.viewRows)
      }
    }
    resize()
    engine.start()
    if (namePlateRef.current) engine.setNamePlate(namePlateRef.current)
    engine.showNamePlate = !overlayOpen
    engine.customBlend = !overlayOpen
    syncWorld(true)

    const onMove = (e: PointerEvent) => {
      // ignore sub-pixel jitter: only real movement counts as "moving"
      if (Math.hypot(e.clientX - lastRawPx.current.x, e.clientY - lastRawPx.current.y) >= 1.5) {
        lastRawPx.current = { x: e.clientX, y: e.clientY }
        lastMoveAt.current = performance.now()
      }
      updatePointerFromClient(
        pointerRef.current,
        e.clientX,
        e.clientY,
        window.innerWidth,
        window.innerHeight,
      )
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('resize', resize)

    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const p = pointerRef.current
      smoothPointer(p, 0.2)

      const dx = p.sx - prevPointerRef.current.x
      const dy = p.sy - prevPointerRef.current.y
      prevPointerRef.current = { x: p.sx, y: p.sy }

      pointerVelRef.current.x = pointerVelRef.current.x * 0.8 + dx
      pointerVelRef.current.y = pointerVelRef.current.y * 0.8 + dy
      engine.pointer.x = p.sx
      engine.pointer.y = p.sy
      engine.velocity.x = pointerVelRef.current.x
      engine.velocity.y = pointerVelRef.current.y
      apertureRef.current.x = p.sx * window.innerWidth
      apertureRef.current.y = p.sy * window.innerHeight
      apertureRef.current.r = engine.lensRadius * window.innerHeight
      apertureRef.current.cx = p.x * window.innerWidth
      apertureRef.current.cy = p.y * window.innerHeight

      const sinceMove = performance.now() - lastMoveAt.current
      engine.pointerIdle = sinceMove > SETTLE_MS

      // White page: visible cells wait until you stop, then fade once.
      // Black page: liveShuffle paints new pictures into the grid while you move.
      // The cell under the pointer stays put. The grid does not glide.
      const open = overlayOpenRef.current
      const moving = sinceMove <= MOVING_MS
      const settled = sinceMove > SETTLE_MS

      const now = performance.now()
      if (arrivalsRef.current && now - lastArrivalSync.current > ARRIVAL_SYNC_MS) {
        arrivalsRef.current = false
        lastArrivalSync.current = now
        syncWorld(true)
      }
      if (moving) {
        const pc = pointerCell(engine)
        const last = trailRef.current[trailRef.current.length - 1]
        if (!last || Math.hypot(pc.cx - last.cx, pc.cy - last.cy) > 0.25) trailRef.current.push({ ...pc, t: now })
      }
      if (now - lastDemand.current > DEMAND_MS) {
        lastDemand.current = now
        refreshDemand()
      }
      if (now - lastPrefetch.current > PREFETCH_MS) {
        lastPrefetch.current = now
        prefetchAhead(moving)
      }

      if (moving) {
        if (!travelingRef.current) {
          sortModeRef.current = nextMode(sortModeRef.current)
          lastSig.current = ''
          syncWorld(true)
        }
        travelingRef.current = true
        if (!open) engine.interrupt()
        odometerRef.current += Math.hypot(dx * engine.viewCols, dy * engine.viewRows)
        const impulse = 36
        velWorldRef.current.x += -dx * impulse
        velWorldRef.current.y += -dy * impulse
        velWorldRef.current.x *= 0.92
        velWorldRef.current.y *= 0.92
        const maxV = 4.0
        velWorldRef.current.x = Math.max(-maxV, Math.min(maxV, velWorldRef.current.x))
        velWorldRef.current.y = Math.max(-maxV, Math.min(maxV, velWorldRef.current.y))
        worldRef.current.x += velWorldRef.current.x * 0.08
        worldRef.current.y += velWorldRef.current.y * 0.08
        syncWorld(false)
      } else {
        velWorldRef.current.x = 0
        velWorldRef.current.y = 0
        if (settled && travelingRef.current) {
          travelingRef.current = false
          syncWorld(true)
          if (!open) {
            engine.beginSettle(0, 0)
          }
        }
      }
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('resize', resize)
      engine.dispose()
      engineRef.current = null
    }
  }, [reducedMotion])

  useEffect(() => {
    let i = 0
    const paint = () => {
      document.title = HEADLINE_LOOP.slice(i) + HEADLINE_LOOP.slice(0, i)
      i = (i + 1) % HEADLINE_LOOP.length
    }
    paint()
    const timer = window.setInterval(paint, HEADLINE_STEP_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverlayOpen(false)
      if (e.key === 'Enter' && !overlayOpen) setOverlayOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlayOpen])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    if (overlayOpen) {
      engine.stage = 'grid'
      engine.blend = GridEngine.BLENDS.indexOf('exclusion')
      engine.showNamePlate = false
      engine.customBlend = false
      engine.liveShuffle = true
    } else {
      engine.stage = 'cursor'
      engine.blend = GridEngine.BLENDS.indexOf('screen')
      engine.showNamePlate = true
      engine.customBlend = true
      engine.liveShuffle = false
    }
    // What can be seen just changed, so what is fetched first changes with it.
    syncWorld(true)
  }, [overlayOpen])

  return (
    <div className="app">
      <PageName
        name={DISPLAY_NAME}
        onPlate={(plate) => {
          namePlateRef.current = plate
          engineRef.current?.setNamePlate(plate)
        }}
      />
      <canvas
        ref={canvasRef}
        className="app__canvas"
        onClick={() => {
          if (!overlayOpen) setOverlayOpen(true)
        }}
      />

      {error && <div className="app__error">{error}</div>}

      <IdentityOverlay
        open={overlayOpen}
        onClose={() => setOverlayOpen(false)}
        name={DISPLAY_NAME}
        links={LINKS}
        apertureRef={apertureRef}
      />
    </div>
  )
}
