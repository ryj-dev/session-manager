import { useEffect, useMemo, useRef } from 'react'
import { useStore, type Session, type SessionStatus } from '../store'
import { Terminal, focusTerminal, setTerminalFontSize } from './Terminal'
import { resolveShape, type Shape } from '../lib/splitLayouts'
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
  const shape: Shape | null = useMemo(
    () => (group ? resolveShape(N, group.shapeId) : null),
    [group, N]
  )

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
          // Seed pendingShapeId with the active group's CURRENT shape so the
          // modal preview opens at the user's last layout, not the per-N default.
          // Otherwise a no-op release would silently snap the group back to default.
          const activeGroup = s.activeSplitGroupId
            ? s.splitGroups.find((g) => g.id === s.activeSplitGroupId) ?? null
            : null
          if (activeGroup?.shapeId) {
            s.setPendingShapeId(activeGroup.shapeId)
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
        if (activeId) {
          // Apply any drag-chosen member order (slot swaps) to the group.
          const activeGroup = state.splitGroups.find((g) => g.id === activeId)
          const selection = state.selectedForGroupingIds
          if (
            activeGroup &&
            selection.length === activeGroup.orderedSessionIds.length &&
            selection.some((id, i) => id !== activeGroup.orderedSessionIds[i]) &&
            selection.every((id) => activeGroup.orderedSessionIds.includes(id))
          ) {
            state.updateSplitGroupMembers(activeId, selection)
          }
          // Apply any drag-chosen shape to the active group.
          if (state.pendingShapeId) {
            state.updateSplitGroupShape(activeId, state.pendingShapeId)
          }
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

  if (!group || !shape) return null

  const members = group.orderedSessionIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is Session => Boolean(s))

  if (members.length === 0) return null

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[#0a0a0a]">
      {/* Titlebar — drag region */}
      <div className="h-10 border-b border-zinc-800/50 titlebar-drag shrink-0 flex items-center pr-4">
        <div className={`titlebar-no-drag flex items-center gap-2 text-xs text-zinc-500 ${navigator.platform.startsWith('Mac') ? 'pl-20' : 'pl-4'}`}>
          <span>Split view · {members.length} session{members.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Grid container using the resolved shape */}
      <div
        className="flex-1 min-h-0 grid gap-2 p-2"
        style={{
          gridTemplateColumns: `repeat(${shape.cols}, 1fr)`,
          gridTemplateRows: `repeat(${shape.rows}, 1fr)`,
        }}
      >
        {members.map((session, i) => {
          const slot = shape.slots[i]
          if (!slot) return null
          return (
            <SplitPanel
              key={session.id}
              session={session}
              slotIndex={i}
              slot={slot}
              isFocused={session.id === focusedSessionId}
              onFocus={() => {
                setFocusedSessionId(session.id)
                if (session.status === 'finished') markSessionSeen(session.id)
              }}
              onTitleChange={onTitleChange}
            />
          )
        })}
      </div>
    </div>
  )
}

interface SplitPanelProps {
  session: Session
  slotIndex: number
  slot: { col: number; row: number; colSpan: number; rowSpan: number }
  isFocused: boolean
  onFocus: () => void
  onTitleChange: (id: string, title: string) => void
}

function SplitPanel({ session, slotIndex, slot, isFocused, onFocus, onTitleChange }: SplitPanelProps): JSX.Element {
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
      className="relative min-w-0 min-h-0 rounded-lg overflow-hidden"
      style={{
        gridColumn: `${slot.col + 1} / span ${slot.colSpan}`,
        gridRow: `${slot.row + 1} / span ${slot.rowSpan}`,
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
