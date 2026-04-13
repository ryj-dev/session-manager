/**
 * Graph options panel. Ported from tc-sql-atlas OptionsPanel.tsx.
 */

import type { GraphOptions } from '../../lib/memory-types'

function Toggle({ label, checked, onChange, disabled }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean
}) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'default' : 'pointer',
      fontSize: 11, color: disabled ? '#445' : '#889', opacity: disabled ? 0.5 : 1, transition: 'opacity 0.15s',
    }}>
      <div onClick={() => { if (!disabled) onChange(!checked) }} style={{
        width: 28, height: 16, borderRadius: 8, position: 'relative',
        background: checked ? (disabled ? '#445' : '#6cf') : '#111418',
        border: `1px solid ${checked ? (disabled ? '#445' : '#6cf') : '#1e2530'}`,
        transition: 'background 0.15s, border-color 0.15s', flexShrink: 0,
      }}>
        <div style={{
          width: 12, height: 12, borderRadius: 6,
          background: checked ? '#fff' : '#556',
          position: 'absolute', top: 1, left: checked ? 14 : 1,
          transition: 'left 0.15s, background 0.15s',
        }} />
      </div>
      {label}
    </label>
  )
}

interface Props {
  options: GraphOptions
  onChange: (o: GraphOptions) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  sidebarWidth: number
  visible: boolean
}

export default function OptionsPanel({ options, onChange, onMouseEnter, onMouseLeave, sidebarWidth, visible }: Props) {
  const isRecalculate = options.searchMode === 'recalculate'

  return (
    <div onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{
      position: 'fixed', bottom: 30, left: sidebarWidth, width: 220,
      background: 'rgba(15,18,22,0.95)', border: '1px solid #1e2530', borderRadius: 6,
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14,
      zIndex: 100, backdropFilter: 'blur(12px)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      opacity: visible ? 1 : 0, transform: visible ? 'translateX(0)' : 'translateX(-6px)',
      pointerEvents: visible ? 'auto' : 'none', transition: 'opacity 0.15s ease, transform 0.15s ease',
    }}>
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#556', marginBottom: 2 }}>
        Options
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Toggle label="Recalculate on search" checked={isRecalculate}
          onChange={(v) => onChange({ ...options, searchMode: v ? 'recalculate' : 'filter', autoFitOnSearch: v ? true : options.autoFitOnSearch })}
        />
        <Toggle label="Auto-fit on search" checked={isRecalculate ? true : options.autoFitOnSearch}
          onChange={(v) => onChange({ ...options, autoFitOnSearch: v })} disabled={isRecalculate}
        />
        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 9, color: '#556', lineHeight: 1.5 }}>
          {isRecalculate ? 'Graph recalculates layout and fits to matched nodes'
            : options.autoFitOnSearch ? 'Non-matches fade out, then camera fits to results'
            : 'Non-matches fade out, camera stays in place'}
        </div>
      </div>
    </div>
  )
}
