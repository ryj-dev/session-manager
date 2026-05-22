import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { Terminal, focusTerminal } from './Terminal'

interface Props {
  /** The Claude session this overlay is attached to. */
  parentSessionId: string
  /** The hidden shell PTY id rendered inside the overlay. */
  attachedId: string
}

const EDGE_TRIGGER_PX = 18
const COLLAPSE_DELAY_MS = 300
const OVERLAY_WIDTH_PCT = 36
const PINNED_WIDTH_PCT = 28

/**
 * Hover-overlay sidebar that exposes the hidden shell PTY attached to a focused
 * Claude session. Slides in from the right when the cursor approaches the edge;
 * slides back out when the cursor leaves. Can be pinned, in which case it stays
 * open and (via its `pinned` prop being read by the parent) the parent's Claude
 * terminal is rendered side-by-side instead of behind the overlay.
 */
export function AttachedTerminalOverlay({ parentSessionId, attachedId }: Props): JSX.Element {
  const pinnedIds = useStore((s) => s.pinnedAttachedTerminalIds)
  const togglePinned = useStore((s) => s.togglePinnedAttachedTerminal)
  const pinned = pinnedIds.includes(parentSessionId)

  const [hovered, setHovered] = useState(false)
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Edge-trigger detection — runs at the App level so xterm's mouse capture
  // inside the focused terminal doesn't block expansion. We attach to the
  // window itself; the overlay container is always in the DOM (just collapsed),
  // so position/size doesn't shift dependencies.
  useEffect(() => {
    if (pinned) return // pinned: always open, no hover tracking needed

    const clearCollapseTimer = (): void => {
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current)
        collapseTimerRef.current = null
      }
    }

    const onMove = (e: MouseEvent): void => {
      const w = window.innerWidth
      const overlayPx = (w * OVERLAY_WIDTH_PCT) / 100
      const triggerX = w - EDGE_TRIGGER_PX
      // Expand zone: right edge.
      // Keep-open zone: anywhere over the overlay panel itself.
      const inTrigger = e.clientX >= triggerX
      const inOverlay = hovered && e.clientX >= w - overlayPx
      if (inTrigger || inOverlay) {
        clearCollapseTimer()
        if (!hovered) setHovered(true)
      } else if (hovered) {
        // Slight delay so the bar doesn't flicker on fast mouseouts.
        clearCollapseTimer()
        collapseTimerRef.current = setTimeout(() => setHovered(false), COLLAPSE_DELAY_MS)
      }
    }

    const onBlur = (): void => setHovered(false)

    window.addEventListener('mousemove', onMove)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('blur', onBlur)
      clearCollapseTimer()
    }
  }, [hovered, pinned])

  // Don't steal focus on open. Focus moves only on an explicit click in the panel
  // (the onMouseDown handler below). Auto-focusing would silently redirect typing
  // and there's no symmetric "give it back" event when the user just unhovers.

  // When pinned, the overlay takes up part of the layout (handled by parent layout).
  // When unpinned, it overlays on top of the focused terminal.
  const widthPct = pinned ? PINNED_WIDTH_PCT : OVERLAY_WIDTH_PCT
  const visible = pinned || hovered

  return (
    <div
      className="absolute top-0 right-0 h-full flex flex-col bg-[#0a0a0a] border-l border-zinc-800/80 transition-transform duration-200 ease-out"
      style={{
        width: `${widthPct}%`,
        zIndex: pinned ? 21 : 23,
        transform: visible ? 'translateX(0)' : 'translateX(100%)',
        boxShadow: visible && !pinned ? '-8px 0 24px rgba(0,0,0,0.4)' : undefined,
        pointerEvents: visible ? 'auto' : 'none',
      }}
      onMouseDown={() => focusTerminal(attachedId)}
    >
      <div className="h-7 shrink-0 flex items-center justify-between px-2 border-b border-zinc-800/60">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">Attached terminal</span>
        <button
          onClick={() => togglePinned(parentSessionId)}
          className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
            pinned
              ? 'text-blue-300 border-blue-800 bg-blue-950/50 hover:bg-blue-950'
              : 'text-zinc-500 border-zinc-700 hover:text-zinc-300 hover:border-zinc-600'
          }`}
          title={pinned ? 'Unpin (return to hover overlay)' : 'Pin side-by-side'}
        >
          {pinned ? 'Pinned' : 'Pin'}
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        <Terminal
          key={`overlay-${attachedId}`}
          sessionId={attachedId}
          visible={true}
          autoFocus={false}
          onTitleChange={() => { /* attached terminals don't surface their title */ }}
        />
      </div>
    </div>
  )
}

export { OVERLAY_WIDTH_PCT, PINNED_WIDTH_PCT }
