import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import './IdentityOverlay.css'

export type IdentityLink = { label: string; href: string }

export type IdentityOverlayProps = {
  open: boolean
  onClose: () => void
  name: string
  links: IdentityLink[]
}

/** Letter-spacing of the name, in em (negative = tight). Keep in sync with the CSS. */
const TRACKING_EM = -0.04
/** Below this size the one-line name is too small, so the first and last name stack. */
const NAME_MIN_PX = 72

function setNameLines(el: SVGTextElement, lines: string[]) {
  el.textContent = ''
  for (const line of lines) {
    const span = document.createElementNS('http://www.w3.org/2000/svg', 'tspan')
    span.textContent = line
    el.appendChild(span)
  }
}

/** Font size that makes `line` fill `avail` px. Mutates the text to a single line while measuring. */
function fitNameLine(el: SVGTextElement, line: string, avail: number): number {
  setNameLines(el, [line])
  let size = 100
  for (let i = 0; i < 3; i++) {
    el.style.fontSize = `${size}px`
    const span = el.firstElementChild as SVGTextContentElement | null
    const w = (span?.getComputedTextLength() ?? 0) - TRACKING_EM * size
    if (w <= 0) break
    size = (size * avail) / w
  }
  return size
}
/** Link type, in rem; row height and gap match the old HTML list. */
const LINK_SIZE_REM = 0.9
const LINK_LINE = 1.2
const LINK_GAP_REM = 0.55

/**
 * The dark veil, drawn as SVG so the name AND the links can be true holes in it: the
 * live canvas underneath (white page + halo + fluid colour) shows through the letters,
 * while the rest of the veil stays nearly opaque and lets only a trace of the aperture
 * through. A link turns solid white while hovered or focused.
 *
 * The name is always one unbroken line spanning the full content width. Font size is
 * solved from the real rendered width of the text, re-measured on resize and once web
 * fonts have loaded, so it never wraps and never overflows.
 *
 * The links are real <a> elements (clickable, focusable) laid transparently over the
 * SVG text; their boxes are measured from that text.
 */
