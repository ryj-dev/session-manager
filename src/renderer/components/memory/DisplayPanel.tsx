/**
 * Node color customization panel. Ported from tc-sql-atlas DisplayPanel.tsx.
 */

import { useState, useRef, useCallback } from 'react'
import { type NodeColors, COLOR_THEMES } from '../../lib/memory-types'

const SWATCHES = [
  '#d4585a', '#e8a83c', '#4cc8b0', '#1e90ff', '#00bcd4', '#4db6ac',
  '#8bc34a', '#4caf50', '#2e7d32', '#ff5252', '#ff9800', '#ffc107',
  '#e040fb', '#00e5ff', '#76ff03', '#a0c4ff', '#bdb2ff', '#caffbf',
  '#ff6b35', '#e040a0', '#999999', '#777777', '#555555', '#333333',
]

function ColorPicker({ value, onChange, onMouseEnter, onMouseLeave }: {
  value: string; onChange: (v: string) => void; onMouseEnter: () => void; onMouseLeave: () => void
}) {
  const [hex, setHex] = useState(value)
  const handleHexChange = (v: string) => { setHex(v); if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v) }

  return (
    <div onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{
      position: 'absolute', left: '100%', bottom: 0, marginLeft: 6, width: 180,
      background: 'rgba(15,18,22,0.95)', border: '1px solid #1e2530', borderRadius: 6,
      padding: '10px 12px', backdropFilter: 'blur(12px)', boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      zIndex: 110, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
        {SWATCHES.map((c) => (
          <button key={c} onClick={() => { onChange(c); setHex(c) }} style={{
            width: 22, height: 22, borderRadius: 3, background: c, cursor: 'pointer', padding: 0,
            border: c === value ? '2px solid #fff' : '1px solid rgba(255,255,255,0.1)',
            outline: c === value ? '1px solid #6cf' : 'none',
          }} />
        ))}
      </div>
      <div style={{ width: '100%', height: 1, background: '#1e2530' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <div style={{ width: 24, height: 24, borderRadius: 4, background: value, border: '1px solid #1e2530', flexShrink: 0 }} />
        <input value={hex} onChange={(e) => handleHexChange(e.target.value)} placeholder="#000000" maxLength={7}
          style={{ width: 0, flex: 1, minWidth: 0, background: '#111418', border: '1px solid #1e2530', borderRadius: 3, padding: '4px 6px', color: '#e0e0e0', fontFamily: 'ui-monospace, monospace', fontSize: 11, outline: 'none' }}
          onFocus={(e) => (e.currentTarget.style.borderColor = '#3a4a5a')}
          onBlur={(e) => (e.currentTarget.style.borderColor = '#1e2530')}
        />
      </div>
    </div>
  )
}

function ColorRow({ label, value, onChange, pickerOpen, onPickerOpen, onPickerClose, onPickerMouseEnter, onPickerMouseLeave }: {
  label: string; value: string; onChange: (v: string) => void; pickerOpen: boolean
  onPickerOpen: () => void; onPickerClose: () => void; onPickerMouseEnter: () => void; onPickerMouseLeave: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, position: 'relative' }}>
      <span style={{ fontSize: 11, color: '#889' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#556' }}>{value}</span>
        <button onClick={() => pickerOpen ? onPickerClose() : onPickerOpen()} style={{
          width: 20, height: 20, borderRadius: 3, padding: 0, background: value, cursor: 'pointer',
          border: pickerOpen ? '2px solid #fff' : '1px solid #1e2530',
          outline: pickerOpen ? '1px solid #6cf' : 'none',
        }} />
      </div>
      {pickerOpen && <ColorPicker value={value} onChange={onChange} onMouseEnter={onPickerMouseEnter} onMouseLeave={onPickerMouseLeave} />}
    </div>
  )
}

const NOTE_TYPES: (keyof NodeColors)[] = ['context', 'decision', 'project', 'reference', 'session-log', 'user', 'feedback']

interface Props {
  colors: NodeColors
  onChange: (c: NodeColors) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  sidebarWidth: number
  visible: boolean
}

export default function DisplayPanel({ colors, onChange, onMouseEnter, onMouseLeave, sidebarWidth, visible }: Props) {
  const [openPicker, setOpenPicker] = useState<string | null>(null)
  const pickerHoveredRef = useRef(false)
  const panelHoveredRef = useRef(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => {
      if (!pickerHoveredRef.current && !panelHoveredRef.current) { setOpenPicker(null); onMouseLeave() }
      else if (!pickerHoveredRef.current) setOpenPicker(null)
    }, 120)
  }, [onMouseLeave])

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null }
  }, [])

  return (
    <div
      onMouseEnter={() => { panelHoveredRef.current = true; cancelClose(); onMouseEnter() }}
      onMouseLeave={() => { panelHoveredRef.current = false; scheduleClose() }}
      style={{
        position: 'fixed', bottom: 96, left: sidebarWidth, width: 220,
        background: 'rgba(15,18,22,0.95)', border: '1px solid #1e2530', borderRadius: 6,
        padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12,
        zIndex: 100, backdropFilter: 'blur(12px)', boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        opacity: visible ? 1 : 0, transform: visible ? 'translateX(0)' : 'translateX(-6px)',
        pointerEvents: visible ? 'auto' : 'none', transition: 'opacity 0.15s ease, transform 0.15s ease',
      }}
    >
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#556', marginBottom: 2 }}>
        Node Colors
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {COLOR_THEMES.map((theme) => {
          const isActive = NOTE_TYPES.every((t) => colors[t] === theme.colors[t])
          return (
            <button key={theme.name} onClick={() => onChange(theme.colors)} style={{
              fontFamily: 'ui-monospace, monospace', fontSize: 9, padding: '3px 7px', borderRadius: 3, cursor: 'pointer',
              border: isActive ? '1px solid #6cf' : '1px solid #1e2530',
              background: isActive ? '#1a2530' : '#111418',
              color: isActive ? '#6cf' : '#889',
            }}>
              {theme.name}
            </button>
          )
        })}
      </div>

      <div style={{ width: '100%', height: 1, background: '#1e2530' }} />

      {NOTE_TYPES.map((type) => (
        <ColorRow key={type} label={type} value={colors[type]}
          onChange={(v) => onChange({ ...colors, [type]: v })}
          pickerOpen={openPicker === type}
          onPickerOpen={() => setOpenPicker(type)}
          onPickerClose={() => setOpenPicker(null)}
          onPickerMouseEnter={() => { pickerHoveredRef.current = true; cancelClose() }}
          onPickerMouseLeave={() => { pickerHoveredRef.current = false; scheduleClose() }}
        />
      ))}
    </div>
  )
}
