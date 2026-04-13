/**
 * Memory sidebar — flat note list grouped by type, search, panel buttons.
 * Adapted from tc-sql-atlas Sidebar.tsx.
 */

import { useRef, useEffect, useMemo } from 'react'
import type { GraphNode } from '../../lib/memory-types'

const TYPE_COLORS: Record<string, string> = {
  context: '#007F7E',
  decision: '#C48A1A',
  project: '#1e90ff',
  reference: '#9C27B0',
  'session-log': '#777',
  user: '#e040a0',
  feedback: '#ff6b35',
}

function NoteIcon({ type }: { type?: string }) {
  const color = type ? TYPE_COLORS[type] ?? '#556' : '#556'
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
      <rect x="1" y="1" width="10" height="10" rx="1.5" stroke={color} strokeWidth="1" fill="none"/>
      <line x1="3" y1="4" x2="9" y2="4" stroke={color} strokeWidth="0.8"/>
      <line x1="3" y1="6" x2="9" y2="6" stroke={color} strokeWidth="0.8"/>
      <line x1="3" y1="8" x2="7" y2="8" stroke={color} strokeWidth="0.8"/>
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
      style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', color: '#556' }}>
      <path d="M3 2L7 5L3 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function FooterButton({ active, onMouseEnter, onMouseLeave, children }: {
  active: boolean; onMouseEnter: () => void; onMouseLeave: () => void; children: React.ReactNode
}) {
  return (
    <button onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 7,
      padding: '8px 12px', background: active ? '#141a22' : 'none',
      border: 'none', borderBottom: '1px solid #1a1f28', cursor: 'pointer',
      color: active ? '#6cf' : '#556', fontFamily: 'ui-monospace, monospace', fontSize: 10,
      letterSpacing: '0.05em', transition: 'background 0.15s, color 0.15s', textAlign: 'left',
    }}>
      {children}
    </button>
  )
}

interface SidebarProps {
  notes: GraphNode[]
  selectedNote: string | null
  onSelectNote: (filename: string) => void
  onDisplayMouseEnter: () => void
  onDisplayMouseLeave: () => void
  showDisplay: boolean
  onPhysicsMouseEnter: () => void
  onPhysicsMouseLeave: () => void
  showPhysics: boolean
  onOptionsMouseEnter: () => void
  onOptionsMouseLeave: () => void
  showOptions: boolean
  search: string
  onSearchChange: (q: string) => void
  searchMatchPaths: Set<string> | null
  onCreateNote: () => void
}

const TYPE_ORDER = ['project', 'decision', 'context', 'reference', 'session-log', 'user', 'feedback', '']