function Veil({
  name,
  links,
  apertureRef,
}: {
  name: string
  links: IdentityLink[]
  apertureRef: RefObject<{ x: number; y: number; r: number; cx: number; cy: number }>
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const maskRectRef = useRef<SVGRectElement>(null)
  const veilRectRef = useRef<SVGRectElement>(null)
  const nameRef = useRef<SVGTextElement>(null)
  const nameWhiteRef = useRef<SVGTextElement>(null)
  const spotRef = useRef<SVGCircleElement>(null)
  const cursorHoleRef = useRef<SVGCircleElement>(null)
  const holeLinkRefs = useRef<(SVGTextElement | null)[]>([])
  const whiteLinkRefs = useRef<(SVGTextElement | null)[]>([])
  const anchorRefs = useRef<(HTMLAnchorElement | null)[]>([])
  const [active, setActive] = useState<number | null>(null)

  useLayoutEffect(() => {
    const svg = svgRef.current
    const nameText = nameRef.current
    const nameWhite = nameWhiteRef.current
    const maskRect = maskRectRef.current
    const veilRect = veilRectRef.current
    const host = svg?.parentElement
    if (!svg || !nameText || !nameWhite || !maskRect || !veilRect || !host) return

    const fit = () => {
      const cs = getComputedStyle(host)
      const W = host.clientWidth
      const H = host.clientHeight
      const padL = parseFloat(cs.paddingLeft) || 0
      const padR = parseFloat(cs.paddingRight) || 0
      const padT = parseFloat(cs.paddingTop) || 0
      const padB = parseFloat(cs.paddingBottom) || 0
      const avail = W - padL - padR
      if (avail <= 0 || H <= 0) return

      svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
      for (const r of [maskRect, veilRect]) {
        r.setAttribute('width', String(W))
        r.setAttribute('height', String(H))
      }

      // One line across the width. If that would be smaller than NAME_MIN_PX and the
      // name has two parts, stack the first name over the rest so it can stay large.
      const full = name.toUpperCase()
      const parts = name.trim().split(/\s+/).filter(Boolean)
      let lines = [full]
      let size = fitNameLine(nameText, full, avail)
      if (parts.length >= 2 && size < NAME_MIN_PX) {
        lines = [parts[0].toUpperCase(), parts.slice(1).join(' ').toUpperCase()]
        size = Math.min(fitNameLine(nameText, lines[0], avail), fitNameLine(nameText, lines[1], avail))
      }
      const base = H - padB
      const lineGap = size * 0.82
      for (const el of [nameText, nameWhite]) {
        setNameLines(el, lines)
        el.style.fontSize = `${size}px`
        el.removeAttribute('x')
        el.removeAttribute('y')
        const spans = el.querySelectorAll('tspan')
        spans.forEach((span, i) => {
          span.setAttribute('x', String(padL))
          span.setAttribute('y', String(lines.length === 1 ? base : base - (lines.length - 1 - i) * lineGap))
        })
      }

      // ---- links: right-aligned column at the top right
      const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      const fs = root * LINK_SIZE_REM
      const lh = fs * LINK_LINE
      const gap = root * LINK_GAP_REM
      const right = W - padR
      links.forEach((_, i) => {
        const top = padT + i * (lh + gap)
        const baseline = top + lh / 2 + fs * 0.35
        const hole = holeLinkRefs.current[i]
        const white = whiteLinkRefs.current[i]
        const a = anchorRefs.current[i]
        if (!hole || !white || !a) return
        for (const t of [hole, white]) {
          t.style.fontSize = `${fs}px`
          t.setAttribute('x', String(right))
          t.setAttribute('y', String(baseline))
        }
        const w = hole.getComputedTextLength()
        a.style.left = `${right - w}px`
        a.style.top = `${top}px`
        a.style.width = `${w}px`
        a.style.height = `${lh}px`
      })
    }

    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(host)
    let alive = true
    void document.fonts?.ready.then(() => {
      if (alive) fit()
    })
    return () => {
      alive = false
      ro.disconnect()
    }
  }, [name, links])

  useEffect(() => {
    const circle = spotRef.current
    const hole = cursorHoleRef.current
    const svg = svgRef.current
    if (!circle || !hole || !svg) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const { x, y, r, cx, cy } = apertureRef.current
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const inv = ctm.inverse()
      const toLocal = (px: number, py: number) => {
        const p = svg.createSVGPoint()
        p.x = px
        p.y = py
        return p.matrixTransform(inv)
      }
      const pa = toLocal(x, y)
      const pb = toLocal(x, y + r)
      circle.setAttribute('cx', String(pa.x))
      circle.setAttribute('cy', String(pa.y))
      circle.setAttribute('r', String(Math.hypot(pb.x - pa.x, pb.y - pa.y)))
      const ca = toLocal(cx, cy)
      const cb = toLocal(cx, cy + 5)
      hole.setAttribute('cx', String(ca.x))
      hole.setAttribute('cy', String(ca.y))
      hole.setAttribute('r', String(Math.hypot(cb.x - ca.x, cb.y - ca.y)))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [apertureRef])

  // Bold glyphs are wider. Resize the hit area to the hole text after the weight flips.
  useLayoutEffect(() => {
    holeLinkRefs.current.forEach((hole, i) => {
      const a = anchorRefs.current[i]
      if (!hole || !a) return
      const right = parseFloat(hole.getAttribute('x') || '0')
      const w = hole.getComputedTextLength()
      a.style.left = `${right - w}px`
      a.style.width = `${w}px`
    })
  }, [active])

  return (
    <>
      <svg ref={svgRef} className="identity__veil" aria-hidden="true">
        <defs>
          <mask id="identity-hole" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
            <rect ref={maskRectRef} x="0" y="0" fill="#fff" />
            <text ref={nameRef} className="identity__hole-text" fill="#000">
              {name.toUpperCase()}
            </text>
            {links.map((l, i) => (
              <text
                key={l.href}
                ref={(el) => {
                  holeLinkRefs.current[i] = el
                }}
                className={`identity__link-text${active === i ? ' is-on' : ''}`}
                fill="#000"
              >
                {l.label}
              </text>
            ))}
            <circle ref={cursorHoleRef} cx="-1000" cy="-1000" r="5" fill="#000" />
          </mask>
          <mask id="identity-name-spot" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
            <rect x="0" y="0" width="100%" height="100%" fill="#000" />
            <circle ref={spotRef} cx="-1000" cy="-1000" r="0" fill="#fff" />
          </mask>
        </defs>
        <rect ref={veilRectRef} className="identity__veil-fill" x="0" y="0" mask="url(#identity-hole)" />
        <text ref={nameWhiteRef} className="identity__hole-text identity__name-white" mask="url(#identity-name-spot)">
          {name.toUpperCase()}
        </text>
        {links.map((l, i) => (
          <text
            key={l.href}
            ref={(el) => {
              whiteLinkRefs.current[i] = el
            }}
            className={`identity__link-text identity__link-white${active === i ? ' is-on' : ''}`}
          >
            {l.label}
          </text>
        ))}
      </svg>
      <h1 className="identity__name">{name}</h1>
      <nav className="identity__links" aria-label="Links">
        {links.map((l, i) => (
          <a
            key={l.href}
            ref={(el) => {
              anchorRefs.current[i] = el
            }}
            href={l.href}
            target="_blank"
            rel="noreferrer noopener"
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive((a) => (a === i ? null : a))}
            onFocus={() => setActive(i)}
            onBlur={() => setActive((a) => (a === i ? null : a))}
          >
            {l.label}
          </a>
        ))}
      </nav>
    </>
  )
}

export function IdentityOverlay({
  open,
  onClose,
  name,
  links,
  apertureRef,
}: IdentityOverlayProps & {
  apertureRef: RefObject<{ x: number; y: number; r: number; cx: number; cy: number }>
}) {
  if (!open) return null

  return (
    <div
      className="identity"
      role="dialog"
      aria-modal="true"
      aria-label="Identity"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <Veil name={name} links={links} apertureRef={apertureRef} />
    </div>
  )
}

/** Black name under the white page, fitted the same way as the popover title. */
export function PageName({
  name,
  onPlate,
}: {
  name: string
  onPlate: (plate: HTMLCanvasElement) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const nameRef = useRef<SVGTextElement>(null)
  const onPlateRef = useRef(onPlate)
  onPlateRef.current = onPlate

  useLayoutEffect(() => {
    const host = hostRef.current
    const svg = svgRef.current
    const nameText = nameRef.current
    if (!host || !svg || !nameText) return

    const fit = () => {
      const cs = getComputedStyle(host)
      const W = host.clientWidth
      const H = host.clientHeight
      const padL = parseFloat(cs.paddingLeft) || 0
      const padR = parseFloat(cs.paddingRight) || 0
      const padB = parseFloat(cs.paddingBottom) || 0
      const avail = W - padL - padR
      if (avail <= 0 || H <= 0) return

      svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
      const full = name.toUpperCase()
      const parts = name.trim().split(/\s+/).filter(Boolean)
      let lines = [full]
      let size = fitNameLine(nameText, full, avail)
      if (parts.length >= 2 && size < NAME_MIN_PX) {
        lines = [parts[0].toUpperCase(), parts.slice(1).join(' ').toUpperCase()]
        size = Math.min(fitNameLine(nameText, lines[0], avail), fitNameLine(nameText, lines[1], avail))
      }
      const base = H - padB
      const lineGap = size * 0.82
      setNameLines(nameText, lines)
      nameText.style.fontSize = `${size}px`
      nameText.removeAttribute('x')
      nameText.removeAttribute('y')
      const spans = [...nameText.querySelectorAll('tspan')]
      spans.forEach((span, i) => {
        span.setAttribute('x', String(padL))
        span.setAttribute('y', String(lines.length === 1 ? base : base - (lines.length - 1 - i) * lineGap))
      })

      const plate = document.createElement('canvas')
      const scale = Math.min(Math.max(window.devicePixelRatio || 1, 2), 3)
      plate.width = Math.max(1, Math.floor(W * scale))
      plate.height = Math.max(1, Math.floor(H * scale))
      const ctx = plate.getContext('2d')
      if (!ctx) return
      const font = getComputedStyle(nameText)
      ctx.clearRect(0, 0, plate.width, plate.height)
      ctx.scale(scale, scale)
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#fff'
      ctx.font = `800 ${size}px ${font.fontFamily}`
      ctx.letterSpacing = font.letterSpacing
      ctx.textBaseline = 'alphabetic'
      for (const span of spans) {
        ctx.fillText(
          span.textContent ?? '',
          parseFloat(span.getAttribute('x') || '0'),
          parseFloat(span.getAttribute('y') || '0'),
        )
      }
      onPlateRef.current(plate)
    }

    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(host)
    let alive = true
    void document.fonts?.load('800 16px Syne').then(() => {
      if (alive) fit()
    })
    return () => {
      alive = false
      ro.disconnect()
    }
  }, [name])

  return (
    <div ref={hostRef} className="page-name" aria-hidden="true">
      <svg ref={svgRef}>
        <text ref={nameRef} className="identity__hole-text" fill="#000">
          {name.toUpperCase()}
        </text>
      </svg>
    </div>
  )
}
