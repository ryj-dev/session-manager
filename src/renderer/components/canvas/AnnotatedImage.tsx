import { useMemo, useState } from 'react'
import type { CanvasAnnotation, CanvasArtifact } from '../../store'

const DEFAULT_COLOR = '#f43f5e' // rose-500 — high contrast on most screenshots

interface Props {
  /** An 'image' or 'annotated-image' artifact. */
  artifact: Extract<CanvasArtifact, { component: 'image' | 'annotated-image' }>
}

/**
 * Image renderer with an SVG annotation overlay. The image is served via
 * canvas://image/<artifactId> (main-process protocol; path is looked up by
 * artifact id in the canvas store, never taken from the renderer).
 *
 * Annotation coordinates are pixels in the image's NATURAL size. The wrapper
 * div uses `aspect-ratio: natW / natH` and the SVG uses the natural size as
 * its viewBox, so the overlay lands pixel-perfect at any displayed size with
 * no coordinate math.
 */
export function AnnotatedImage({ artifact }: Props): JSX.Element {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const annotations = artifact.component === 'annotated-image' ? artifact.annotations : []
  // Marker ids are document-global in SVG — namespace by artifact id so two
  // docks showing annotated images don't collide.
  const markerId = useMemo(() => `canvas-arrow-${artifact.id}`, [artifact.id])

  if (failed) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6 py-10">
        <span className="text-[13px] text-zinc-400">image unavailable</span>
        <span className="text-[10px] text-zinc-600 font-mono break-all">{artifact.image.originalPath ?? artifact.image.path}</span>
        <span className="text-[10px] text-zinc-600">The file may have been moved or deleted since it was shown.</span>
      </div>
    )
  }

  // Font/stroke sizes are in viewBox (natural-pixel) units; scale them off the
  // image size so they render at a consistent apparent size regardless of the
  // source resolution (a 4K screenshot needs bigger units than a 400px icon).
  const unit = natural ? Math.max(natural.w, natural.h) / 100 : 1
  const strokeW = Math.max(1.5, unit * 0.35)
  const fontSize = Math.max(11, unit * 1.8)

  return (
    <div className="flex items-start justify-center p-3 h-full overflow-auto">
      <div
        className="relative max-w-full"
        style={natural ? { aspectRatio: `${natural.w} / ${natural.h}` } : undefined}
      >
        <img
          src={`canvas://image/${artifact.id}`}
          alt={artifact.image.alt ?? artifact.title ?? 'canvas image'}
          className="max-w-full h-auto rounded border border-zinc-800/60"
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
        />
        {natural && annotations.length > 0 && (
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            viewBox={`0 0 ${natural.w} ${natural.h}`}
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
              </marker>
            </defs>
            {annotations.map((a, i) => (
              <AnnotationShape key={i} a={a} strokeW={strokeW} fontSize={fontSize} markerId={markerId} />
            ))}
          </svg>
        )}
      </div>
    </div>
  )
}

function AnnotationShape({ a, strokeW, fontSize, markerId }: {
  a: CanvasAnnotation
  strokeW: number
  fontSize: number
  markerId: string
}): JSX.Element {
  const color = a.color ?? DEFAULT_COLOR

  const labelAt = (x: number, y: number, text: string): JSX.Element => {
    // Approximate text metrics (SVG has no cheap measure step pre-render);
    // generous padding keeps the backing rect from clipping.
    const w = text.length * fontSize * 0.62 + fontSize
    const h = fontSize * 1.6
    return (
      <g>
        <rect x={x - w / 2} y={y} width={w} height={h} rx={h * 0.2} fill="rgba(9,9,11,0.85)" />
        <text
          x={x}
          y={y + h * 0.7}
          textAnchor="middle"
          fill={color}
          fontSize={fontSize}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          fontWeight={600}
        >
          {text}
        </text>
      </g>
    )
  }

  switch (a.kind) {
    case 'circle':
      return (
        <g>
          <circle cx={a.cx} cy={a.cy} r={a.r} fill="none" stroke={color} strokeWidth={strokeW} />
          {a.label ? labelAt(a.cx, a.cy + a.r + strokeW * 2, a.label) : <></>}
        </g>
      )
    case 'box':
      return (
        <g>
          <rect x={a.x} y={a.y} width={a.w} height={a.h} fill="none" stroke={color} strokeWidth={strokeW} rx={strokeW * 1.5} />
          {a.label ? labelAt(a.x + a.w / 2, a.y + a.h + strokeW * 2, a.label) : <></>}
        </g>
      )
    case 'arrow':
      return (
        <g>
          <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke={color} strokeWidth={strokeW} markerEnd={`url(#${markerId})`} />
          {a.label ? labelAt(a.x1, a.y1 + strokeW * 2, a.label) : <></>}
        </g>
      )
    case 'label':
      return labelAt(a.x, a.y, a.text)
  }
}