export default function MemorySidebar({
  notes, selectedNote, onSelectNote,
  onDisplayMouseEnter, onDisplayMouseLeave, showDisplay,
  onPhysicsMouseEnter, onPhysicsMouseLeave, showPhysics,
  onOptionsMouseEnter, onOptionsMouseLeave, showOptions,
  search, onSearchChange, searchMatchPaths, onCreateNote,
}: SidebarProps) {
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const active = document.activeElement
      const isInInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      if (searchRef.current && !isInInput && e.key.length === 1) searchRef.current.focus()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const isSearching = search.trim().length > 0

  // Group notes by type, filtered by search
  const grouped = useMemo(() => {
    let filtered = notes
    if (isSearching && searchMatchPaths) {
      filtered = notes.filter((n) => searchMatchPaths.has(n.id))
    }

    const groups = new Map<string, GraphNode[]>()
    for (const note of filtered) {
      const type = note.type || ''
      if (!groups.has(type)) groups.set(type, [])
      groups.get(type)!.push(note)
    }

    // Sort groups by TYPE_ORDER
    return TYPE_ORDER
      .filter((t) => groups.has(t))
      .map((t) => ({ type: t, notes: groups.get(t)! }))
      .concat(
        [...groups.entries()]
          .filter(([t]) => !TYPE_ORDER.includes(t))
          .map(([type, notes]) => ({ type, notes }))
      )
  }, [notes, isSearching, searchMatchPaths])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: 260, borderRight: '1px solid #1a1f28' }}>
      {/* Search — extra top padding for macOS traffic lights */}
      <div style={{ padding: '38px 10px 8px', borderBottom: '1px solid #1a1f28', flexShrink: 0, WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div style={{ position: 'relative', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#556', pointerEvents: 'none' }}>
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2"/>
            <line x1="7.5" y1="7.5" x2="10.5" y2="10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <input ref={searchRef} value={search} onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search notes..."
            style={{
              width: '100%', background: '#111418', border: '1px solid #1e2530', borderRadius: 4,
              padding: '5px 8px 5px 26px', color: '#e0e0e0', fontFamily: 'inherit', fontSize: 12, outline: 'none',
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = '#3a4a5a')}
            onBlur={(e) => (e.currentTarget.style.borderColor = '#1e2530')}
          />
          {search && (
            <button onClick={() => onSearchChange('')} style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer', color: '#889', fontSize: 14, padding: 2,
            }}>x</button>
          )}
        </div>
        {isSearching && searchMatchPaths && (
          <div style={{ marginTop: 4, fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#556' }}>
            {searchMatchPaths.size} result{searchMatchPaths.size !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* Note list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 4px' }}>
        {grouped.length === 0 ? (
          <div style={{ padding: '20px 12px', textAlign: 'center', color: '#556', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
            {isSearching ? 'no matches' : 'no notes yet'}
          </div>
        ) : (
          grouped.map(({ type, notes: groupNotes }) => (
            <div key={type}>
              <div style={{
                padding: '6px 8px 4px', fontFamily: 'ui-monospace, monospace', fontSize: 10,
                textTransform: 'uppercase', letterSpacing: '0.08em', color: TYPE_COLORS[type] ?? '#556',
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
                <ChevronIcon open={true} />
                {type || 'other'}
                <span style={{ color: '#445', marginLeft: 'auto' }}>{groupNotes.length}</span>
              </div>
              {groupNotes.map((note) => (
                <div key={note.id}
                  onClick={() => onSelectNote(note.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 5px 20px',
                    cursor: 'pointer', borderRadius: 3,
                    background: selectedNote === note.id ? '#1a2530' : 'transparent',
                    color: selectedNote === note.id ? '#e0e0e0' : '#aab',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => { if (selectedNote !== note.id) e.currentTarget.style.background = '#111418' }}
                  onMouseLeave={(e) => { if (selectedNote !== note.id) e.currentTarget.style.background = 'transparent' }}
                >
                  <NoteIcon type={note.type} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                    {note.label}
                  </span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div style={{ borderTop: '1px solid #1a1f28', flexShrink: 0 }}>
        <button onClick={onCreateNote} style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 7,
          padding: '8px 12px', background: 'none',
          border: 'none', borderBottom: '1px solid #1a1f28', cursor: 'pointer',
          color: '#556', fontFamily: 'ui-monospace, monospace', fontSize: 10,
          letterSpacing: '0.05em', textAlign: 'left',
        }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#141a22'; e.currentTarget.style.color = '#6cf' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#556' }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <line x1="6" y1="2" x2="6" y2="10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          New Note
        </button>
        {!selectedNote && (
          <>
            <FooterButton active={showDisplay} onMouseEnter={onDisplayMouseEnter} onMouseLeave={onDisplayMouseLeave}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <circle cx="4" cy="5" r="2.5" stroke="currentColor" strokeWidth="1" fill="none"/>
                <circle cx="8" cy="5" r="2.5" stroke="currentColor" strokeWidth="1" fill="none"/>
                <circle cx="6" cy="8" r="2.5" stroke="currentColor" strokeWidth="1" fill="none"/>
              </svg>
              Display
            </FooterButton>
            <FooterButton active={showPhysics} onMouseEnter={onPhysicsMouseEnter} onMouseLeave={onPhysicsMouseLeave}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1"/>
                <line x1="6" y1="1" x2="6" y2="3" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                <line x1="6" y1="9" x2="6" y2="11" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                <line x1="1" y1="6" x2="3" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                <line x1="9" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
              </svg>
              Force Controls
            </FooterButton>
            <FooterButton active={showOptions} onMouseEnter={onOptionsMouseEnter} onMouseLeave={onOptionsMouseLeave}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="1.5" stroke="currentColor" strokeWidth="1"/>
                <path d="M6 1v2M6 9v2M1 6h2M9 6h2M2.5 2.5l1.4 1.4M8.1 8.1l1.4 1.4M9.5 2.5l-1.4 1.4M3.9 8.1l-1.4 1.4" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
              </svg>
              Options
            </FooterButton>
          </>
        )}
        <div style={{ padding: '7px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#445', display: 'flex', justifyContent: 'space-between' }}>
          <span>memory</span>
          <span>v0.1</span>
        </div>
      </div>
    </div>
  )
}
