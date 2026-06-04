import { useEffect, useRef } from 'react'
import { useStore, type Session, type SessionStatus } from '../store'
import { Terminal, focusTerminal, setTerminalFontSize } from './Terminal'
import type { Layout } from '../lib/splitLayouts'
import { projectColor, projectColorDim } from '../lib/simulation'

interface SplitViewProps {
  onTitleChange: (id: string, title: string) => void
}

// Outer status border color per session status. Layered with an inner
// white focus ring on the focused panel.
const STATUS_BORDER: Record<SessionStatus, string | null> = {
  working: 'rgb(251 191 36)',     // amber-400
  permission: 'rgb(96 165 250)',  // blue-400
  finished: 'rgb(74 222 128)',    // green-400
  seen: null,
  exited: null,
}

const STATUS_GLOW: Record<SessionStatus, string | null> = {
  working: '0 0 14px rgba(251,191,36,0.30)',
  permission: '0 0 14px rgba(96,165,250,0.30)',
  finished: '0 0 14px rgba(74,222,128,0.30)',
  seen: null,
  exited: null,
}

// Default font size when not in split (matches xterm default).
const DEFAULT_FONT_SIZE = 14

// Tiered font sizes by panel width, in px. Tuned so that ~80 cols fit in the
// narrowest tier. Larger panels use the standard 14px font.
const FONT_TIERS: Array<{ minWidth: number; size: number }> = [
  { minWidth: 720, size: 14 },
  { minWidth: 540, size: 12 },
  { minWidth: 420, size: 11 },
  { minWidth: 320, size: 10 },
  { minWidth: 0,   size: 9 },
]

function fontForWidth(w: number): number {
  for (const t of FONT_TIERS) if (w >= t.minWidth) return t.size
  return 9
}

/** Same default-title heuristic the SessionNode uses for thumbnail labels. */
function isDefaultClaudeTitle(t: string | null): boolean {
  if (!t) return true
  const clean = t.replace(/[✳*⠀-⣿]\s*/g, '').trim()
  if (clean === '') return true
  const lower = clean.toLowerCase()
  if (['claude code', 'claude'].includes(lower)) return true
  if (lower.endsWith('claude.exe') || lower.endsWith('claude')) return true
  return false
}

const STILLNESS_DELAY_MS = 1500

