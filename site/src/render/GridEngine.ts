import * as THREE from 'three'
import { attachPointerSplats, FluidSimulation } from 'three-fluid-fx'
import type { PictureSource } from '../data/imageStore'
import type { ManifestItem } from '../data/types'
import { displayFrag, displayVert, visibilityFrag } from './shaders'

export type TransitionMode = 'crossfade' | 'blockwise'

export type EngineOptions = {
  canvas: HTMLCanvasElement
  cols: number
  rows: number
  /** Square cells the screen spans (fractional). Defaults to cols × rows. */
  viewCols?: number
  viewRows?: number
  cellPx?: number
}

export type EngineDebug = {
  fps: number
  transitioning: boolean
  progress: number
}

const WHITE = 0xffffff
const PAD = 2
/** Device pixels per CSS pixel the canvas renders at, at most. */
export const MAX_PIXEL_RATIO = 1.25
/** Cell uploads per frame, shared by the atlas and the fade texture. */
const UPLOADS_PER_FRAME = 16
/** Cells filled (blank) or sharpened (preview to photo) per frame. */
const FILLS_PER_FRAME = 16

/** Tab icon. Drawn small from the settled picture and swapped onto the existing icon link. */
function setFavicon(img: CanvasImageSource): void {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(img, 0, 0, size, size)
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.type = 'image/png'
  link.href = canvas.toDataURL('image/png')
}

/**
 * A larger, gentler trefoil tube with one half-twist, so it stays a Klein bottle.
 * The path is wide compared with the tube, so the picture is not wrapped around a
 * tight bend. Normals follow the wall instead of sitting flat on each facet, so
 * there are no corners. A slight smooth swell in the radius lets the surface
 * turn without creasing.
 */
