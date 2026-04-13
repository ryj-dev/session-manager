/**
 * Force control sliders. Ported from tc-sql-atlas PhysicsPanel.tsx.
 */

import type { PhysicsParams } from '../../lib/memory-types'

function Slider({ label, value, min, max, step, displayValue, onChange }: {
  label: string; value: number; min: number; max: number; step: number; displayValue: string; onChange: (v: number) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 11, color: '#889' }}>{label}</span>
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#6cf' }}>{displayValue}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#6cf', cursor: 'pointer' }}
      />
    </div>
  )
}

interface Props {
  params: PhysicsParams
  onChange: (p: PhysicsParams) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  sidebarWidth: number
  visible: boolean
}

export default function PhysicsPanel({ params, onChange, onMouseEnter, onMouseLeave, sidebarWidth, visible }: Props) {
  const set = (key: keyof PhysicsParams) => (v: number) => onChange({ ...params, [key]: v })

  return (
    <div onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{
      position: 'fixed', bottom: 63, left: sidebarWidth, width: 220,
      background: 'rgba(15,18,22,0.95)', border: '1px solid #1e2530', borderRadius: 6,
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14,
      zIndex: 100, backdropFilter: 'blur(12px)', boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      opacity: visible ? 1 : 0, transform: visible ? 'translateX(0)' : 'translateX(-6px)',
      pointerEvents: visible ? 'auto' : 'none', transition: 'opacity 0.15s ease, transform 0.15s ease',
    }}>
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#556', marginBottom: 2 }}>
        Force Controls
      </div>
      <Slider label="Center Force" value={params.centerForce} min={0} max={0.5} step={0.01} displayValue={params.centerForce.toFixed(2)} onChange={set('centerForce')} />
      <Slider label="Repel Force" value={params.repelForce} min={0} max={20} step={0.5} displayValue={params.repelForce.toFixed(1)} onChange={set('repelForce')} />
      <Slider label="Link Force" value={params.linkForce} min={0} max={1} step={0.01} displayValue={params.linkForce.toFixed(2)} onChange={set('linkForce')} />
      <Slider label="Link Distance" value={params.linkDistance} min={20} max={500} step={10} displayValue={`${params.linkDistance}px`} onChange={set('linkDistance')} />
      <Slider label="Friction" value={params.friction} min={0.1} max={0.99} step={0.01} displayValue={params.friction.toFixed(2)} onChange={set('friction')} />
    </div>
  )
}
