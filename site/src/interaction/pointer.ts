export type PointerState = {
  /** Normalized [0,1] across viewport */
  x: number
  y: number
  /** Smoothed */
  sx: number
  sy: number
  active: boolean
}

export function createPointerState(): PointerState {
  return { x: 0.5, y: 0.5, sx: 0.5, sy: 0.5, active: false }
}

export function updatePointerFromClient(
  state: PointerState,
  clientX: number,
  clientY: number,
  width: number,
  height: number,
): void {
  state.x = width > 0 ? clientX / width : 0.5
  state.y = height > 0 ? clientY / height : 0.5
  state.active = true
}

export function smoothPointer(state: PointerState, alpha = 0.12): void {
  state.sx += (state.x - state.sx) * alpha
  state.sy += (state.y - state.sy) * alpha
}

/** Map device orientation (degrees) into [0,1] pointer field. */
export function pointerFromOrientation(
  state: PointerState,
  beta: number | null,
  gamma: number | null,
): void {
  if (beta == null || gamma == null) return
  // beta: -180..180 (front-back), gamma: -90..90 (left-right)
  const x = clamp01((gamma + 45) / 90)
  const y = clamp01((beta + 20) / 70)
  state.x = x
  state.y = y
  state.active = true
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
