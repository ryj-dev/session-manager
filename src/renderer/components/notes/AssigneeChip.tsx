import { useState, useRef, useEffect } from 'react'
import { useStore } from '../../store'

interface Props {
  assignee: string | null | undefined
  assigneeLabel?: string | null
  /** Sessions eligible for assignment (usually filtered by project). */
  eligibleSessionIds?: string[]
  onAssign: (sessionId: string | null, label: string | null) => void
}

export function AssigneeChip({ assignee, assigneeLabel, eligibleSessionIds, onAssign }: Props): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const eligible = eligibleSessionIds
    ? sessions.filter((s) => eligibleSessionIds.includes(s.id))
    : sessions

  // Match by claudeSessionId (stable, preferred) or PTY id (legacy / pre-claude-ready).
  const current = assignee
    ? sessions.find((s) => s.claudeSessionId === assignee || s.id === assignee)
    : null
  const sessionAlive = !!current
  const staleLabel = assignee && !sessionAlive
    ? (assigneeLabel || assignee.slice(0, 8))
    : null

  // Three states:
  //   live      → active assignment, amber pill with session label
  //   stale     → assignee session is gone; treat as actionable "reassign"
  //   unassigned → "+ assign"
  const mode: 'live' | 'stale' | 'unassigned' =
    sessionAlive ? 'live' : staleLabel ? 'stale' : 'unassigned'

  const liveLabel = current
    ? (current.terminalTitle || current.projectName || current.id.slice(0, 8))
    : ''

  const baseStyle: React.CSSProperties = {
    borderRadius: 999,
    lineHeight: 1.4,
    letterSpacing: '0.08em',
  }

  const modeStyle: Record<typeof mode, React.CSSProperties> = {
    live: {
      color: 'var(--accent)',
      border: '1px solid var(--accent)',
      background: 'rgba(212, 165, 116, 0.06)',
    },
    stale: {
      color: 'var(--ink-dim)',
      border: '1px dashed var(--ink-faint)',
      background: 'transparent',
    },
    unassigned: {
      color: 'var(--ink-faint)',
      border: '1px dashed var(--rule-strong)',
      background: 'transparent',
    },
  }

  const titleText =
    mode === 'live' ? `Assigned to ${liveLabel}`
    : mode === 'stale' ? `Was assigned to ${staleLabel} — session no longer available. Click to reassign.`
    : 'Click to assign an active session.'

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        onClick={() => setOpen((o) => !o)}
        className="ink-press font-mono-ui text-[10px] smallcaps transition-colors px-2 py-0.5 inline-flex items-center gap-1"
        style={{ ...baseStyle, ...modeStyle[mode] }}
        title={titleText}
        onMouseEnter={(e) => {
          if (mode !== 'live') e.currentTarget.style.color = 'var(--accent)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = modeStyle[mode].color as string
        }}
      >
        {mode === 'live' && (
          <>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: 'var(--accent)',
              display: 'inline-block',
            }} />
            <span className="truncate" style={{ maxWidth: 140 }}>{liveLabel}</span>
          </>
        )}
        {mode === 'stale' && <span>+ reassign</span>}
        {mode === 'unassigned' && <span>+ assign</span>}
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-40 ink-fade-in"
          style={{
            background: 'var(--paper-raised)',
            border: '1px solid var(--rule-strong)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
            minWidth: 220,
          }}
        >
          <div className="px-3 py-1.5 font-mono-ui text-[9px] smallcaps"
            style={{ color: 'var(--ink-faint)', borderBottom: '1px solid var(--rule)' }}>
            assign to
          </div>
          {eligible.length === 0 && (
            <div className="px-3 py-3 font-display italic text-[12px]" style={{ color: 'var(--ink-faint)' }}>
              No active sessions in this project.
            </div>
          )}
          {eligible.map((s) => {
            const label = s.terminalTitle || s.projectName || s.id.slice(0, 8)
            // Prefer the stable claudeSessionId; fall back to PTY id if Claude hasn't
            // initialized yet (rare — set at spawn for fresh claude sessions).
            const storedId = s.claudeSessionId ?? s.id
            return (
              <button
                key={s.id}
                onClick={() => { setOpen(false); onAssign(storedId, label) }}
                className="w-full text-left flex items-center gap-2 px-3 py-1.5 transition-colors"
                style={{ color: (assignee === s.id || assignee === s.claudeSessionId) ? 'var(--accent)' : 'var(--ink)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(236, 228, 210, 0.04)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: s.status === 'working' ? 'var(--accent)' : 'var(--ink-dim)',
                  boxShadow: s.status === 'working' ? '0 0 4px var(--accent)' : undefined,
                }} />
                <span className="truncate text-[13px] font-display">{label}</span>
                <span className="ml-auto font-mono-ui text-[9px]" style={{ color: 'var(--ink-faint)' }}>
                  {s.projectName}
                </span>
              </button>
            )
          })}
          {assignee && (
            <button
              onClick={() => { setOpen(false); onAssign(null, null) }}
              className="w-full text-left px-3 py-1.5 font-mono-ui text-[10px] smallcaps transition-colors"
              style={{ color: 'var(--ink-faint)', borderTop: '1px solid var(--rule)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--danger)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ink-faint)')}
            >
              ✕ unassign
            </button>
          )}
        </div>
      )}
    </div>
  )
}