export function SplitView({ onTitleChange }: SplitViewProps): JSX.Element | null {
  const sessions = useStore((s) => s.sessions)
  const splitGroups = useStore((s) => s.splitGroups)
  const activeSplitGroupId = useStore((s) => s.activeSplitGroupId)
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const setFocusedSessionId = useStore((s) => s.setFocusedSessionId)
  const setCmdHeld = useStore((s) => s.setCmdHeld)
  const setGroupingSelection = useStore((s) => s.setGroupingSelection)
  const markSessionSeen = useStore((s) => s.markSessionSeen)

  const group = splitGroups.find((g) => g.id === activeSplitGroupId)
  const N = group?.orderedSessionIds.length ?? 0

  // Default focus to slot 0 when entering the view.
  useEffect(() => {
    if (!group) return
    if (focusedSessionId && group.orderedSessionIds.includes(focusedSessionId)) return
    const first = group.orderedSessionIds[0]
    if (first) {
      setFocusedSessionId(first)
      requestAnimationFrame(() => focusTerminal(first))
    }
  }, [group, focusedSessionId, setFocusedSessionId])

  // Cmd-hold-still detection — opens the reshape modal after 1.5s of held Cmd
  // with no other key. Mirror of the graph-view flow but pre-populates the
  // selection with the current group's members.
  const stillnessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const isMetaKey = (k: string): boolean => k === 'Meta' || k === 'OS' || k === 'Control'

    const clearStillness = (): void => {
      if (stillnessTimerRef.current) {
        clearTimeout(stillnessTimerRef.current)
        stillnessTimerRef.current = null
      }
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (isMetaKey(e.key) && !e.repeat) {
        const state = useStore.getState()
        const activeId = state.activeSplitGroupId
        const liveGroup = activeId ? state.splitGroups.find((g) => g.id === activeId) : null
        if (!liveGroup) return
        // Mark the hold and seed the selection with current members so the
        // modal preview renders the right shape immediately on stillness.
        setCmdHeld(true)
        setGroupingSelection(liveGroup.orderedSessionIds.slice())
        clearStillness()
        stillnessTimerRef.current = setTimeout(() => {
          const s = useStore.getState()
          if (s.viewMode !== 'split') return
          if (s.selectedForGroupingIds.length < 2) return
          // Seed pendingLayout with the group's CURRENT tree so the modal opens at
          // the user's existing arrangement. A no-op release then commits the
          // same tree back, leaving the group unchanged.
          const activeGroup = s.activeSplitGroupId
            ? s.splitGroups.find((g) => g.id === s.activeSplitGroupId) ?? null
            : null
          if (activeGroup) {
            s.setPendingLayout(activeGroup.layout)
          }
          s.openSplitModal()
        }, STILLNESS_DELAY_MS)
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (isMetaKey(e.key)) {
        clearStillness()
        const state = useStore.getState()
        const activeId = state.activeSplitGroupId
        if (activeId && state.pendingLayout) {
          state.setSplitGroupLayout(activeId, state.pendingLayout)
        }
        state.closeSplitModal()
        setCmdHeld(false) // also clears selection
      }
    }

    const onBlur = (): void => {
      clearStillness()
      useStore.getState().closeSplitModal()
      setCmdHeld(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      // Don't clearStillness on every re-run — same bug fix as GraphView.
    }
  }, [setCmdHeld, setGroupingSelection])

  // Clear a finished pane's green border the moment the user actually types
  // into the focused panel. Click is handled in SplitPanel.onMouseDown.
  // Pure modifier-only events (Cmd/Ctrl/Shift/Alt) don't count — they happen
  // every time the user reaches for a hotkey and shouldn't dismiss the cue.
  useEffect(() => {
    const MOD_ONLY = new Set(['Meta', 'Control', 'Shift', 'Alt', 'OS'])
    const onKey = (e: KeyboardEvent): void => {
      if (MOD_ONLY.has(e.key)) return
      const s = useStore.getState()
      const fid = s.focusedSessionId
      if (!fid) return
      const session = s.sessions.find((x) => x.id === fid)
      if (session?.status === 'finished') markSessionSeen(fid)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [markSessionSeen])

  // Cmd+1..9 jump-to-slot, Cmd+]/Cmd+[ cycle next/prev.
  useEffect(() => {
    if (!group) return
    const ids = group.orderedSessionIds
    const onKey = (e: KeyboardEvent): void => {
      const isMeta = navigator.platform.startsWith('Mac') ? e.metaKey : e.altKey
      if (isMeta && (e.key === ']' || e.key === '[')) {
        if (ids.length < 2) return
        e.preventDefault()
        e.stopImmediatePropagation()
        const cur = ids.indexOf(useStore.getState().focusedSessionId ?? '')
        const next = e.key === '['
          ? (cur <= 0 ? ids.length - 1 : cur - 1)
          : (cur + 1) % ids.length
        const id = ids[next]
        setFocusedSessionId(id)
        focusTerminal(id)
        return
      }
      if (isMeta && /^[1-9]$/.test(e.key)) {
        const slot = parseInt(e.key, 10) - 1
        if (slot < ids.length) {
          e.preventDefault()
          e.stopImmediatePropagation()
          const id = ids[slot]
          setFocusedSessionId(id)
          focusTerminal(id)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [group, setFocusedSessionId])

  if (!group) return null

  const sessionsById = new Map(sessions.map((s) => [s.id, s]))
  const slotIndexById = new Map<string, number>()
  group.orderedSessionIds.forEach((id, i) => slotIndexById.set(id, i))

  if (group.orderedSessionIds.length === 0) return null

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[#0a0a0a]">
      {/* Titlebar — drag region */}
      <div className="h-10 border-b border-zinc-800/50 titlebar-drag shrink-0 flex items-center pr-4">
        <div className={`titlebar-no-drag flex items-center gap-2 text-xs text-zinc-500 ${navigator.platform.startsWith('Mac') ? 'pl-20' : 'pl-4'}`}>
          <span>Split view · {group.orderedSessionIds.length} session{group.orderedSessionIds.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-2">
        <LayoutPanes
          layout={group.layout}
          renderLeaf={(id) => {
            const session = sessionsById.get(id)
            if (!session) return null
            const slotIndex = slotIndexById.get(id) ?? 0
            return (
              <SplitPanel
                session={session}
                slotIndex={slotIndex}
                isFocused={session.id === focusedSessionId}
                onFocus={() => {
                  setFocusedSessionId(session.id)
                  if (session.status === 'finished') markSessionSeen(session.id)
                }}
                onTitleChange={onTitleChange}
              />
            )
          }}
        />
      </div>
    </div>
  )
}

interface LayoutPanesProps {
  layout: Layout
  renderLeaf: (id: string) => JSX.Element | null
}

const PANE_GAP_PX = 8

/**
 * Render a `Layout` tree as nested flex containers. Each container is one
 * flexbox with K children whose flex-basis is `weight × 100% − gapShare`, so
 * the gap pixels are distributed proportionally and panes don't overflow.
 */
function LayoutPanes({ layout, renderLeaf }: LayoutPanesProps): JSX.Element | null {
  if (layout.kind === 'leaf') {
    return <div className="w-full h-full min-w-0 min-h-0">{renderLeaf(layout.id)}</div>
  }
  const isRow = layout.dir === 'row'
  const k = layout.children.length
  // Total cross-gap pixels = (K-1) × GAP. Distribute proportionally to weights
  // so a wider pane doesn't lose more than its share to gap reservation.
  const gapShareTotal = (k - 1) * PANE_GAP_PX
  return (
    <div
      className="w-full h-full min-w-0 min-h-0 flex"
      style={{ flexDirection: isRow ? 'row' : 'column', gap: PANE_GAP_PX }}
    >
      {layout.children.map((child, i) => (
        <div
          key={i}
          className="min-w-0 min-h-0"
          style={{
            flex: `0 0 calc(${layout.weights[i] * 100}% - ${layout.weights[i] * gapShareTotal}px)`,
          }}
        >
          <LayoutPanes layout={child} renderLeaf={renderLeaf} />
        </div>
      ))}
    </div>
  )
}

interface SplitPanelProps {
  session: Session
  slotIndex: number
  isFocused: boolean
  onFocus: () => void
  onTitleChange: (id: string, title: string) => void
}

function SplitPanel({ session, slotIndex, isFocused, onFocus, onTitleChange }: SplitPanelProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  // Drive xterm font size off our own width with ResizeObserver.
  // Restore default on unmount so focused/graph view aren't left with tiny text.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = (): void => {
      const w = el.offsetWidth
      if (w <= 0) return
      setTerminalFontSize(session.id, fontForWidth(w))
    }
    apply()
    const ro = new ResizeObserver(() => apply())
    ro.observe(el)
    return () => {
      ro.disconnect()
      setTerminalFontSize(session.id, DEFAULT_FONT_SIZE)
    }
  }, [session.id])

  const statusBorder = STATUS_BORDER[session.status]
  const statusGlow = STATUS_GLOW[session.status]

  return (
    <div
      ref={ref}
      className="relative w-full h-full min-w-0 min-h-0 rounded-lg overflow-hidden"
      style={{
        outline: statusBorder ? `2px solid ${statusBorder}` : '1px solid rgb(39 39 42 / 0.7)',
        outlineOffset: 0,
        boxShadow: statusGlow ?? undefined,
      }}
      onMouseDown={() => {
        if (!isFocused) onFocus()
        else if (session.status === 'finished') {
          useStore.getState().markSessionSeen(session.id)
        }
        focusTerminal(session.id)
      }}
    >
      <Terminal
        key={`split-${session.id}`}
        sessionId={session.id}
        visible={true}
        onTitleChange={(title) => onTitleChange(session.id, title)}
      />

      {isFocused && (
        <div
          className="absolute inset-0 pointer-events-none rounded-md"
          style={{ boxShadow: 'inset 0 0 0 2px rgba(255,255,255,0.7)' }}
        />
      )}

      <div className="absolute top-1.5 left-1.5 flex items-center gap-1 pointer-events-none max-w-[calc(100%-12px)]">
        {/* Slot number */}
        <div className="px-1.5 py-0.5 text-[10px] font-mono text-zinc-200 bg-black/70 rounded shrink-0">
          {slotIndex + 1}
        </div>
        {/* Project / session-title pill, hub-colored */}
        <div
          className="px-2 py-0.5 text-[10px] font-medium rounded border whitespace-nowrap truncate min-w-0"
          style={{
            backgroundColor: projectColorDim(session.projectPath),
            borderColor: projectColor(session.projectPath),
            color: projectColor(session.projectPath),
          }}
          title={`${session.projectName} · ${session.projectPath}`}
        >
          {isDefaultClaudeTitle(session.terminalTitle)
            ? session.projectName
            : session.terminalTitle}
        </div>
      </div>
    </div>
  )
}
