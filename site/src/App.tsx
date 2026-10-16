import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { loadManifest } from './data/manifest'
import type { Manifest, ManifestItem } from './data/types'
import { createPointerState, smoothPointer, updatePointerFromClient } from './interaction/pointer'
import {
  buildPaletteIndex,
  sampleInfiniteField,
  sampleWorldPalette,
  sortByFeature,
  sortByWeights,
  weightsFromPointer,
  type PaletteIndex,
} from './organization/assign'
import { GridEngine } from './render/GridEngine'
import { IdentityOverlay } from './ui/IdentityOverlay'
import './App.css'

type SortMode = 'weighted' | 'hue' | 'luminance' | 'edge'

/** Every new gesture (mouse starts moving again after settling) advances to the next mode. */
const SORT_CYCLE: SortMode[] = ['weighted', 'hue', 'luminance', 'edge']

/** Pointer counts as "travelling" while real movement happened within this many ms. */
const MOVING_MS = 110
/** The mouse must be still this long before the settle transition (fade + glide) begins. */
const SETTLE_MS = 400

const DISPLAY_NAME = 'Will Meier'
const LINKS = [
  { label: 'Email', href: 'mailto:willmeierart@gmail.com' },
  { label: 'GitHub', href: 'https://github.com/willmeierart' },
  { label: 'LinkedIn', href: 'https://linkedin.com/in/willmeierart' },
  { label: 'Soundcloud', href: 'https://soundcloud.com/aenemonae' },
  { label: 'Bandcamp', href: 'https://aenemonae.bandcamp.com' },
]

