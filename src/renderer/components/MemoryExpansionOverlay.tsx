import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '../store'

const PANEL_WIDTH = 520
const PANEL_MAX_HEIGHT_VH = 55
const EDGE_MARGIN = 12

/**
 * Expansion for an injected-memory token clicked in the transcript.
 *
 * The "Relevant memories injected: [title] [title]" line is real transcript
 * text (hook systemMessage) rendered by Claude Code's TUI — we can't reflow
 * that screen, so "expanding" is an overlay anchored at the clicked token.
 * Closes on Esc, click-outside, or wheel (so it never appears detached from
 * the line it expanded once the transcript scrolls).
 */
export function MemoryExpansionOverlay(): JSX.Element | null {
  const expansion = useStore((s) => s.memoryExpansion)
  const injections = useStore((s) => s.memoryInjections)
  const close = useStore((s) => s.closeMemoryExpansion)
  const panelRef = useRef<HTMLDivElement>(null)

  const entry = useMemo(() => {
    if (!expansion) return null
    return (injections[expansion.sessionId] ?? []).find((e) => e.filename === expansion.filename) ?? null
  }, [expansion, injections])

  useEffect(() => {
    if (!expansion) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) close()
    }
    const onWheel = (): void => close()
    // Capture phase: beat the terminal's own key handling and the app hotkeys.
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('wheel', onWheel, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('wheel', onWheel, true)
    }
  }, [expansion, close])

  if (!expansion || !entry) return null

  // Clamp the panel into the viewport, preferring to open below the click.
  const maxHeightPx = Math.round((window.innerHeight * PANEL_MAX_HEIGHT_VH) / 100)
  const left = Math.min(Math.max(EDGE_MARGIN, expansion.x), window.innerWidth - PANEL_WIDTH - EDGE_MARGIN)
  const openBelow = expansion.y + 24 + maxHeightPx < window.innerHeight - EDGE_MARGIN
  const top = openBelow ? expansion.y + 18 : Math.max(EDGE_MARGIN, expansion.y - maxHeightPx - 10)

  return (
    <div
      ref={panelRef}
      className="fixed z-[70] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/60 flex flex-col overflow-hidden"
      style={{ left, top, width: PANEL_WIDTH, maxHeight: maxHeightPx }}
    >
      <div className="flex items-start gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-950/60 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-200 truncate">{entry.title}</div>
          <div className="text-[10px] text-zinc-500 font-mono truncate">
            {entry.filename} · {entry.type} · injected into this session&apos;s context
          </div>
        </div>
        <button
          onClick={close}
          className="text-zinc-600 hover:text-zinc-300 transition-colors shrink-0 mt-0.5"
          title="Collapse (Esc)"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
          </svg>
        </button>
      </div>
      <div className="overflow-y-auto px-3 py-2">
        <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-zinc-300 font-mono">
          {entry.body}
        </pre>
      </div>
    </div>
  )
}