function buildKleinGeometry(): { geometry: THREE.BufferGeometry; aim: THREE.Vector3 } {
  const NU = 160
  const NV = 28
  const tube = 1.42
  const curve = (t: number) => {
    const a = 4.4
    const b = 1.35
    const c3 = Math.cos(3 * t)
    const s3 = Math.sin(3 * t)
    return new THREE.Vector3((a + b * c3) * Math.cos(2 * t), (a + b * c3) * Math.sin(2 * t), b * s3)
  }

  const pts: THREE.Vector3[] = []
  const tangents: THREE.Vector3[] = []
  for (let i = 0; i < NU; i++) {
    const t = (i / NU) * Math.PI * 2
    pts.push(curve(t))
    const dt = 0.002
    tangents.push(curve(t + dt).sub(curve(t - dt)).normalize())
  }
  const origin = pts[0].clone()
  for (const p of pts) p.sub(origin)

  const normals: THREE.Vector3[] = []
  const t0 = tangents[0]
  // Seed the cross-section so image-up on the side walls matches the camera's up.
  // A tube can't be upright all the way around, and the half-twist still turns the
  // picture as it runs down the tunnel, but the walls filling the view start upright.
  const worldUp = new THREE.Vector3(0, 1, 0)
  let normal = worldUp.clone().addScaledVector(t0, -worldUp.dot(t0))
  if (normal.lengthSq() < 1e-6) normal.set(1, 0, 0).addScaledVector(t0, -t0.x)
  normal.normalize().negate()
  const axis = new THREE.Vector3()
  for (let i = 0; i < NU; i++) {
    normals.push(normal.clone())
    if (i === NU - 1) break
    const prev = tangents[i]
    const next = tangents[i + 1]
    axis.crossVectors(prev, next)
    const s = axis.length()
    const c = prev.dot(next)
    if (s > 1e-5) {
      axis.multiplyScalar(1 / s)
      normal.applyAxisAngle(axis, Math.atan2(s, c))
    }
    normal.addScaledVector(next, -normal.dot(next))
    if (normal.lengthSq() > 1e-8) normal.normalize()
  }

  const ring = (i: number, j: number) => {
    const ii = i === NU ? 0 : i
    const twist = (i / NU) * Math.PI
    const v = (j / NV) * Math.PI * 2 + twist
    const N = normals[ii]
    const B = new THREE.Vector3().crossVectors(tangents[ii], N)
    const swell = 1 + 0.05 * Math.sin((i / NU) * Math.PI * 4)
    const outward = N.clone()
      .multiplyScalar(Math.cos(v))
      .addScaledVector(B, Math.sin(v))
    if (outward.lengthSq() > 1e-8) outward.normalize()
    return {
      p: pts[ii].clone().addScaledVector(outward, tube * swell),
      n: outward,
    }
  }

  const along = [0]
  for (let i = 1; i < NU; i++) along.push(along[i - 1] + pts[i].distanceTo(pts[i - 1]))
  const span = along[NU - 1] + pts[0].distanceTo(pts[NU - 1])
  let girth = 0
  for (let j = 0; j < NV; j++) girth += ring(0, j).p.distanceTo(ring(0, j + 1).p)
  const uAt = (i: number) => (i >= NU ? span : along[i])
  const vAt = (j: number) => (j / NV) * girth
  const pos: number[] = []
  const nrm: number[] = []
  const uv: number[] = []
  const pushTri = (
    a: { p: THREE.Vector3; n: THREE.Vector3 },
    b: { p: THREE.Vector3; n: THREE.Vector3 },
    c: { p: THREE.Vector3; n: THREE.Vector3 },
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
  ) => {
    const verts: [{ p: THREE.Vector3; n: THREE.Vector3 }, [number, number]][] = [
      [a, ua],
      [b, ub],
      [c, uc],
    ]
    for (const [vn, u] of verts) {
      pos.push(vn.p.x, vn.p.y, vn.p.z)
      nrm.push(vn.n.x, vn.n.y, vn.n.z)
      uv.push(u[0], u[1])
    }
  }
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      const p00 = ring(i, j)
      const p10 = ring(i + 1, j)
      const p01 = ring(i, j + 1)
      const p11 = ring(i + 1, j + 1)
      const u0 = uAt(i)
      const u1 = uAt(i + 1)
      const v0 = vAt(j)
      const v1 = vAt(j + 1)
      pushTri(p00, p10, p11, [u0, v0], [u1, v0], [u1, v1])
      pushTri(p00, p11, p01, [u0, v0], [u1, v1], [u0, v1])
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return { geometry: g, aim: tangents[0].clone() }
}

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
  private kleinScene!: THREE.Scene
  private kleinCamera!: THREE.PerspectiveCamera
  private kleinMaterial!: THREE.ShaderMaterial
  private kleinRT!: THREE.WebGLRenderTarget
  private kleinSampleRT!: THREE.WebGLRenderTarget
  private kleinBlurScene!: THREE.Scene
  private kleinBlurMaterial!: THREE.ShaderMaterial
  private readonly detachPointer: () => void

  private atlasCanvas: HTMLCanvasElement
  private atlasTex: THREE.CanvasTexture
  /**
   * Cells painted on the CPU but not yet on the GPU. They go up a few per frame
   * as sub-images; only a resize or a full repaint replaces the whole texture.
   */
  private readonly atlasDirty = new Set<number>()
  private readonly blendDirty = new Set<number>()
  private forceFullAtlas = true
  private forceFullBlend = true
  private readonly uploadCanvas: HTMLCanvasElement
  /** Incoming pictures for the post-settle fade (only the faded cells are painted). */
  private blendCanvas: HTMLCanvasElement
  private blendTex: THREE.CanvasTexture
  private fadeFlagTex: THREE.DataTexture
  /** `armed` once the incoming pictures are on the GPU; the fade clock waits for it. */
  private fading: { cells: number[]; items: ManifestItem[]; set: Set<number>; t: number; armed: boolean } | null =
    null
  /** A finished fade whose cells are still uploading into the atlas. The blend keeps covering them. */
  private committing: number[] | null = null
  private fadeSpeed = 1
  /** Seconds the settle fade (and the glide that frames the cell) takes. */
  settleDuration = 1.0
  private panAnim: { fx: number; fy: number; tx: number; ty: number; t: number } | null = null
  /** Rim stir at rest. 0 = perfectly calm aperture; kept tiny so the edge isn't dead. */
  /** Idle rim swirl. 0 = aperture is still when the mouse is still (any value > 0 slowly accumulates ink). */
  rimStir = 0
  /** Where photos and previews come from. Nothing paints until it is set. */
  source: PictureSource | null = null

  // ---- hidden-cell swapping -------------------------------------------
  // The atlas only changes where the white covers it. `target` is what the world
  // wants each atlas cell to show; `shown` is what the cell shows right now. A
  // cell takes its target only while it is NOT visible through the halo or tail
  // (nor next to something that is), so no swap or fade is ever seen.
  private target: ManifestItem[] = []
  private shown: (ManifestItem | undefined)[] = []
  /** 1 where the cell holds the real photo, 0 where it holds a preview (or nothing). */
  private sharp = new Uint8Array(0)
  private frozen = new Uint8Array(0)
  private visRT: THREE.WebGLRenderTarget
  private visScene: THREE.Scene
  private visMaterial: THREE.ShaderMaterial
  private visBuf = new Uint8Array(0)
  private frameNo = 0
  /** Samples per atlas cell edge in the visibility pass. */
  private static readonly VIS_S = 3

  /** Whole cells in the visible part of the atlas (the pad is extra). */
  cols: number
  rows: number
  /** Square cells the screen actually spans; ≤ cols / rows, centred in them. */
  viewCols: number
  viewRows: number
  cellPx: number
  readonly pad = PAD

  /** Kept for the debug panel; swaps are no longer cross-faded, they happen under the white. */
  transitionMode: TransitionMode = 'crossfade'
  instantSwap = false

  lensRadius = 0.00035
  /** Closed popover: white page, the bottle only inside the cursor. Open: the grid, with the bottle over it. */
  stage: 'grid' | 'cursor' = 'cursor'
  /** screen while the popover is closed, exclusion while it is open. */
  blend = 2
  /** Off: those two blends. On: the photo-forward custom mixes. */
  customBlend = false
  /** True once the pointer has been still long enough to settle. */
  pointerIdle = true
  /**
   * Open page: the grid is the page, so cells outside the aperture adopt their
   * new picture while the pointer is still moving. The white page leaves this off.
   */
  liveShuffle = false
  private shuffleCursor = 0
  /** 0 = the aperture disc is the bare cell; 1 = the blend covers the disc too. */
  discCover = 1
  /** 0 at rest, 1 at a fast stroke. Widens the soft hole in the overlay around the orb. */
  focusBleed = 0
  /** Name under the white page. The reveal goes transparent over its glyphs. */
  showNamePlate = false
  private namePlateReady = false
  private readonly namePlateCanvas: HTMLCanvasElement
  private namePlateTex: THREE.CanvasTexture
  /** Klein average at the bottom of the name, saturated color at the top. */
  private readonly nameAvg = new THREE.Color(0, 0, 0)
  private readonly nameAvgFrom = new THREE.Color(0, 0, 0)
  private readonly nameAvgTo = new THREE.Color(0, 0, 0)
  private readonly namePop = new THREE.Color(0, 0, 0)
  private readonly namePopFrom = new THREE.Color(0, 0, 0)
  private readonly namePopTo = new THREE.Color(0, 0, 0)
  private readonly nameSpan = new THREE.Vector2(0, 0.2)
  private readonly nameSampleCanvas: HTMLCanvasElement = document.createElement('canvas')
  static readonly BLENDS = ['lighten', 'difference', 'screen', 'multiply', 'exclusion'] as const
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
   * The picture under the aperture when you settle, mapped onto the Klein bottle.
   * The rest of the set can change; this cell is not part of that fade.
   */
  private tileOn = false
  private tileMix = 0
  /** Orientation of the bottle. Identity is the pose where the photos in view stand up. */
  private readonly sphereQuat = new THREE.Quaternion()
  /** World-space angular velocity. The heading turns slowly, so a reverse rolls past. */
  private readonly spin = new THREE.Vector3()
  private spherePrev: { x: number; y: number } | null = null
  private readonly camForward = new THREE.Vector3()
  private readonly camUp = new THREE.Vector3()
  private readonly camRight = new THREE.Vector3()
  private readonly wish = new THREE.Vector3()
  private readonly wishDir = new THREE.Vector3()
  private readonly spinDir = new THREE.Vector3()
  private readonly spinAxis = new THREE.Vector3()
  private readonly restore = new THREE.Vector3()
  private readonly spinStep = new THREE.Quaternion()
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
    this.viewCols = opts.viewCols ?? opts.cols
    this.viewRows = opts.viewRows ?? opts.rows
    this.cellPx = opts.cellPx ?? 256

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      alpha: true,
      premultipliedAlpha: false,
    })
    this.renderer.setClearColor(WHITE, 1)
    this.namePlateCanvas = document.createElement('canvas')
    this.namePlateCanvas.width = 1
    this.namePlateCanvas.height = 1
    this.namePlateTex = new THREE.CanvasTexture(this.namePlateCanvas)
    this.namePlateTex.colorSpace = THREE.NoColorSpace
    this.namePlateTex.flipY = true
    this.namePlateTex.generateMipmaps = false
    this.namePlateTex.minFilter = THREE.LinearFilter
    this.namePlateTex.magFilter = THREE.LinearFilter
    // A fullscreen shader quad gains nothing from MSAA. Above ~1.25× the extra
    // pixels show up as pointer lag before they sharpen the aperture.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.autoClear = true

    this.cssW = Math.max(1, opts.canvas.clientWidth || window.innerWidth)
    this.cssH = Math.max(1, opts.canvas.clientHeight || window.innerHeight)
    this.renderer.setSize(this.cssW, this.cssH, false)

    this.fluid = new FluidSimulation(this.renderer as never, {
      profile: 'balanced',
      splatRadius: 0.00042,
      splatForce: 12,
      // Density is faded in the advection shader below, not by this constant.
      densityDissipation: 1,
      velocityDissipation: 0.9945,
      curlStrength: 14,
      enableVorticity: true,
      reflectWalls: false,
      // BFECC re-runs advection about five times for a sharper tail. The stroke
      // was hitching on it; one advection pass keeps the same ink curve.
      bfecc: false,
      pressureIterations: 8,
    })
    this.fluid.resize(this.cssW, this.cssH)
    // Once a stroke is no longer being replenished, its freshness (splat alpha)
    // decays. Density barely moves while that freshness is high, then the keep
    // rate falls so the tail collapses instead of thinning at one constant speed.
    const advectDensity = (this.fluid as unknown as { advectDensityMaterial: THREE.ShaderMaterial })
      .advectDensityMaterial
    advectDensity.fragmentShader = /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uVelocity;
      uniform sampler2D uSource;
      uniform vec2 texelSize;
      uniform float dt;
      uniform float dissipation;
      uniform float uBFECC;
      void main() {
        vec2 coord;
        if (uBFECC < 0.5) {
          coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        } else {
          vec2 vel = texture2D(uVelocity, vUv).xy;
          vec2 spotOld = vUv - vel * dt * texelSize;
          vec2 velBack = texture2D(uVelocity, spotOld).xy;
          vec2 spotForward = spotOld + velBack * dt * texelSize;
          vec2 error = spotForward - vUv;
          vec2 spotMid = vUv - error * 0.5;
          vec2 velMid = texture2D(uVelocity, spotMid).xy;
          coord = spotMid - velMid * dt * texelSize;
        }
        vec4 src = texture2D(uSource, coord);
        src.rg *= dissipation;
        float youth = src.a * exp(-dt / 1.15);
        float life = smoothstep(0.03, 0.5, youth);
        life *= life;
        float keepPerSec = mix(0.06, 0.94, life);
        src.b *= pow(keepPerSec, dt);
        gl_FragColor = vec4(src.rgb, youth);
      }
    `
    advectDensity.needsUpdate = true
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
    this.uploadCanvas = document.createElement('canvas')
    this.uploadCanvas.width = this.cellPx
    this.uploadCanvas.height = this.cellPx

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
        uView: { value: new THREE.Vector2(this.viewCols, this.viewRows) },
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
        uStage: { value: 0 },
        uBlendMode: { value: 2 },
        uCustom: { value: 0 },
        uDiscCover: { value: 1 },
        uFocus: { value: 0 },
        uNameOn: { value: 0 },
        uNamePlate: { value: this.namePlateTex },
        uNameAvg: { value: new THREE.Color(0, 0, 0) },
        uNamePop: { value: new THREE.Color(0, 0, 0) },
        uNameSpan: { value: this.nameSpan },
        uKlein: { value: null },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material))
    this.initKlein()

    // Visibility pass: same uniform objects as the display material, tiny target.
    const mu = this.material.uniforms
    this.visMaterial = new THREE.ShaderMaterial({
      vertexShader: displayVert,
      fragmentShader: visibilityFrag,
      uniforms: {
        uFluid: mu.uFluid,
        uGrid: mu.uGrid,
        uView: mu.uView,
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
    this.sharp = new Uint8Array(this.atlasCols * this.atlasRows)
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

  /**
   * Paint a cell from the photo, or from its blurred preview when the photo isn't
   * in memory and `preview` allows it. Returns what was painted.
   */
  private paintCell(
    i: number,
    item: ManifestItem,
    canvas: HTMLCanvasElement = this.atlasCanvas,
    preview = true,
  ): 'photo' | 'preview' | null {
    const src = this.source
    if (!src) return null
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return null
    const { cellPx } = this
    const cols = this.atlasCols
    const x = (i % cols) * cellPx
    const y = Math.floor(i / cols) * cellPx
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    let painted: 'photo' | 'preview' | null = null
    const bmp = src.bitmap(item.id)
    if (bmp) {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bmp, x, y, cellPx, cellPx)
      painted = 'photo'
    } else if (preview && src.drawPlaceholder(ctx, item.id, x, y, cellPx)) {
      painted = 'preview'
    }
    if (!painted) return null
    if (canvas === this.atlasCanvas) {
      this.atlasDirty.add(i)
      this.sharp[i] = painted === 'photo' ? 1 : 0
    } else if (canvas === this.blendCanvas) {
      this.blendDirty.add(i)
    }
    return painted
  }

  private shownIds(): Set<string> {
    const used = new Set<string>()
    for (let i = 0; i < this.shown.length; i++) {
      const id = this.shown[i]?.id
      if (id) used.add(id)
    }
    return used
  }

  /** Give every hidden cell its target image. Visible (and neighbouring) cells wait. */
  private applyHiddenSwaps(): void {
    const n = Math.min(this.target.length, this.frozen.length)
    const used = this.shownIds()
    for (let i = 0; i < n; i++) {
      // Visible cells keep what they show. Blank cells are filled by fillPending.
      if (this.frozen[i] || !this.shown[i]) continue
      if (this.fading?.set.has(i)) continue // mid-fade: the fade owns this cell
      const want = this.target[i]
      if (!want || this.shown[i]?.id === want.id) continue
      // Don't paint a picture that is still on screen somewhere else in this matrix.
      if (used.has(want.id)) continue
      const prev = this.shown[i]?.id
      // Only photos swap in. Trading a picture for a blur (even another blur) makes a cell wait again.
      if (this.paintCell(i, want, this.atlasCanvas, false)) {
        this.shown[i] = want
        if (prev) used.delete(prev)
        used.add(want.id)
      }
    }
  }

  /**
   * Every frame, on both pages, moving or not. A blank or blurred cell has nothing
   * to protect: a blank takes its target (photo or preview); a preview sharpens
   * into its own photo, or takes its target's photo, whichever is in memory first.
   * Cells showing a photo are left to the swaps, the shuffle and the settle fade.
   */
  private fillPending(): void {
    const src = this.source
    if (!src) return
    const n = Math.min(this.target.length, this.shown.length)
    let used: Set<string> | null = null
    let budget = FILLS_PER_FRAME
    for (let i = 0; i < n && budget > 0; i++) {
      const want = this.target[i]
      const cur = this.shown[i]
      if (this.sharp[i] || this.fading?.set.has(i)) continue
      if (cur && src.isFailed(cur.id)) {
        // This blur will never sharpen. Take the replacement as soon as it can be painted.
        if (!want || want.id === cur.id || src.isFailed(want.id)) continue
        used ??= this.shownIds()
        if (used.has(want.id)) continue
        if (this.paintCell(i, want)) {
          used.delete(cur.id)
          used.add(want.id)
          this.shown[i] = want
          budget--
        }
        continue
      }
      if (cur) {
        // Asking for a bitmap also starts its decode when the bytes are already here.
        if (this.paintCell(i, cur, this.atlasCanvas, false)) {
          budget--
          continue
        }
        if (!want || want.id === cur.id) continue
        used ??= this.shownIds()
        if (used.has(want.id)) continue
        if (this.paintCell(i, want, this.atlasCanvas, false)) {
          used.delete(cur.id)
          used.add(want.id)
          this.shown[i] = want
          budget--
        }
        continue
      }
      if (!want) continue
      used ??= this.shownIds()
      if (used.has(want.id)) continue
      if (this.paintCell(i, want)) {
        this.shown[i] = want
        used.add(want.id)
        budget--
      }
    }
  }

  /**
   * The photo a cell is waiting on: the one behind the preview it shows, or its
   * target while it is still blank. Undefined once it shows a photo.
   */
  waitingOn(i: number): ManifestItem | undefined {
    if (this.sharp[i]) return undefined
    const failed = (it?: ManifestItem) => !!it && !!this.source?.isFailed(it.id)
    const cur = this.shown[i]
    if (cur && !failed(cur)) return cur
    const want = this.target[i]
    if (want && !failed(want)) return want
    return undefined
  }

  /**
   * On the open page, paint new pictures straight into the cells you can see.
   * The cell under the pointer, and its neighbours, stay put so the disc doesn't
   * flicker. A handful per frame keeps the upload from landing all at once.
   */
  private shuffleLiveGrid(): void {
    if (!this.liveShuffle || this.reducedMotion || !this.atmosphereEnabled) return
    const n = Math.min(this.target.length, this.shown.length)
    if (n === 0) return
    const hover = this.hoveredCell().index
    const cols = this.atlasCols
    const hc = hover % cols
    const hr = (hover / cols) | 0
    const used = this.shownIds()
    let swapped = 0
    for (let k = 0; k < n && swapped < 12; k++) {
      const i = (this.shuffleCursor + k) % n
      const c = i % cols
      const r = (i / cols) | 0
      if (Math.abs(c - hc) <= 1 && Math.abs(r - hr) <= 1) continue
      if (this.fading?.set.has(i)) continue
      const want = this.target[i]
      if (!want || this.shown[i]?.id === want.id) continue
      if (used.has(want.id)) continue
      const prev = this.shown[i]?.id
      if (!this.paintCell(i, want, this.atlasCanvas, !this.shown[i])) continue
      this.shown[i] = want
      if (prev) used.delete(prev)
      used.add(want.id)
      swapped++
    }
    this.shuffleCursor = (this.shuffleCursor + 12) % n
  }

  /** The GL handle for a texture, uploading it whole first if it has never been. */
  private glTexture(tex: THREE.Texture): WebGLTexture | undefined {
    this.renderer.initTexture(tex)
    return (this.renderer.properties.get(tex) as { __webglTexture?: WebGLTexture }).__webglTexture
  }

  /** Copy cells from a canvas into its texture as sub-images. Returns how many went up. */
  private uploadCells(
    tex: THREE.CanvasTexture,
    canvas: HTMLCanvasElement,
    cells: Iterable<number>,
    limit: number,
    done?: Set<number>,
  ): number {
    if (limit <= 0) return 0
    const glTex = this.glTexture(tex)
    if (!glTex) return 0
    const gl = this.renderer.getContext()
    const sctx = this.uploadCanvas.getContext('2d', { alpha: false })
    if (!sctx) return 0
    const px = this.cellPx
    const cols = this.atlasCols
    const h = canvas.height
    gl.bindTexture(gl.TEXTURE_2D, glTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    let sent = 0
    for (const i of cells) {
      if (sent >= limit) break
      const col = i % cols
      const row = Math.floor(i / cols)
      sctx.drawImage(canvas, col * px, row * px, px, px, 0, 0, px, px)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, col * px, h - (row + 1) * px, gl.RGBA, gl.UNSIGNED_BYTE, this.uploadCanvas)
      done?.delete(i)
      sent++
    }
    this.renderer.resetState()
    return sent
  }

  /**
   * Push painted cells to the GPU, a fixed number per frame. Re-uploading the whole
   * atlas (tens of MB) was the hitch whenever many cells changed at once.
   */
  private pumpUploads(): void {
    if (this.forceFullAtlas) {
      this.atlasTex.needsUpdate = true
      this.atlasDirty.clear()
      this.forceFullAtlas = false
    }
    if (this.forceFullBlend) {
      this.blendTex.needsUpdate = true
      this.blendDirty.clear()
      this.forceFullBlend = false
    }
    let budget = UPLOADS_PER_FRAME
    // Fade pictures first: the fade clock is waiting on them.
    if (this.blendDirty.size > 0) {
      budget -= this.uploadCells(this.blendTex, this.blendCanvas, [...this.blendDirty], budget, this.blendDirty)
    }
    if (this.atlasDirty.size > 0) {
      this.uploadCells(this.atlasTex, this.atlasCanvas, [...this.atlasDirty], budget, this.atlasDirty)
    }
  }

  /** Upload these atlas cells now, outside the budget (only when a cover is about to be lifted). */
  private uploadNow(cells: number[]): void {
    const pending = cells.filter((i) => this.atlasDirty.has(i))
    if (pending.length > 0) this.uploadCells(this.atlasTex, this.atlasCanvas, pending, pending.length, this.atlasDirty)
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
    const halfW = (0.5 / this.viewCols) * aspect
    const halfH = 0.5 / this.viewRows
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
    this.resizeKlein()
  }

  /** Picture-wrapped Klein bottle, drawn into a texture the display shader uses as the page. */
  private initKlein(): void {
    const vert = /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vNormal = normalize(mat3(modelViewMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `
    const frag = /* glsl */ `
      precision highp float;
      uniform sampler2D uTileFrom;
      uniform sampler2D uTileTo;
      uniform float uTileMix;
      varying vec2 vUv;
      varying vec3 vNormal;
      vec3 blurTile(sampler2D tex, vec2 uv) {
        vec2 s = vec2(2.4 / 256.0);
        vec3 c = texture2D(tex, uv).rgb * 0.250;
        c += texture2D(tex, uv + vec2(s.x, 0.0)).rgb * 0.125;
        c += texture2D(tex, uv - vec2(s.x, 0.0)).rgb * 0.125;
        c += texture2D(tex, uv + vec2(0.0, s.y)).rgb * 0.125;
        c += texture2D(tex, uv - vec2(0.0, s.y)).rgb * 0.125;
        c += texture2D(tex, uv + s).rgb * 0.0625;
        c += texture2D(tex, uv - s).rgb * 0.0625;
        c += texture2D(tex, uv + vec2(s.x, -s.y)).rgb * 0.0625;
        c += texture2D(tex, uv + vec2(-s.x, s.y)).rgb * 0.0625;
        return c;
      }
      void main() {
        // vUv is distance along the surface, in world units. Dividing by the same
        // number on both axes keeps each picture square instead of smearing it
        // down the tube. Smaller divisor = smaller tiles.
        vec2 tuv = vUv / 0.5;
        vec3 c = mix(blurTile(uTileFrom, tuv), blurTile(uTileTo, tuv), uTileMix);
        float shade = abs(dot(normalize(vNormal), normalize(vec3(0.25, 0.65, 0.7))));
        c *= 0.62 + 0.38 * shade;
        gl_FragColor = vec4(c, 1.0);
      }
    `
    this.kleinMaterial = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uTileFrom: { value: this.tileFromTex },
        uTileTo: { value: this.tileToTex },
        uTileMix: { value: 0 },
      },
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
    })
    const built = buildKleinGeometry()
    const mesh = new THREE.Mesh(built.geometry, this.kleinMaterial)
    this.kleinScene = new THREE.Scene()
    this.kleinScene.add(mesh)
    this.kleinCamera = new THREE.PerspectiveCamera(112, 1, 0.05, 80)
    this.kleinCamera.position.set(0, 0, 0)
    this.kleinCamera.lookAt(built.aim)
    this.kleinCamera.updateMatrixWorld()
    this.camForward.set(0, 0, -1).applyQuaternion(this.kleinCamera.quaternion)
    this.camUp.set(0, 1, 0).applyQuaternion(this.kleinCamera.quaternion)
    this.camRight.set(1, 0, 0).applyQuaternion(this.kleinCamera.quaternion)
    this.kleinRT = new THREE.WebGLRenderTarget(1, 1)
    this.kleinRT.texture.colorSpace = THREE.SRGBColorSpace
    this.kleinSampleRT = new THREE.WebGLRenderTarget(1, 1)
    this.kleinSampleRT.texture.colorSpace = THREE.SRGBColorSpace
    this.kleinBlurMaterial = new THREE.ShaderMaterial({
      vertexShader: displayVert,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uSample;
        uniform float uWeight;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(uSample, vUv) * uWeight;
        }
      `,
      uniforms: {
        uSample: { value: this.kleinSampleRT.texture },
        uWeight: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
    })
    this.kleinBlurScene = new THREE.Scene()
    this.kleinBlurScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.kleinBlurMaterial))
    this.material.uniforms.uKlein.value = this.kleinRT.texture
    this.resizeKlein()
  }

  private resizeKlein(): void {
    const pr = this.renderer.getPixelRatio()
    // The bottle is blurred and blended, so half the drawing-buffer size is enough.
    const w = Math.max(1, Math.floor(this.cssW * pr * 0.5))
    const h = Math.max(1, Math.floor(this.cssH * pr * 0.5))
    this.kleinRT.setSize(w, h)
    this.kleinSampleRT.setSize(w, h)
    this.kleinCamera.aspect = this.cssW / Math.max(this.cssH, 1)
    this.kleinCamera.updateProjectionMatrix()
  }

  /** Place the bottle at its current pose, or `back` seconds earlier along the spin. */
  private poseKlein(mesh: THREE.Mesh, back: number): void {
    if (back <= 0) {
      mesh.quaternion.copy(this.sphereQuat)
      return
    }
    const wlen = this.spin.length()
    if (wlen < 1e-5) {
      mesh.quaternion.copy(this.sphereQuat)
      return
    }
    this.spinStep.setFromAxisAngle(this.spinAxis.copy(this.spin).multiplyScalar(1 / wlen), -wlen * back)
    mesh.quaternion.copy(this.sphereQuat).premultiply(this.spinStep)
  }

  private renderKlein(): void {
    if (!this.tileOn) return
    const mesh = this.kleinScene.children[0] as THREE.Mesh
    this.kleinMaterial.uniforms.uTileMix.value = this.tileMix

    // A short streak behind the current pose. The newest frame stays most of the
    // picture; a long even stack was smearing the photo into a color wash.
    const speed = this.spin.length()
    const shutter = this.reducedMotion ? 0 : Math.min(0.1, speed * 0.05)
    if (shutter < 0.02) {
      this.poseKlein(mesh, 0)
      this.renderer.setRenderTarget(this.kleinRT)
      this.renderer.setClearColor(0x000000, 0)
      this.renderer.clear()
      this.renderer.render(this.kleinScene, this.kleinCamera)
      this.renderer.setRenderTarget(null)
      return
    }

    // Two poses, newest heaviest. A four-pose stack was most of the cost while
    // the pointer was moving, and the oldest sample was barely in the picture.
    const steps = 2
    const weights = [0.28, 0.72]
    const prevAuto = this.renderer.autoClear
    this.renderer.autoClear = false
    this.renderer.setClearColor(0x000000, 0)

    this.renderer.setRenderTarget(this.kleinRT)
    this.renderer.clear()
    for (let i = 0; i < steps; i++) {
      const along = i / (steps - 1)
      this.poseKlein(mesh, (1 - along) * shutter)
      this.renderer.setRenderTarget(this.kleinSampleRT)
      this.renderer.clear()
      this.renderer.render(this.kleinScene, this.kleinCamera)
      this.kleinBlurMaterial.uniforms.uWeight.value = weights[i]
      this.renderer.setRenderTarget(this.kleinRT)
      this.renderer.render(this.kleinBlurScene, this.camera)
    }
    this.poseKlein(mesh, 0)
    this.renderer.autoClear = prevAuto
    this.renderer.setRenderTarget(null)
  }

  /**
   * The pointer has come to rest. In one move: glide the grid so the cell under the
   * aperture ends up centred on it, and cross-fade every still-visible cell to the new
   * set. Both run on the same slow eased clock. Nothing is in motion before this.
   */
  beginSettle(_panX: number, _panY: number): void {
    if (this.reducedMotion || !this.atmosphereEnabled) {
      this.commitFade()
      const hover = this.hoveredCell()
      this.syncFavicon(hover.index)
      this.paintAll(this.target)
      return
    }
    this.commitFade() // finish any fade still running (instantly)
    // The new fade takes over the flags, so the last one's cells must be in the atlas now.
    if (this.committing) {
      this.uploadNow(this.committing)
      this.committing = null
      this.material.uniforms.uMix.value = 0
      this.setFadeFlags([])
    }

    const hx = 0.5 / Math.max(this.viewCols, 1)
    const hy = 0.5 / Math.max(this.viewRows, 1)
    // Centre the cell already under the aperture, so the glide cannot slide a different
    // picture into the cursor.
    const hover = this.hoveredCell()
    this.syncFavicon(hover.index)
    this.panAnim = {
      fx: this.focusPan.x,
      fy: this.focusPan.y,
      tx: Math.max(-hx, Math.min(hx, hover.centerX - this.pointer.x)),
      ty: Math.max(-hy, Math.min(hy, hover.centerY - (1 - this.pointer.y))),
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
      // Only photos fade in. One that isn't decoded yet swaps in later, once hidden.
      if (!this.paintCell(i, want, this.blendCanvas, false)) continue
      cells.push(i)
      items.push(want)
    }
    if (cells.length > 0) {
      this.setFadeFlags(cells)
      this.fading = { cells, items, set: new Set(cells), t: 0, armed: false }
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

  /** The picture you just landed on becomes the tab icon. */
  private syncFavicon(index: number): void {
    if (!this.shown[index] || !this.sharp[index]) return
    const px = this.cellPx
    const cols = this.atlasCols
    const scratch = this.uploadCanvas
    const ctx = scratch.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.drawImage(this.atlasCanvas, (index % cols) * px, Math.floor(index / cols) * px, px, px, 0, 0, px, px)
    setFavicon(scratch)
  }

  /** Copy the fitted name into the mask the reveal punches through. */
  setNamePlate(source: HTMLCanvasElement): void {
    const w = Math.max(1, source.width)
    const h = Math.max(1, source.height)
    const resized = this.namePlateCanvas.width !== w || this.namePlateCanvas.height !== h
    // Assigning width clears the bitmap. A size change also has to throw away the
    // GPU texture, or the old glyphs stay in the texels the new image no longer covers.
    this.namePlateCanvas.width = w
    this.namePlateCanvas.height = h
    const ctx = this.namePlateCanvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(source, 0, 0, w, h)
    if (resized) {
      this.namePlateTex.dispose()
      this.namePlateTex = new THREE.CanvasTexture(this.namePlateCanvas)
      this.namePlateTex.colorSpace = THREE.NoColorSpace
      this.namePlateTex.flipY = true
      this.namePlateTex.generateMipmaps = false
      this.namePlateTex.minFilter = THREE.LinearFilter
      this.namePlateTex.magFilter = THREE.LinearFilter
      this.namePlateTex.wrapS = THREE.ClampToEdgeWrapping
      this.namePlateTex.wrapT = THREE.ClampToEdgeWrapping
      this.material.uniforms.uNamePlate.value = this.namePlateTex
    }
    this.namePlateTex.needsUpdate = true
    this.namePlateReady = true
    this.measureNameSpan()
  }

  /** Vertical extent of the glyphs, in screen UV, bottom then top. */
  private measureNameSpan(): void {
    const canvas = this.namePlateCanvas
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx || canvas.width < 1 || canvas.height < 1) return
    const w = canvas.width
    const h = canvas.height
    const data = ctx.getImageData(0, 0, w, h).data
    let top = h
    let bot = -1
    const step = 4
    for (let y = 0; y < h; y += step) {
      const row = y * w
      for (let x = 0; x < w; x += step) {
        if (data[(row + x) * 4 + 3] < 16) continue
        if (y < top) top = y
        if (y > bot) bot = y
      }
    }
    if (bot < 0) return
    this.nameSpan.set(1 - (bot + step) / h, 1 - top / h)
  }

  /**
   * The most vivid color of the hue that actually covers area in the photo.
   * One stray pixel does not pick the hue, and duller pixels of that hue are
   * left out. A picture with no real color falls back to the mean.
   */
  private photoPopColor(img: CanvasImageSource, pop: THREE.Color, avg: THREE.Color): void {
    const s = 32
    const bins = 18
    const canvas = this.nameSampleCanvas
    canvas.width = s
    canvas.height = s
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.drawImage(img, 0, 0, s, s)
    const data = ctx.getImageData(0, 0, s, s).data
    const sumW = new Float64Array(bins)
    const maxW = new Float64Array(bins)
    let meanR = 0
    let meanG = 0
    let meanB = 0
    const n = data.length / 4
    for (let i = 0; i < data.length; i += 4) {
      const rf = data[i] / 255
      const gf = data[i + 1] / 255
      const bf = data[i + 2] / 255
      meanR += rf
      meanG += gf
      meanB += bf
      const max = Math.max(rf, gf, bf)
      const min = Math.min(rf, gf, bf)
      const chroma = max - min
      if (chroma < 0.12 || max < 0.18) continue
      let hue = 0
      if (max === rf) hue = (gf - bf) / chroma
      else if (max === gf) hue = (bf - rf) / chroma + 2
      else hue = (rf - gf) / chroma + 4
      if (hue < 0) hue += 6
      const bin = Math.min(bins - 1, Math.floor((hue / 6) * bins))
      const weight = chroma * (1 - min) * max
      sumW[bin] += weight
      if (weight > maxW[bin]) maxW[bin] = weight
    }
    let best = 0
    let bestScore = -1
    for (let i = 0; i < bins; i++) {
      const prev = sumW[(i + bins - 1) % bins]
      const next = sumW[(i + 1) % bins]
      const score = sumW[i] + (prev + next) * 0.35
      if (score > bestScore) {
        bestScore = score
        best = i
      }
    }
    const toLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
    const mean = [toLinear(meanR / n), toLinear(meanG / n), toLinear(meanB / n)] as const
    avg.setRGB(mean[0], mean[1], mean[2])
    if (sumW[best] < 0.05) {
      pop.copy(avg)
      return
    }
    const floor = maxW[best] * 0.72
    let r = 0
    let g = 0
    let b = 0
    let w = 0
    for (let i = 0; i < data.length; i += 4) {
      const rf = data[i] / 255
      const gf = data[i + 1] / 255
      const bf = data[i + 2] / 255
      const max = Math.max(rf, gf, bf)
      const min = Math.min(rf, gf, bf)
      const chroma = max - min
      if (chroma < 0.12 || max < 0.18) continue
      let hue = 0
      if (max === rf) hue = (gf - bf) / chroma
      else if (max === gf) hue = (bf - rf) / chroma + 2
      else hue = (rf - gf) / chroma + 4
      if (hue < 0) hue += 6
      const bin = Math.min(bins - 1, Math.floor((hue / 6) * bins))
      if (bin !== best) continue
      const weight = chroma * (1 - min) * max
      if (weight < floor) continue
      r += rf * weight
      g += gf * weight
      b += bf * weight
      w += weight
    }
    pop.setRGB(toLinear(r / w), toLinear(g / w), toLinear(b / w))
  }

  private updateNameColor(): void {
    const u = this.material.uniforms
    this.nameAvg.lerpColors(this.nameAvgFrom, this.nameAvgTo, this.tileMix)
    this.namePop.lerpColors(this.namePopFrom, this.namePopTo, this.tileMix)
    ;(u.uNameAvg.value as THREE.Color).copy(this.nameAvg)
    ;(u.uNamePop.value as THREE.Color).copy(this.namePop)
  }

  /** Partial-cell margin on each side of the centred view, in cells. */
  private get viewOffset(): { x: number; y: number } {
    return { x: (this.cols - this.viewCols) * 0.5, y: (this.rows - this.viewRows) * 0.5 }
  }

  /**
   * A screen point (0..1, y down) in atlas cell units (x right, y down, pad included).
   * floor() of the result is the atlas cell under that point.
   */
  screenToCell(x: number, y: number): { cx: number; cy: number } {
    const off = this.viewOffset
    return { cx: this.pad + off.x + x * this.viewCols, cy: this.pad + off.y + y * this.viewRows }
  }

  /** Atlas cell currently framed by the aperture, and its centre on screen (y up). */
  private hoveredCell(): { index: number; sx: number; sy: number; centerX: number; centerY: number } {
    const off = this.viewOffset
    const col = Math.min(
      this.cols - 1,
      Math.max(0, Math.floor(off.x + (this.pointer.x + this.focusPan.x) * this.viewCols)),
    )
    // Counted from the bottom, like the shader's screen uv.
    const row = Math.min(
      this.rows - 1,
      Math.max(0, Math.floor(off.y + (1 - this.pointer.y + this.focusPan.y) * this.viewRows)),
    )
    const atlasCol = this.pad + col
    const atlasRow = this.atlasRows - this.pad - row - 1
    return {
      index: atlasRow * this.atlasCols + atlasCol,
      sx: atlasCol * this.cellPx,
      sy: atlasRow * this.cellPx,
      centerX: (col + 0.5 - off.x) / this.viewCols,
      centerY: (row + 0.5 - off.y) / this.viewRows,
    }
  }

  /** Copy the picture under the aperture onto the bottle before that cell fades to the next one. */
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

    this.nameAvgFrom.copy(this.nameAvg)
    this.namePopFrom.copy(this.namePop)
    this.photoPopColor(this.tileToCanvas, this.namePopTo, this.nameAvgTo)

    this.tileOn = true
    this.tileMix = 0
    this.tileFade = 0
  }

  /**
   * Make the fade final: faded cells take their new picture in the atlas itself.
   * The blend keeps covering them at full strength until those cells have been
   * uploaded, so the swap underneath is never seen.
   */
  private commitFade(): void {
    const f = this.fading
    if (!f) return
    const painted: number[] = []
    for (let k = 0; k < f.cells.length; k++) {
      if (this.paintCell(f.cells[k], f.items[k], this.atlasCanvas, false)) {
        this.shown[f.cells[k]] = f.items[k]
        painted.push(f.cells[k])
      }
    }
    this.fading = null
    this.fadeSpeed = 1
    if (!f.armed) {
      // The incoming pictures never reached the GPU, so the blend has nothing to cover with.
      this.blendDirty.clear()
      this.material.uniforms.uMix.value = 0
      this.setFadeFlags([])
      return
    }
    this.material.uniforms.uMix.value = 1
    this.committing = painted
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

  /** How many square cells the screen spans. Changes on every resize; cheap. */
  setView(viewCols: number, viewRows: number): void {
    this.viewCols = Math.min(this.cols, viewCols)
    this.viewRows = Math.min(this.rows, viewRows)
    this.material.uniforms.uView.value.set(this.viewCols, this.viewRows)
    this.syncLensToCell()
  }

  setGrid(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.viewCols = Math.min(cols, this.viewCols)
    this.viewRows = Math.min(rows, this.viewRows)
    this.material.uniforms.uView.value.set(this.viewCols, this.viewRows)
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
    this.forceFullAtlas = true
    this.forceFullBlend = true
    this.atlasDirty.clear()
    this.blendDirty.clear()
    this.fading = null
    this.committing = null
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
    this.sharp.fill(0)
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item && this.paintCell(i, item)) this.shown[i] = item
    }
    this.forceFullAtlas = true
  }

  /**
   * Tell the engine what each atlas cell should show. Items are already chosen
   * from what has downloaded (or are waiting on, as a preview).
   *  animate=false → paint it all immediately (nothing has been seen yet).
   *  animate=true  → only record it; cells adopt it while hidden by the white,
   *                  or through the live shuffle on the open page.
   */
  setAssignment(items: ManifestItem[], animate: boolean): void {
    const same =
      this.lastAssign.length === items.length &&
      this.lastAssign.every((it, i) => it?.id === items[i]?.id)
    if (same) return

    this.lastAssign = items.slice()
    this.target = items.slice()

    const immediate =
      !animate || this.reducedMotion || this.instantSwap || !this.atmosphereEnabled || this.shown.length === 0
    if (immediate) this.paintAll(items)
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

  /**
   * Pointer motion sets a wish spin. The actual spin turns toward it at a limited
   * rate, so a reversal keeps rolling and arcs past instead of stopping. Mouse
   * movement never rolls the picture in the plane of the screen. A separate pull
   * bends the heading back toward the upright pose without braking the roll.
   * Once the pointer stops, speed eases out.
   */
  private steerSpin(dt: number): void {
    if (this.spherePrev) {
      const dx = this.pointer.x - this.spherePrev.x
      const dy = this.pointer.y - this.spherePrev.y
      const dtSafe = Math.max(dt, 1 / 120)
      const px = dx / dtSafe
      const py = dy / dtSafe
      // Against the pointer. Around camera-up and camera-right only, so a stroke
      // pans and pitches the tunnel and leaves the horizon alone.
      this.wish.copy(this.camUp).multiplyScalar(px * -0.9)
      this.wish.addScaledVector(this.camRight, py * -0.6)
      const wishLen = this.wish.length()
      const wishSpeed = Math.min(1.35, wishLen)
      const speed = this.spin.length()
      if (wishSpeed > 0.08 && speed < 0.02) {
        this.spin.copy(this.wish).multiplyScalar(wishSpeed / wishLen)
      } else if (wishSpeed > 0.08) {
        this.spinDir.copy(this.spin).multiplyScalar(1 / speed)
        this.wishDir.copy(this.wish).multiplyScalar(1 / wishLen)
        this.spinAxis.crossVectors(this.spinDir, this.wishDir)
        const sin = this.spinAxis.length()
        const cos = this.spinDir.dot(this.wishDir)
        if (sin < 1e-4) {
          if (cos < 0) {
            this.spinAxis.crossVectors(this.spinDir, this.camForward)
            if (this.spinAxis.lengthSq() < 1e-6) this.spinAxis.crossVectors(this.spinDir, this.camUp)
            this.spinAxis.normalize()
            this.spinDir.applyAxisAngle(this.spinAxis, Math.min(Math.PI, 2.1 * dt))
          }
        } else {
          const ang = Math.atan2(sin, cos)
          this.spinAxis.multiplyScalar(1 / sin)
          this.spinDir.applyAxisAngle(this.spinAxis, Math.min(ang, 2.1 * dt))
        }
        const aligned = this.spinDir.dot(this.wishDir)
        const next =
          aligned > 0.35
            ? speed + (wishSpeed - speed) * (1 - Math.exp(-dt / 0.55))
            : speed * Math.exp(-dt / 4)
        this.spin.copy(this.spinDir).multiplyScalar(Math.min(1.45, next))
      } else {
        this.spin.multiplyScalar(Math.exp(-dt / 3.2))
      }
    }
    this.spherePrev = { x: this.pointer.x, y: this.pointer.y }
    this.curveUpright(dt)

    const wlen = Math.min(1.45, this.spin.length())
    if (wlen < this.spin.length()) this.spin.multiplyScalar(wlen / this.spin.length())
    if (wlen > 1e-4) {
      this.spinStep.setFromAxisAngle(this.spinAxis.copy(this.spin).multiplyScalar(1 / wlen), wlen * dt)
      this.sphereQuat.premultiply(this.spinStep).normalize()
    }
  }

  /** Steer the heading toward the pose where the photos in view stand up. */
  private curveUpright(dt: number): void {
    const q = this.sphereQuat
    const sinHalf = Math.hypot(q.x, q.y, q.z)
    if (sinHalf < 1e-4) return
    const angle = 2 * Math.atan2(sinHalf, q.w)
    this.restore.set(q.x, q.y, q.z).multiplyScalar((-angle * 2 * dt) / sinHalf)
    const speed = this.spin.length()
    if (speed > 0.2) {
      this.spinDir.copy(this.spin).multiplyScalar(1 / speed)
      const along = this.restore.dot(this.spinDir)
      if (along < 0) this.restore.addScaledVector(this.spinDir, -along)
    }
    this.spin.add(this.restore)
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
    if (this.fading && !this.fading.armed && this.blendDirty.size === 0) this.fading.armed = true
    if (this.fading?.armed) {
      this.fading.t = Math.min(1, this.fading.t + (dt * this.fadeSpeed) / this.settleDuration)
      const t = this.fading.t
      u.uMix.value = t * t * (3 - 2 * t)
      if (t >= 1) this.commitFade()
    }

    this.steerSpin(dt)

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
    u.uStage.value = this.stage === 'grid' ? 1 : 0
    u.uBlendMode.value = this.blend
    u.uCustom.value = this.customBlend ? 1 : 0
    // Pierce opens quickly as soon as the pointer moves. The blend eases back over
    // the disc on the same clock as the settle, and only after the pointer is idle.
    if (this.pointerIdle) this.discCover = Math.min(1, this.discCover + dt / this.settleDuration)
    else this.discCover = Math.max(0, this.discCover - dt / 0.18)
    u.uDiscCover.value = this.discCover
    const speed = Math.hypot(this.velocity.x, this.velocity.y)
    const focusTarget = Math.min(1, speed / 0.035)
    const focusTau = focusTarget > this.focusBleed ? 0.05 : 0.35
    this.focusBleed += (focusTarget - this.focusBleed) * (1 - Math.exp(-dt / focusTau))
    u.uFocus.value = this.focusBleed
    u.uNameOn.value = this.showNamePlate && this.namePlateReady ? 1 : 0
    this.updateNameColor()
    u.uEnabled.value = this.atmosphereEnabled && !this.reducedMotion ? 1 : 0

    this.renderKlein()
    this.renderer.setRenderTarget(null)
    this.renderer.setClearColor(WHITE, 1)
    this.renderer.clear()
    this.renderer.render(this.scene, this.camera)

    // The open page shuffles in place while the pointer moves, without the
    // visibility readback. At rest it holds still; arrivals only fill and sharpen.
    if (this.liveShuffle && !this.pointerIdle) this.shuffleLiveGrid()

    // Hidden-cell swaps on the white page. The readback stalls the GPU, so it
    // stays off the stroke itself and only runs once the pointer has settled.
    this.frameNo++
    if (!this.liveShuffle && this.pointerIdle && this.frameNo % 10 === 0) {
      this.updateVisibility()
      this.applyHiddenSwaps()
    }
    this.fillPending()
    this.pumpUploads()
    if (this.committing && !this.committing.some((i) => this.atlasDirty.has(i))) {
      this.committing = null
      this.material.uniforms.uMix.value = 0
      this.setFadeFlags([])
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
    this.namePlateTex.dispose()
    this.kleinRT.dispose()
    this.kleinSampleRT.dispose()
    this.kleinBlurMaterial.dispose()
    this.kleinMaterial.dispose()
    this.fadeFlagTex.dispose()
    this.visRT.dispose()
    this.visMaterial.dispose()
    this.material.dispose()
    this.renderer.dispose()
  }
}