function gridForViewport(w: number, h: number): { cols: number; rows: number } {
  const target = 140
  const cols = Math.max(5, Math.ceil(w / target))
  const rows = Math.max(5, Math.ceil(h / target))
  return { cols, rows }
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<GridEngine | null>(null)
  const pointerRef = useRef(createPointerState())
  const itemsRef = useRef<ManifestItem[]>([])
  const fieldRef = useRef<ManifestItem[]>([])
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

  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const rebuildField = useEffectEvent(() => {
    const items = itemsRef.current
    if (items.length === 0) return
    const p = pointerRef.current
    const mode = sortModeRef.current
    if (mode === 'weighted') {
      fieldRef.current = sortByWeights(items, weightsFromPointer(p.sx, p.sy))
    } else if (mode === 'hue') {
      fieldRef.current = sortByFeature(items, 'hue')
    } else if (mode === 'luminance') {
      fieldRef.current = sortByFeature(items, 'luminance')
    } else {
      fieldRef.current = sortByFeature(items, 'edgeDensity')
    }
  })

  const syncWorld = useEffectEvent((force = false) => {
    const engine = engineRef.current
    const field = fieldRef.current
    if (!engine || field.length === 0) return
    const sortMode = sortModeRef.current

    const ox = Math.floor(worldRef.current.x)
    const oy = Math.floor(worldRef.current.y)
    // Palette phase = distance travelled, in quarter steps so each tick only turns
    // over a fraction of the cells (a rolling shuffle, not a reset).
    const phase = Math.floor((odometerRef.current / 3) * 4) / 4
    // Epoch: every ~1.5 cells of travel every cell's candidate pool is re-rolled, so
    // coming back to a spot after going away shows an image it has not shown before.
    const epoch = Math.floor(odometerRef.current / 1.5)
    const phaseKey = epoch * 1e6 + phase * 4
    const hadOrigin = Number.isFinite(lastCellOrigin.current.x)
    const cellMoved = ox !== lastCellOrigin.current.x || oy !== lastCellOrigin.current.y
    const phaseMoved = phaseKey !== lastPhase.current
    if (!force && !cellMoved && !phaseMoved && lastSig.current) return

    const pad = engine.pad
    const cols = engine.cols + pad * 2
    const rows = engine.rows + pad * 2
    const palette = paletteRef.current
    const items =
      sortMode === 'weighted' && palette
        ? sampleWorldPalette(itemsRef.current, palette, cols, rows, ox - pad, oy - pad, phase, 40, epoch)
        : sampleInfiniteField(field, cols, rows, ox - pad, oy - pad, 0).items
    const sig = `${sortMode}|` + items.map((a) => a.id).join(',')
    if (sig === lastSig.current) return
    lastSig.current = sig
    lastPhase.current = phaseKey
    lastCellOrigin.current = { x: ox, y: oy }
    engine.instantSwap = false
    engine.setAssignment(items, hadOrigin && (cellMoved || phaseMoved || force))
  })

  useEffect(() => {
    let cancelled = false
    loadManifest()
      .then((m) => {
        if (!cancelled) {
          setManifest(m)
          itemsRef.current = m.items
          paletteRef.current = buildPaletteIndex(m.items)
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !manifest) return

    const { cols, rows } = gridForViewport(window.innerWidth, window.innerHeight)
    const engine = new GridEngine({ canvas, cols, rows, cellPx: 256 })
    engine.reducedMotion = !!reducedMotion
    engine.atmosphereEnabled = true
    engineRef.current = engine
    rebuildField()
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
        lastSig.current = ''
        lastCellOrigin.current = { x: Number.NaN, y: Number.NaN }
        syncWorld(true)
      }
    }
    resize()
    engine.start()
    syncWorld(true)
    void engine.preload(fieldRef.current.slice(0, 80)).catch(() => {})

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

      if (!overlayOpen) {
        // Three states, decided by the real mouse events (not by the smoothed pointer,
        // which glides on after you stop):
        //   MOVING  – the world travels and picks new images, but nothing you can see
        //             changes: no fades, no sliding (the engine swaps only hidden cells).
        //             A new gesture first advances the sort mode.
        //   WAITING – the mouse stopped; hold everything for SETTLE_MS (no coasting).
        //   SETTLED – ONE slow eased transition: the visible set fades to the new one
        //             while the grid glides so the cell under the aperture is framed.
        const sinceMove = performance.now() - lastMoveAt.current
        const moving = sinceMove <= MOVING_MS
        const settled = sinceMove > SETTLE_MS

        if (moving) {
          if (!travelingRef.current) {
            // mouse moves again after having settled: cycle through the sort modes
            const i = SORT_CYCLE.indexOf(sortModeRef.current)
            sortModeRef.current = SORT_CYCLE[(i + 1) % SORT_CYCLE.length]
            rebuildField()
            lastSig.current = ''
            // forced sync = a normal queued assignment (hidden cells swap, nothing repaints at once)
            syncWorld(true)
          }
          travelingRef.current = true
          engine.interrupt()
          odometerRef.current += Math.hypot(dx * engine.cols, dy * engine.rows)
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
            syncWorld(true) // make sure the engine has the final set
            // frame the cell that sits under the aperture's final position
            const col = Math.min(engine.cols - 1, Math.max(0, Math.floor(p.x * engine.cols)))
            const row = Math.min(engine.rows - 1, Math.max(0, Math.floor(p.y * engine.rows)))
            engine.beginSettle((col + 0.5) / engine.cols - p.x, p.y - (row + 0.5) / engine.rows)
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
  }, [manifest, reducedMotion])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverlayOpen(false)
      if (e.key === 'Enter' && !overlayOpen) setOverlayOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlayOpen])

  return (
    <div className="app">
      <canvas
        ref={canvasRef}
        className="app__canvas"
        onClick={() => {
          if (!overlayOpen) setOverlayOpen(true)
        }}
      />

      {error && <div className="app__error">{error}</div>}
      {!manifest && !error && <div className="app__loading">Loading archive…</div>}

      <IdentityOverlay
        open={overlayOpen}
        onClose={() => setOverlayOpen(false)}
        name={DISPLAY_NAME}
        links={LINKS}
      />
    </div>
  )
}
