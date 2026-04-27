import { useState, useRef, useEffect } from 'react'
import type { TodoStatus } from './types'

interface Props {
  status: TodoStatus
  onCycle: () => void
  onPick: (s: TodoStatus) => void
  size?: number
}

/** Colors per status — amber family for active work, emerald for done. */
const STATUS_STYLE: Record<TodoStatus, { fill: string; border: string; glyph: string; label: string }> = {
  'not-started': { fill: 'transparent', border: 'var(--ink-dim)', glyph: '', label: 'unstarted' },
  'agent-todo':  { fill: 'transparent', border: 'var(--accent)', glyph: '?', label: 'agent todo' },
  'in-progress': { fill: 'var(--accent)', border: 'var(--accent)', glyph: '◐', label: 'in progress' },
  'completed':   { fill: 'var(--accent)', border: 'var(--accent)', glyph: '✓', label: 'completed' },
}

const ALL: TodoStatus[] = ['not-started', 'agent-todo', 'in-progress', 'completed']

export function TodoStatusBubble({ status, onCycle, onPick, size = 18 }: Props): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (!wrapperRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const s = STATUS_STYLE[status]

  return (
    <div ref={wrapperRef} className="relative inline-block" style={{ lineHeight: 0 }}>
      <button
        onClick={onCycle}
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
        onMouseDown={(e) => { if (e.shiftKey) { e.preventDefault(); setMenuOpen(true) } }}
        className="ink-press transition-colors"
        style={{
          width: size, height: size,
          boxSizing: 'border-box',
          padding: 0,
          borderRadius: '50%',
          border: `1.5px solid ${s.border}`,
          background: s.fill,
          color: status === 'agent-todo' ? 'var(--accent)' : 'var(--paper)',
          fontFamily: "'Fraunces', serif",
          fontSize: size * 0.72,
          fontStyle: 'italic',
          fontWeight: 500,
          lineHeight: 0,                // kill line-box growth from inline children
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          verticalAlign: 'middle',      // prevents baseline shift between empty and content-full states
          // Keep the shadow slot always present so the layout box is identical across states.
          boxShadow: status === 'completed' || status === 'in-progress'
            ? '0 0 0 3px rgba(212, 165, 116, 0.12)'
            : '0 0 0 3px transparent',
        }}
        title={`${s.label} — click to advance, right/shift-click to pick`}
      >
        {/* Always-rendered inner centering box — keeps vertical metrics constant across states. */}
        <span
          aria-hidden
          style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 0,
          }}
        >
          {status === 'in-progress' && (
            <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 20 20" style={{ color: 'var(--paper)', display: 'block' }}>
              <path d="M10 2 A8 8 0 0 1 10 18 Z" fill="currentColor" />
            </svg>
          )}
          {status === 'completed' && (
            <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 20 20" style={{ display: 'block' }}>
              <path d="M5 10.5 L8.5 14 L15.5 6.5" stroke="var(--paper)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          )}
          {status === 'agent-todo' && (
            <span style={{ color: 'var(--accent)', lineHeight: 1, display: 'inline-block' }}>?</span>
          )}
        </span>
      </button>

      {menuOpen && (
        <div
          className="absolute left-0 top-full mt-1 z-40 ink-fade-in"
          style={{
            background: 'var(--paper-raised)',
            border: '1px solid var(--rule-strong)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
            minWidth: 160,
          }}
        >
          {ALL.map((st) => {
            const style = STATUS_STYLE[st]
            return (
              <button
                key={st}
                onClick={() => { setMenuOpen(false); onPick(st) }}
                className="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors"
                style={{
                  color: st === status ? 'var(--accent)' : 'var(--ink)',
                  background: st === status ? 'rgba(212,165,116,0.06)' : 'transparent',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(236, 228, 210, 0.04)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = st === status ? 'rgba(212,165,116,0.06)' : 'transparent')}
              >
                <span
                  style={{
                    width: 12, height: 12, borderRadius: '50%',
                    border: `1.5px solid ${style.border}`,
                    background: style.fill,
                    display: 'inline-block',
                  }}
                />
                <span className="font-mono-ui text-[11px] smallcaps">{style.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function nextStatus(s: TodoStatus): TodoStatus {
  const i = ALL.indexOf(s)
  return ALL[(i + 1) % ALL.length]
}
