import * as THREE from 'three'
import { attachPointerSplats, FluidSimulation } from 'three-fluid-fx'
import { assetUrl } from '../data/manifest'
import type { ManifestItem } from '../data/types'
import { displayFrag, displayVert, visibilityFrag } from './shaders'

export type TransitionMode = 'crossfade' | 'blockwise'

export type EngineOptions = {
  canvas: HTMLCanvasElement
  cols: number
  rows: number
  cellPx?: number
}

export type EngineDebug = {
  fps: number
  transitioning: boolean
  progress: number
}

const WHITE = 0xffffff
const PAD = 2

function makeAtlas(w: number, h: number): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = true
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  return { canvas, texture }
}

export class GridEngine {
  readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.OrthographicCamera
  private readonly material: THREE.ShaderMaterial
  private readonly fluid: FluidSimulation
  private readonly detachPointer: () => void

  private atlasCanvas: HTMLCanvasElement
  private atlasTex: THREE.CanvasTexture
  /** Incoming pictures for the post-settle fade (only the faded cells are painted). */
  private blendCanvas: HTMLCanvasElement
  private blendTex: THREE.CanvasTexture
  private fadeFlagTex: THREE.DataTexture
  private fading: { cells: number[]; items: ManifestItem[]; set: Set<number>; t: number } | null = null
  private fadeSpeed = 1
  /** Seconds the settle fade (and the glide that frames the cell) takes. */
  settleDuration = 1.0
  private panAnim: { fx: number; fy: number; tx: number; ty: number; t: number } | null = null
  /** Rim stir at rest. 0 = perfectly calm aperture; kept tiny so the edge isn't dead. */
  /** Idle rim swirl. 0 = aperture is still when the mouse is still (any value > 0 slowly accumulates ink). */
  rimStir = 0
  private readonly imageCache = new Map<string, HTMLImageElement>()

  // ---- hidden-cell swapping -------------------------------------------
  // The atlas only changes where the white covers it. `target` is what the world
  // wants each atlas cell to show; `shown` is what the cell shows right now. A
  // cell takes its target only while it is NOT visible through the halo or tail
  // (nor next to something that is), so no swap or fade is ever seen.
  private target: ManifestItem[] = []
  private shown: (ManifestItem | undefined)[] = []
  private frozen = new Uint8Array(0)
  private visRT: THREE.WebGLRenderTarget
  private visScene: THREE.Scene
  private visMaterial: THREE.ShaderMaterial
  private visBuf = new Uint8Array(0)
  private frameNo = 0
  private atlasDirty = false
  private lastUpload = 0
  /** Samples per atlas cell edge in the visibility pass. */
  private static readonly VIS_S = 3

  cols: number
  rows: number
  cellPx: number
  readonly pad = PAD

  /** Kept for the debug panel; swaps are no longer cross-faded, they happen under the white. */
  transitionMode: TransitionMode = 'crossfade'
  instantSwap = false

  lensRadius = 0.00035
  atmosphereEnabled = true
  reducedMotion = false
  distort = 1.2
  /** How readily wake density turns into revealed picture. */
  ink = 3.0
  /** Softness of the wake's evaporating edge. 0 = the old hard threshold, 1 = full feathered skirt. */
  edgeSoft = 1
  /**
   * Wake density below this is treated as already gone, so thin wisps bleed away sooner
   * while dense parts of the tail keep their full lifetime. 0 = wisps linger the longest.
   */
  wispFloor = 0.02
  /**
   * The picture under the aperture when you settle, mapped inside the sphere.
   * The rest of the set can change; this cell is not part of that fade.
   */
  private tileOn = false
  private tileMix = 0
  /** Inside-sphere orientation (radians) and the spin left after the pointer stops. */
  private sphereAng = { x: 0, y: 0 }
  private sphereVel = { x: 0, y: 0 }
  private spherePrev: { x: number; y: number } | null = null
  /** 0..1 while a background cross-fade is running; null once it has arrived. */
  private tileFade: number | null = null
  private readonly tileFromCanvas: HTMLCanvasElement
  private readonly tileFromTex: THREE.CanvasTexture
  private readonly tileToCanvas: HTMLCanvasElement
  private readonly tileToTex: THREE.CanvasTexture
  private readonly tileScratch: HTMLCanvasElement
  /** Ink deposited per pointer event (core thickness of the tail). */
  trailDensity = 0.5

