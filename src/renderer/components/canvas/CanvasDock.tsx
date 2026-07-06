import { useEffect, useMemo } from 'react'
import { motion } from 'framer-motion'
import { useStore, artifactsForSession, type Session } from '../../store'
import { ArtifactRenderer } from './ArtifactRenderer'
import { titleFor, summaryFor } from './summary'

/** Width of the docked canvas in focused view, % of the terminal body. */
export const CANVAS_WIDTH_PCT = 36

interface Props {
  /** The session whose artifacts this dock shows. */
  session: Session
  /** 'docked' = focused-view side panel (absolute, slides in); 'pane' = inline
   *  flex child inside a split-view pane; 'overlay' = maximized body inside
   *  ArtifactOverlay (no positioning, no slide). */
  variant: 'docked' | 'pane' | 'overlay'
  /** For 'docked': shift left to leave room for a pinned attached terminal. */
  rightOffsetPct?: number
  /** Optional expand affordance (renders a ⤢ button when provided). */
  onExpand?: () => void
}

/**
 * Per-session canvas container: header (title, source tag, history selector,
 * close) + the selected artifact. The dock never mounts unless its session has
 * artifacts AND is in openCanvasSessionIds — "invisible unless used".
 */
export function CanvasDock({ session, variant, rightOffsetPct = 0, onExpand }: Props): JSX.Element | null {
  const canvasArtifacts = useStore((s) => s.canvasArtifacts)
  const canvasSelection = useStore((s) => s.canvasSelection)
  const selectCanvasArtifact = useStore((s) => s.selectCanvasArtifact)
  const dismissCanvas = useStore((s) => s.dismissCanvas)
  const markCanvasSeen = useStore((s) => s.markCanvasSeen)

  const artifacts = useMemo(
    () => artifactsForSession(canvasArtifacts, session),
    [canvasArtifacts, session],
  )

  // Selection falls back to the latest artifact when nothing is selected or the
  // selected artifact was pruned from the store.
  const selectedId = canvasSelection[session.id]
  const selected = artifacts.find((a) => a.id === selectedId) ?? artifacts[artifacts.length - 1]
  const index = selected ? artifacts.findIndex((a) => a.id === selected.id) : -1

  // Visible dock = artifacts seen. Covers both entering a session with unseen
  // artifacts and new artifacts arriving while the dock is open.
  useEffect(() => {
    if (artifacts.length > 0) markCanvasSeen(session.id)
  }, [artifacts.length, session.id, markCanvasSeen])

  // All artifacts pruned away → nothing to show; close silently.
  useEffect(() => {
    if (artifacts.length === 0) dismissCanvas(session.id)
  }, [artifacts.length, session.id, dismissCanvas])

  if (!selected) return null

  const step = (delta: number): void => {
    const next = artifacts[index + delta]
    if (next) selectCanvasArtifact(session.id, next.id)
  }

  const body = (
    <>
      <div className="h-8 shrink-0 flex items-center gap-2 px-2.5 border-b border-zinc-800/60">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500 shrink-0">Canvas</span>
        <span className="text-[11px] text-zinc-300 truncate" title={summaryFor(selected)}>
          {titleFor(selected)}
        </span>
        {selected.source === 'user' && (
          <span className="text-[9px] px-1.5 py-px rounded bg-sky-950/60 border border-sky-900 text-sky-300 shrink-0">
            sent by you
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {artifacts.length > 1 && (
            <>
              <button
                onClick={() => step(-1)}
                disabled={index <= 0}
                className="px-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30 disabled:hover:text-zinc-500"
                title="Previous artifact"
              >
                ‹
              </button>
              <span className="text-[10px] text-zinc-600 tabular-nums">
                {index + 1}/{artifacts.length}
              </span>
              <button
                onClick={() => step(1)}
                disabled={index >= artifacts.length - 1}
                className="px-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30 disabled:hover:text-zinc-500"
                title="Next artifact"
              >
                ›
              </button>
            </>
          )}
          {onExpand && (
            <button
              onClick={onExpand}
              className="px-1 text-zinc-500 hover:text-zinc-200"
              title="Expand"
            >
              ⤢
            </button>
          )}
          <button
            onClick={() => dismissCanvas(session.id)}
            className="px-1 text-zinc-500 hover:text-zinc-200"
            title="Close canvas (a new artifact re-opens it)"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto bg-[#0d0d0f]">
        <ArtifactRenderer artifact={selected} />
      </div>
    </>
  )

  if (variant === 'docked') {
    return (
      <motion.div
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        transition={{ type: 'tween', duration: 0.18, ease: 'easeOut' }}
        className="absolute top-0 h-full flex flex-col bg-[#0d0d0f] border-l border-zinc-800/80"
        style={{ width: `${CANVAS_WIDTH_PCT}%`, right: `${rightOffsetPct}%`, zIndex: 20 }}
      >
        {body}
      </motion.div>
    )
  }

  if (variant === 'pane') {
    return (
      <div className="h-full flex flex-col bg-[#0d0d0f] border-l border-zinc-800/80" style={{ width: '45%' }}>
        {body}
      </div>
    )
  }

  // overlay: caller owns positioning/size
  return <div className="h-full w-full flex flex-col bg-[#0d0d0f]">{body}</div>
}
