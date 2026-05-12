import { projectColor, projectColorDim } from '../../lib/simulation'
import { isProjectTag, projectFromTag } from './types'

interface Props {
  tag: string
  onRemove?: () => void
  onClick?: () => void
  size?: 'sm' | 'md'
}

export function TagChip({ tag, onRemove, onClick, size = 'sm' }: Props): JSX.Element {
  const isProject = isProjectTag(tag)
  const label = isProject ? projectFromTag(tag) : tag
  const height = size === 'sm' ? 20 : 22
  const fontSize = 11

  const background = isProject ? projectColorDim(label) : 'var(--todos-chip-bg)'
  const color = isProject ? projectColor(label) : 'var(--todos-text-dim)'

  return (
    <span
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height,
        padding: onRemove ? '0 4px 0 8px' : '0 8px',
        borderRadius: 4,
        background,
        color,
        fontSize,
        whiteSpace: 'nowrap',
        gap: 4,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      {label}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          aria-label={`Remove ${label}`}
          style={{
            width: 14, height: 14,
            borderRadius: 3,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            opacity: 0.5,
            color,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.background = 'transparent' }}
        >
          ×
        </button>
      )}
    </span>
  )
}