  pointer = { x: 0.5, y: 0.5 }
  velocity = { x: 0, y: 0 }
  focusPan = { x: 0, y: 0 }
  private stampPrev: { x: number; y: number } | null = null

  private lastAssign: ManifestItem[] = []
  private raf = 0
  private lastTs = 0
  private fps = 0
  private running = false
  private assignGen = 0
  private cssW = 1
  private cssH = 1
  onDebug?: (d: EngineDebug) => void

  constructor(opts: EngineOptions) {
    this.cols = opts.cols
    this.rows = opts.rows
    this.cellPx = opts.cellPx ?? 256

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
      premultipliedAlpha: false,
    })
    this.renderer.setClearColor(WHITE, 1)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.autoClear = true

    this.cssW = Math.max(1, opts.canvas.clientWidth || window.innerWidth)
    this.cssH = Math.max(1, opts.canvas.clientHeight || window.innerHeight)
    this.renderer.setSize(this.cssW, this.cssH, false)

    this.fluid = new FluidSimulation(this.renderer as never, {
      profile: 'balanced',
      splatRadius: 0.00042,
      splatForce: 12,
      densityDissipation: 0.993,
      velocityDissipation: 0.9945,
      curlStrength: 14,
      enableVorticity: true,
      reflectWalls: false,
      bfecc: true,
    })
    this.fluid.resize(this.cssW, this.cssH)
    // Pointer splats go through a wrapper so the ink deposited per event is ours to set
    // (the library default of 1.0 floods the page once the tail is long-lived).
    const fluid = this.fluid
    const self = this
    const pointerTarget = {
      get splatForce() {
        return fluid.splatForce
      },
      set splatForce(v: number) {
        fluid.splatForce = v
      },
      addSplat(x: number, y: number, dx: number, dy: number, o?: object) {
        ;(fluid as unknown as { addSplat: (...a: unknown[]) => void }).addSplat(x, y, dx, dy, {
          ...(o ?? {}),
          color: [dx, dy, self.trailDensity],
        })
      },
    }
    this.detachPointer = attachPointerSplats(opts.canvas, pointerTarget as never)

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.scene = new THREE.Scene()

    const aw = this.atlasCols * this.cellPx
    const ah = this.atlasRows * this.cellPx
    const atlas = makeAtlas(aw, ah)
    this.atlasCanvas = atlas.canvas
    this.atlasTex = atlas.texture
    const blend = makeAtlas(aw, ah)
    this.blendCanvas = blend.canvas
    this.blendTex = blend.texture
    this.fadeFlagTex = this.makeFlagTexture()

    const from = this.makeCellTexture()
    this.tileFromCanvas = from.canvas
    this.tileFromTex = from.texture
    const to = this.makeCellTexture()
    this.tileToCanvas = to.canvas
    this.tileToTex = to.texture
    this.tileScratch = document.createElement('canvas')
    this.tileScratch.width = this.cellPx
    this.tileScratch.height = this.cellPx

    this.material = new THREE.ShaderMaterial({
      vertexShader: displayVert,
      fragmentShader: displayFrag,
      uniforms: {
        uAtlas: { value: this.atlasTex },
        uBlend: { value: this.blendTex },
        uFadeFlag: { value: this.fadeFlagTex },
        uMix: { value: 0 },
        uFluid: { value: this.fluid.densityTexture },
        uVelocity: { value: this.fluid.velocityTexture },
        uTime: { value: 0 },
        uGrid: { value: new THREE.Vector2(this.cols, this.rows) },
        uPad: { value: new THREE.Vector2(this.pad, this.pad) },
        uFocusPan: { value: new THREE.Vector2(0, 0) },
        uResolution: { value: new THREE.Vector2(this.cssW, this.cssH) },
        uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        uPointer: { value: new THREE.Vector2(0.5, 0.5) },
        uLensRadius: { value: this.lensRadius },
        uEnabled: { value: 1 },
        uDistort: { value: this.distort },
        uInk: { value: this.ink },
        uSoft: { value: this.edgeSoft },
        uFloor: { value: this.wispFloor },
        uTile: { value: 0 },
        uTileFrom: { value: this.tileFromTex },
        uTileTo: { value: this.tileToTex },
        uTileMix: { value: 0 },
        uSphere: { value: new THREE.Vector2(0, 0) },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material))

    // Visibility pass: same uniform objects as the display material, tiny target.
    const mu = this.material.uniforms
    this.visMaterial = new THREE.ShaderMaterial({
      vertexShader: displayVert,
      fragmentShader: visibilityFrag,
      uniforms: {
        uFluid: mu.uFluid,
        uGrid: mu.uGrid,
        uPad: mu.uPad,
        uFocusPan: mu.uFocusPan,
        uResolution: mu.uResolution,
        uTexel: mu.uTexel,
        uPointer: mu.uPointer,
        uLensRadius: mu.uLensRadius,
        uInk: mu.uInk,
        uFloor: mu.uFloor,
      },
      depthTest: false,
      depthWrite: false,
    })
    this.visScene = new THREE.Scene()
    this.visScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.visMaterial))
    this.visRT = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    })
    this.resizeVisibility()

    this.syncFluidTexel()
    this.syncLensToCell()
  }

  private makeFlagTexture(): THREE.DataTexture {
    const cols = this.atlasCols
    const rows = this.atlasRows
    const tex = new THREE.DataTexture(new Uint8Array(cols * rows), cols, rows, THREE.RedFormat, THREE.UnsignedByteType)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.generateMipmaps = false
    tex.needsUpdate = true
    return tex
  }

  /** Flag which atlas cells (canvas order, row 0 = top) take part in the fade. */
  private setFadeFlags(cells: number[]): void {
    const cols = this.atlasCols
    const rows = this.atlasRows
    const data = this.fadeFlagTex.image.data as Uint8Array
    data.fill(0)
    for (const i of cells) {
      const r = Math.floor(i / cols)
      const c = i % cols
      data[(rows - 1 - r) * cols + c] = 255 // texture rows run bottom-up
    }
    this.fadeFlagTex.needsUpdate = true
  }

  private resizeVisibility(): void {
    const s = GridEngine.VIS_S
    const w = this.atlasCols * s
    const h = this.atlasRows * s
    this.visRT.setSize(w, h)
    this.visBuf = new Uint8Array(w * h * 4)
    this.frozen = new Uint8Array(this.atlasCols * this.atlasRows)
  }

  /**
   * Read back which atlas cells can currently be seen (halo / ink tail), grow that
   * set by one cell in every direction (the picture is dragged by the flow, so a
   * neighbour can bleed into view), and store it in `frozen`.
   */
  private updateVisibility(): void {
    const s = GridEngine.VIS_S
    const cols = this.atlasCols
    const rows = this.atlasRows
    const w = cols * s
    const h = rows * s

    if (!this.atmosphereEnabled || this.reducedMotion) {
      this.frozen.fill(0) // the whole grid is on show in debug / reduced-motion: nothing to hide behind
      return
    }

    this.renderer.setRenderTarget(this.visRT)
    this.renderer.render(this.visScene, this.camera)
    this.renderer.readRenderTargetPixels(this.visRT, 0, 0, w, h, this.visBuf)
    this.renderer.setRenderTarget(null)

    const seen = new Uint8Array(cols * rows)
    const THRESH = 26 // ≈ 0.10 of the reveal field: well below the visible edge (≈0.5)
    for (let r = 0; r < rows; r++) {
      const j = rows - 1 - r // render-target rows run bottom-up, canvas cell rows top-down
      for (let c = 0; c < cols; c++) {
        let m = 0
        for (let sy = 0; sy < s; sy++) {
          for (let sx = 0; sx < s; sx++) {
            const v = this.visBuf[((j * s + sy) * w + (c * s + sx)) * 4]
            if (v > m) m = v
          }
        }
        if (m > THRESH) seen[r * cols + c] = 1
      }
    }
    this.frozen.fill(0)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!seen[r * cols + c]) continue
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr
            const cc = c + dc
            if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) this.frozen[rr * cols + cc] = 1
          }
        }
      }
    }
  }

  private paintCell(i: number, item: ManifestItem, canvas: HTMLCanvasElement = this.atlasCanvas): boolean {
    const img = this.imageCache.get(item.id)
    if (!img || img.naturalWidth === 0) return false
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return false
    const { cellPx } = this
    const cols = this.atlasCols
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, (i % cols) * cellPx, Math.floor(i / cols) * cellPx, cellPx, cellPx)
    return true
  }

  /** Give every hidden cell its target image. Visible (and neighbouring) cells wait. */
  private applyHiddenSwaps(): void {
    const n = Math.min(this.target.length, this.frozen.length)
    let changed = false
    for (let i = 0; i < n; i++) {
      // Visible cells keep what they show. A cell that is still blank (its image had
      // not loaded yet) has nothing to protect, so it may fill in even while visible.
      if (this.frozen[i] && this.shown[i]) continue
      if (this.fading?.set.has(i)) continue // mid-fade: the fade owns this cell
      const want = this.target[i]
      if (!want || this.shown[i]?.id === want.id) continue
      if (this.paintCell(i, want)) {
        this.shown[i] = want
        changed = true
      }
    }
    if (changed) this.atlasDirty = true
  }

  private syncFluidTexel(): void {
    const img = this.fluid.densityTexture.image as { width?: number; height?: number } | undefined
    const w = Math.max(1, img?.width ?? 512)
    const h = Math.max(1, img?.height ?? 512)
    this.material.uniforms.uTexel.value.set(1 / w, 1 / h)
  }

  get atlasCols(): number {
    return this.cols + this.pad * 2
  }

  get atlasRows(): number {
    return this.rows + this.pad * 2
  }

  syncLensToCell(): void {
    const aspect = this.cssW / Math.max(this.cssH, 1)
    const halfW = (0.5 / this.cols) * aspect
    const halfH = 0.5 / this.rows
    // Outer edge of the halo (dist = lensRadius) is the inscribed circle of one cell,
    // so the aperture sits inside the square instead of the square sitting inside it.
    this.lensRadius = Math.min(halfW, halfH)
  }

  resize(cssW: number, cssH: number): void {
    this.cssW = Math.max(1, cssW)
    this.cssH = Math.max(1, cssH)
    this.renderer.setSize(this.cssW, this.cssH, false)
    this.material.uniforms.uResolution.value.set(this.cssW, this.cssH)
    this.fluid.resize(this.cssW, this.cssH)
    this.syncFluidTexel()
    this.syncLensToCell()
  }

  /**
   * The pointer has come to rest. In one move: glide the grid so the cell under the
   * aperture ends up centred on it, and cross-fade every still-visible cell to the new
   * set. Both run on the same slow eased clock. Nothing is in motion before this.
   */
  beginSettle(_panX: number, _panY: number): void {
    if (this.reducedMotion || !this.atmosphereEnabled) {
      this.commitFade()
      this.paintAll(this.target)
      return
    }
    this.commitFade() // finish any fade still running (instantly)

    const hx = 0.5 / Math.max(this.cols, 1)
    const hy = 0.5 / Math.max(this.rows, 1)
    // Centre the cell already under the aperture, so the glide cannot slide a different
    // picture into the cursor.
    const hover = this.hoveredCell()
    this.panAnim = {
      fx: this.focusPan.x,
      fy: this.focusPan.y,
      tx: Math.max(-hx, Math.min(hx, (hover.col + 0.5) / this.cols - this.pointer.x)),
      ty: Math.max(-hy, Math.min(hy, (hover.row + 0.5) / this.rows - (1 - this.pointer.y))),
      t: 0,
    }
    this.fadeSpeed = 1

    // Every cell that still shows something other than what the world wants.
    // (Hidden cells were swapped silently while moving, so these are the visible ones.)
    const cells: number[] = []
    const items: ManifestItem[] = []
    const n = Math.min(this.target.length, this.shown.length)
    for (let i = 0; i < n; i++) {
      const want = this.target[i]
      if (!want || this.shown[i]?.id === want.id) continue
      if (!this.imageCache.has(want.id)) continue // not decoded yet: it will swap in once hidden
      if (!this.paintCell(i, want, this.blendCanvas)) continue
      cells.push(i)
      items.push(want)
    }
    if (cells.length > 0) {
      this.blendTex.needsUpdate = true
      this.setFadeFlags(cells)
      this.fading = { cells, items, set: new Set(cells), t: 0 }
    }
    this.beginTileFade(hover.sx, hover.sy)
  }

  /** The pointer moved again: stop gliding, and wrap up any fade quickly instead of leaving it half-blended. */
  interrupt(): void {
    this.panAnim = null
    if (this.fading) this.fadeSpeed = 5
  }

  private makeCellTexture(): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
    const canvas = document.createElement('canvas')
    canvas.width = this.cellPx
    canvas.height = this.cellPx
    const texture = new THREE.CanvasTexture(canvas)
    texture.magFilter = THREE.LinearFilter
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    texture.colorSpace = THREE.SRGBColorSpace
    texture.flipY = true
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    return { canvas, texture }
  }

  /** Atlas cell currently framed by the aperture. */
  private hoveredCell(): { index: number; sx: number; sy: number; col: number; row: number } {
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor((this.pointer.x + this.focusPan.x) * this.cols)))
    const row = Math.min(
      this.rows - 1,
      Math.max(0, Math.floor((1 - this.pointer.y + this.focusPan.y) * this.rows)),
    )
    const atlasCol = this.pad + col
    const atlasRow = this.atlasRows - this.pad - row - 1
    return {
      index: atlasRow * this.atlasCols + atlasCol,
      sx: atlasCol * this.cellPx,
      sy: atlasRow * this.cellPx,
      col,
      row,
    }
  }

  /** Ease the sphere texture into the picture under the aperture. That cell is not repainted. */
  private beginTileFade(sx: number, sy: number): void {
    const scratch = this.tileScratch.getContext('2d', { alpha: false })
    const from = this.tileFromCanvas.getContext('2d', { alpha: false })
    const to = this.tileToCanvas.getContext('2d', { alpha: false })
    if (!scratch || !from || !to) return

    scratch.globalAlpha = 1
    if (!this.tileOn) {
      scratch.fillStyle = '#ffffff'
      scratch.fillRect(0, 0, this.cellPx, this.cellPx)
    } else {
      scratch.drawImage(this.tileFromCanvas, 0, 0)
      scratch.globalAlpha = this.tileMix
      scratch.drawImage(this.tileToCanvas, 0, 0)
    }
    from.globalAlpha = 1
    from.drawImage(this.tileScratch, 0, 0)
    this.tileFromTex.needsUpdate = true

    to.drawImage(this.atlasCanvas, sx, sy, this.cellPx, this.cellPx, 0, 0, this.cellPx, this.cellPx)
    this.tileToTex.needsUpdate = true

    this.tileOn = true
    this.tileMix = 0
    this.tileFade = 0
  }

  /** Make the fade final: faded cells take their new picture in the atlas itself. */
  private commitFade(): void {
    const f = this.fading
    if (!f) return
    for (let k = 0; k < f.cells.length; k++) {
      if (this.paintCell(f.cells[k], f.items[k])) this.shown[f.cells[k]] = f.items[k]
    }
    this.fading = null
    this.fadeSpeed = 1
    this.material.uniforms.uMix.value = 0
    this.setFadeFlags([])
    this.atlasTex.needsUpdate = true // same frame as uMix = 0, so nothing flickers
    this.atlasDirty = false
    this.lastUpload = performance.now()
  }

  /**
   * Keep the border of the halo alive at rest: a few tiny, dense dots orbit the
   * rim with a tangential push, so the ink edge keeps curling instead of being
   * a perfect circle.
   */
  private stirRim(time: number): void {
    if (this.rimStir <= 0) return
    const aspect = this.cssW / Math.max(this.cssH, 1)
    const px = this.pointer.x
    const py = 1 - this.pointer.y
    const r = this.lensRadius * 0.8
    for (let i = 0; i < 3; i++) {
      const th = time * (0.55 + i * 0.23) * (i % 2 ? -1 : 1) + i * 2.1
      const cx = Math.cos(th)
      const cy = Math.sin(th)
      const dir = i % 2 ? -1 : 1
      const g = this.rimStir
      this.fluid.addSplat(px + (cx * r) / aspect, py + cy * r, -cy * 14 * dir * g, cx * 14 * dir * g, {
        radius: 0.00012,
        color: [-cy * 14 * dir * g, cx * 14 * dir * g, 0.05 * g],
      })
    }
  }

  setGrid(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    const w = this.atlasCols * this.cellPx
    const h = this.atlasRows * this.cellPx
    for (const cv of [this.atlasCanvas, this.blendCanvas]) {
      cv.width = w
      cv.height = h
      const ctx = cv.getContext('2d', { alpha: false })
      if (ctx) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
      }
    }
    this.atlasTex.needsUpdate = true
    this.blendTex.needsUpdate = true
    this.fading = null
    this.panAnim = null
    this.material.uniforms.uMix.value = 0
    this.fadeFlagTex.dispose()
    this.fadeFlagTex = this.makeFlagTexture()
    this.material.uniforms.uFadeFlag.value = this.fadeFlagTex
    this.material.uniforms.uGrid.value.set(cols, rows)
    this.material.uniforms.uPad.value.set(this.pad, this.pad)
    this.shown = []
    this.target = []
    this.lastAssign = []
    this.resizeVisibility()
    this.syncLensToCell()
  }

  get busy(): boolean {
    return false
  }

  clearPending(): void {}

  async preload(items: ManifestItem[]): Promise<void> {
    const unique = [...new Map(items.map((i) => [i.id, i])).values()]
    await Promise.all(unique.map((item) => this.loadImage(item)))
  }

  private loadImage(item: ManifestItem): Promise<HTMLImageElement | null> {
    const cached = this.imageCache.get(item.id)
    if (cached?.complete && cached.naturalWidth > 0) return Promise.resolve(cached)
    return new Promise((resolve) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => {
        this.imageCache.set(item.id, img)
        resolve(img)
      }
      img.onerror = () => resolve(null)
      img.src = assetUrl(item.asset)
    })
  }

  /** Paint every cell at once (first frame, resize, debug / reduced motion). */
  private paintAll(items: ManifestItem[]): void {
    const ctx = this.atlasCanvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'copy'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, this.atlasCanvas.width, this.atlasCanvas.height)
    ctx.globalCompositeOperation = 'source-over'
    this.shown = new Array(items.length).fill(undefined)
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item && this.paintCell(i, item)) this.shown[i] = item
    }
    this.atlasTex.needsUpdate = true
    this.atlasDirty = false
  }

  /**
   * Tell the engine what the world wants each atlas cell to show.
   *  animate=false → paint it all immediately (nothing has been seen yet).
   *  animate=true  → only record it; cells adopt it while hidden by the white.
   */
  setAssignment(items: ManifestItem[], animate: boolean): void {
    const same =
      this.lastAssign.length === items.length &&
      this.lastAssign.every((it, i) => it?.id === items[i]?.id)
    if (same) return

    const gen = ++this.assignGen
    this.lastAssign = items.slice()
    this.target = items.slice()

    const immediate =
      !animate || this.reducedMotion || this.instantSwap || !this.atmosphereEnabled || this.shown.length === 0

    if (immediate) {
      this.paintAll(items)
      if (!items.every((it) => this.imageCache.has(it.id))) {
        void this.preload(items).then(() => {
          if (gen !== this.assignGen) return
          this.paintAll(items)
        })
      }
      return
    }

    // Decode targets in the background; cells swap in as soon as they are ready AND hidden.
    void this.preload(items)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTs = performance.now()
    const loop = (ts: number) => {
      if (!this.running) return
      this.raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (ts - this.lastTs) / 1000)
      this.lastTs = ts
      if (dt > 0) this.fps = this.fps * 0.9 + (1 / dt) * 0.1
      this.tick(ts / 1000, dt)
      this.onDebug?.({
        fps: this.fps,
        transitioning: false,
        progress: 1,
      })
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  /**
   * Stamp ink continuously along the path the aperture travelled this frame,
   * so the tail is one unbroken ribbon however fast the pointer moves.
   */
  private stampTrail(): void {
    const aspect = this.cssW / Math.max(this.cssH, 1)
    const x = this.pointer.x
    const y = 1 - this.pointer.y
    if (this.stampPrev) {
      const dx = (x - this.stampPrev.x) * aspect
      const dy = y - this.stampPrev.y
      const len = Math.hypot(dx, dy)
      if (len > 1e-5 && len < 0.6) {
        const n = Math.min(32, Math.max(1, Math.ceil(len / 0.008)))
        const ux = dx / len
        const uy = dy / len
        const push = Math.min(14, 2 + len * 600)
        for (let i = 1; i <= n; i++) {
          const t = i / n
          const sx = this.stampPrev.x + (x - this.stampPrev.x) * t
          const sy = this.stampPrev.y + (y - this.stampPrev.y) * t
          this.fluid.addSplat(sx, sy, ux * push, uy * push, {
            radius: 0.00032,
            color: [ux * push, uy * push, 0.04],
          })
        }
      }
    }
    this.stampPrev = { x, y }
  }

  private tick(time: number, dt: number): void {
    if (this.atmosphereEnabled && !this.reducedMotion) {
      this.stampTrail()
      this.stirRim(time)
    }
    this.fluid.step(Math.max(dt, 1 / 120))

    const u = this.material.uniforms

    // The glide that frames the cell under the aperture: eased in AND out, same clock as the fade.
    if (this.panAnim) {
      const a = this.panAnim
      a.t = Math.min(1, a.t + dt / this.settleDuration)
      const e = a.t * a.t * (3 - 2 * a.t)
      this.focusPan.x = a.fx + (a.tx - a.fx) * e
      this.focusPan.y = a.fy + (a.ty - a.fy) * e
      if (a.t >= 1) this.panAnim = null
    }

    // The slow cross-fade of the visible cells to the new set.
    if (this.fading) {
      this.fading.t = Math.min(1, this.fading.t + (dt * this.fadeSpeed) / this.settleDuration)
      const t = this.fading.t
      u.uMix.value = t * t * (3 - 2 * t)
      if (t >= 1) this.commitFade()
    }

    if (this.spherePrev) {
      const dx = this.pointer.x - this.spherePrev.x
      const dy = this.pointer.y - this.spherePrev.y
      this.sphereVel.x += dx * 7
      this.sphereVel.y += dy * 5
    }
    this.spherePrev = { x: this.pointer.x, y: this.pointer.y }
    const damp = Math.exp(-dt / 0.6)
    this.sphereVel.x *= damp
    this.sphereVel.y *= damp
    const cap = 3.2
    this.sphereVel.x = Math.max(-cap, Math.min(cap, this.sphereVel.x))
    this.sphereVel.y = Math.max(-cap, Math.min(cap, this.sphereVel.y))
    this.sphereAng.x += this.sphereVel.x * dt
    this.sphereAng.y += this.sphereVel.y * dt

    if (this.tileFade !== null) {
      this.tileFade = Math.min(1, this.tileFade + dt / this.settleDuration)
      const t = this.tileFade
      this.tileMix = t * t // ease in: slow to leave the old picture, then it arrives
      if (t >= 1) this.tileFade = null
    }

    u.uTime.value = time
    u.uFluid.value = this.fluid.densityTexture
    u.uVelocity.value = this.fluid.velocityTexture
    u.uFocusPan.value.set(this.focusPan.x, this.focusPan.y)
    u.uPointer.value.set(this.pointer.x, 1.0 - this.pointer.y)
    this.syncFluidTexel()
    u.uLensRadius.value = this.lensRadius
    u.uDistort.value = this.distort
    u.uInk.value = this.ink
    u.uSoft.value = this.edgeSoft
    u.uFloor.value = this.wispFloor
    u.uTile.value = this.tileOn ? 1 : 0
    u.uTileMix.value = this.tileMix
    u.uSphere.value.set(this.sphereAng.x, this.sphereAng.y)
    u.uEnabled.value = this.atmosphereEnabled && !this.reducedMotion ? 1 : 0

    this.renderer.setRenderTarget(null)
    this.renderer.setClearColor(WHITE, 1)
    this.renderer.clear()
    this.renderer.render(this.scene, this.camera)

    // Hidden-cell swaps: look at what is visible a few times a second, hand every
    // hidden cell its target, and push the atlas to the GPU at a gentle rate.
    this.frameNo++
    if (this.frameNo % 3 === 0) {
      this.updateVisibility()
      this.applyHiddenSwaps()
    }
    if (this.atlasDirty && performance.now() - this.lastUpload > 120) {
      this.atlasTex.needsUpdate = true
      this.atlasDirty = false
      this.lastUpload = performance.now()
    }
  }

  dispose(): void {
    this.stop()
    this.detachPointer()
    this.assignGen++
    this.fluid.dispose()
    this.atlasTex.dispose()
    this.blendTex.dispose()
    this.tileFromTex.dispose()
    this.tileToTex.dispose()
    this.fadeFlagTex.dispose()
    this.visRT.dispose()
    this.visMaterial.dispose()
    this.material.dispose()
    this.renderer.dispose()
  }
}
