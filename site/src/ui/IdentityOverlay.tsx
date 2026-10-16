import { useLayoutEffect, useRef, useState } from 'react'
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
function Veil({ name, links }: { name: string; links: IdentityLink[] }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const maskRectRef = useRef<SVGRectElement>(null)
  const veilRectRef = useRef<SVGRectElement>(null)
  const nameRef = useRef<SVGTextElement>(null)
  const holeLinkRefs = useRef<(SVGTextElement | null)[]>([])
  const whiteLinkRefs = useRef<(SVGTextElement | null)[]>([])
  const anchorRefs = useRef<(HTMLAnchorElement | null)[]>([])
  const [active, setActive] = useState<number | null>(null)

  useLayoutEffect(() => {
    const svg = svgRef.current
    const nameText = nameRef.current
    const maskRect = maskRectRef.current
    const veilRect = veilRectRef.current
    const host = svg?.parentElement
    if (!svg || !nameText || !maskRect || !veilRect || !host) return

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

      // ---- name: glyph advances are not perfectly linear in font size, so refine a few
      // times. Negative tracking pulls the last glyph's ink past the measured advance by
      // |TRACKING_EM| em, so that is added back to the measured width.
      let size = 100
      for (let i = 0; i < 3; i++) {
        nameText.style.fontSize = `${size}px`
        const w = nameText.getComputedTextLength() - TRACKING_EM * size
        if (w <= 0) break
        size = (size * avail) / w
      }
      nameText.style.fontSize = `${size}px`
      nameText.setAttribute('x', String(padL))
      nameText.setAttribute('y', String(H - padB))

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
                className="identity__link-text"
                fill="#000"
              >
                {l.label}
              </text>
            ))}
          </mask>
        </defs>
        <rect ref={veilRectRef} className="identity__veil-fill" x="0" y="0" mask="url(#identity-hole)" />
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

export function IdentityOverlay({ open, onClose, name, links }: IdentityOverlayProps) {
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
      <Veil name={name} links={links} />
    </div>
  )
}
