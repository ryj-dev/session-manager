import { useMemo } from 'react'
import { useStore } from '../../store'
import { projectColor } from '../../lib/simulation'
import { isProjectTag, projectFromTag, type TagCount } from './types'

interface Props {
  tags: TagCount[]
  totals: { all: number; open: number; done: number }
  onNewTodo: () => void
}

export function NotesSidebar({ tags, totals, onNewTodo }: Props): JSX.Element {
  const selectedTags = useStore((s) => s.todosSelectedTags)
  const setSelectedTags = useStore((s) => s.setTodosSelectedTags)
  const toggleTag = useStore((s) => s.toggleTodosTag)
  const showCompleted = useStore((s) => s.todosShowCompleted)
  const setShowCompleted = useStore((s) => s.setTodosShowCompleted)
  const sessionProjectTag = useStore((s) => s.todosSessionProjectTag)

  const { projectTags, otherTags } = useMemo(() => {
    const proj: TagCount[] = []
    const other: TagCount[] = []
    for (const t of tags) (isProjectTag(t.tag) ? proj : other).push(t)
    // Pin the current-session project to the top
    proj.sort((a, b) => {
      if (a.tag === sessionProjectTag) return -1
      if (b.tag === sessionProjectTag) return 1
      return a.tag.localeCompare(b.tag)
    })
    other.sort((a, b) => a.tag.localeCompare(b.tag))
    return { projectTags: proj, otherTags: other }
  }, [tags, sessionProjectTag])

  return (
    <aside
      className="todos-scroll"
      style={{
        background: 'var(--todos-surface)',
        borderRight: '1px solid var(--todos-border)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Head */}
      <div className="titlebar-drag" style={{ paddingLeft: 80 }}>
        <div className="titlebar-no-drag" style={{
          padding: '14px 16px 10px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Todos</div>
          <IconButton title="New todo" onClick={onNewTodo}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </IconButton>
        </div>
      </div>

      {/* Body */}
      <div className="todos-scroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 16px' }}>
        <NavRow
          active={selectedTags.length === 0 && showCompleted}
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
          }
          label="All"
          count={totals.all}
          onClick={() => { setSelectedTags([]); setShowCompleted(true) }}
        />
        <NavRow
          active={selectedTags.length === 0 && !showCompleted}
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/></svg>
          }
          label="Open"
          count={totals.open}
          onClick={() => { setSelectedTags([]); setShowCompleted(false) }}
        />

        {projectTags.length > 0 && (
          <Section label="Projects">
            {projectTags.map((t) => {
              const name = projectFromTag(t.tag)
              return (
                <NavRow
                  key={t.tag}
                  active={selectedTags.includes(t.tag)}
                  tag
                  dotColor={projectColor(name)}
                  label={name}
                  count={t.count}
                  onClick={() => toggleTag(t.tag)}
                />
              )
            })}
          </Section>
        )}

        {otherTags.length > 0 && (
          <Section label="Tags">
            {otherTags.map((t) => (
              <NavRow
                key={t.tag}
                active={selectedTags.includes(t.tag)}
                tag
                dotColor="var(--todos-text-faint)"
                label={t.tag}
                count={t.count}
                onClick={() => toggleTag(t.tag)}
              />
            ))}
          </Section>
        )}
      </div>
    </aside>
  )
}

function IconButton({
  children, onClick, title,
}: { children: React.ReactNode; onClick?: () => void; title?: string }): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 24, height: 24,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 6,
        color: 'var(--todos-text-dim)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--todos-surface-2)'; e.currentTarget.style.color = 'var(--todos-text)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--todos-text-dim)' }}
    >
      {children}
    </button>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{
        padding: '4px 8px',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--todos-text-faint)',
        fontWeight: 500,
      }}>{label}</div>
      {children}
    </div>
  )
}

function NavRow({
  active, icon, dotColor, tag, label, count, onClick,
}: {
  active: boolean
  icon?: React.ReactNode
  dotColor?: string
  tag?: boolean
  label: string
  count: number
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%',
        padding: '5px 8px',
        borderRadius: 6,
        background: active ? 'var(--todos-surface-2)' : 'transparent',
        color: active ? 'var(--todos-text)' : 'var(--todos-text-dim)',
        fontSize: 13,
        textAlign: 'left',
      }}
      onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = 'var(--todos-surface-2)'; e.currentTarget.style.color = 'var(--todos-text)' } }}
      onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--todos-text-dim)' } }}
    >
      {icon}
      {tag && <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor ?? 'var(--todos-text-faint)', flexShrink: 0 }} />}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontSize: 11, color: 'var(--todos-text-faint)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
    </button>
  )
}
