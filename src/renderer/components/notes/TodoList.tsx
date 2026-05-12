import { useMemo } from 'react'
import { useStore } from '../../store'
import { projectColor } from '../../lib/simulation'
import type { TodoSummary } from './types'
import { isProjectTag, projectFromTag } from './types'
import { TagChip } from './TagChip'

const NO_PROJECT_KEY = '__no_project__'

interface ProjectGroup {
  /** Project tag (e.g. `project:session-manager`), or `NO_PROJECT_KEY` for untagged todos. */
  key: string
  /** Display name; '' for the No-project group. */
  name: string
  todos: TodoSummary[]
}

function groupByProject(todos: TodoSummary[]): Map<string, ProjectGroup> {
  const groups = new Map<string, ProjectGroup>()
  for (const t of todos) {
    const projectTag = t.tags.find(isProjectTag)
    const key = projectTag ?? NO_PROJECT_KEY
    const name = projectTag ? projectFromTag(projectTag) : ''
    if (!groups.has(key)) groups.set(key, { key, name, todos: [] })
    groups.get(key)!.todos.push(t)
  }
  return groups
}

interface Props {
  todos: TodoSummary[]
  totalUnfiltered: { open: number; done: number }
  onToggle: (id: string, done: boolean) => void
  onSelect: (id: string) => void
  onNewTodo: () => void
}

export function TodoList({ todos, totalUnfiltered, onToggle, onSelect, onNewTodo }: Props): JSX.Element {
  const selectedId = useStore((s) => s.todosSelectedId)
  const search = useStore((s) => s.todosSearch)
  const setSearch = useStore((s) => s.setTodosSearch)
  const showCompleted = useStore((s) => s.todosShowCompleted)
  const setShowCompleted = useStore((s) => s.setTodosShowCompleted)
  const selectedTags = useStore((s) => s.todosSelectedTags)
  const setSelectedTags = useStore((s) => s.setTodosSelectedTags)
  const sessionProjectTag = useStore((s) => s.todosSessionProjectTag)

  const sessionFilterActive = sessionProjectTag !== null
    && selectedTags.length === 1
    && selectedTags[0] === sessionProjectTag

  const title = selectedTags.length === 0
    ? 'All todos'
    : selectedTags.length === 1
      ? (isProjectTag(selectedTags[0]) ? projectFromTag(selectedTags[0]) : selectedTags[0])
      : `${selectedTags.length} filters`

  return (
    <section style={{
      display: 'flex', flexDirection: 'column',
      minWidth: 0, minHeight: 0,
      background: 'var(--todos-bg)',
      borderRight: '1px solid var(--todos-border)',
      height: '100%',
    }}>
      <header className="titlebar-drag" style={{
        padding: '12px 20px',
        borderBottom: '1px solid var(--todos-border)',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div className="titlebar-no-drag" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
            <div style={{ fontSize: 12, color: 'var(--todos-text-dim)' }}>
              {totalUnfiltered.open} open · {totalUnfiltered.done} completed
              {sessionFilterActive && (
                <>
                  {' · '}
                  <button
                    onClick={() => setSelectedTags([])}
                    style={{ color: 'var(--todos-accent)', fontSize: 12 }}
                  >
                    Show all
                  </button>
                </>
              )}
            </div>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={onNewTodo} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '5px 10px', borderRadius: 6,
              background: 'var(--todos-accent)', color: '#0b1220',
              fontSize: 12, fontWeight: 500,
              border: '1px solid var(--todos-accent)',
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New
            </button>
          </div>
        </div>

        <div className="titlebar-no-drag" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{
            flex: 1,
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 10px',
            background: 'var(--todos-surface)',
            border: '1px solid var(--todos-border)',
            borderRadius: 6,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--todos-text-faint)', flexShrink: 0 }}>
              <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title and body…"
              style={{ flex: 1, fontSize: 13 }}
            />
          </div>
          <label
            title="Toggle hide completed (H)"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '5px 10px', borderRadius: 6,
              color: 'var(--todos-text-dim)',
              fontSize: 12, cursor: 'pointer', userSelect: 'none',
              border: '1px solid var(--todos-border)',
              background: 'var(--todos-surface)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--todos-surface-2)'; e.currentTarget.style.color = 'var(--todos-text)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--todos-surface)'; e.currentTarget.style.color = 'var(--todos-text-dim)' }}
          >
            <span
              className={`todos-check ${!showCompleted ? 'done' : ''}`}
              style={{ width: 14, height: 14, transform: 'scale(0.9)' }}
              aria-hidden="true"
            />
            <input
              type="checkbox"
              checked={!showCompleted}
              onChange={(e) => setShowCompleted(!e.target.checked)}
              style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}
            />
            Hide completed
          </label>
        </div>
      </header>

      <div className="todos-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <Sections
          todos={todos}
          sessionProjectTag={sessionProjectTag}
          selectedId={selectedId}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      </div>
    </section>
  )
}

function Sections({
  todos, sessionProjectTag, selectedId, onToggle, onSelect,
}: {
  todos: TodoSummary[]
  sessionProjectTag: string | null
  selectedId: string | null
  onToggle: (id: string, done: boolean) => void
  onSelect: (id: string) => void
}): JSX.Element {
  const ordered = useMemo<ProjectGroup[]>(() => {
    const groups = groupByProject(todos)
    const out: ProjectGroup[] = []

    // 1. Current project, if it has any todos in the filtered set.
    if (sessionProjectTag && groups.has(sessionProjectTag)) {
      out.push(groups.get(sessionProjectTag)!)
      groups.delete(sessionProjectTag)
    }

    // 2. Remaining project groups alphabetically.
    const noProject = groups.get(NO_PROJECT_KEY)
    groups.delete(NO_PROJECT_KEY)
    const projectGroups = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
    out.push(...projectGroups)

    // 3. No-project bucket at the end.
    if (noProject) out.push(noProject)

    return out
  }, [todos, sessionProjectTag])

  if (todos.length === 0) return <Empty />

  return (
    <>
      {ordered.map((group) => {
        const isCurrent = group.key === sessionProjectTag
        return (
          <section key={group.key}>
            <SectionHeader
              name={group.name}
              count={group.todos.length}
              isCurrent={isCurrent}
              isNoProject={group.key === NO_PROJECT_KEY}
            />
            {group.todos.map((t) => (
              <Row
                key={t.id}
                todo={t}
                selected={selectedId === t.id}
                onToggle={(done) => onToggle(t.id, done)}
                onSelect={() => onSelect(t.id)}
              />
            ))}
          </section>
        )
      })}
    </>
  )
}

function SectionHeader({
  name, count, isCurrent, isNoProject,
}: { name: string; count: number; isCurrent: boolean; isNoProject: boolean }): JSX.Element {
  const dotColor = isNoProject ? 'var(--todos-text-faint)' : projectColor(name)
  const label = isNoProject ? 'No project' : name
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 20px 6px',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--todos-text-faint)',
        fontWeight: 500,
        background: isCurrent ? 'rgba(122, 162, 247, 0.04)' : 'transparent',
        borderTop: isCurrent ? '1px solid var(--todos-border)' : '1px solid var(--todos-border)',
        position: 'sticky',
        top: 0,
        backdropFilter: 'blur(6px)',
        zIndex: 1,
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: dotColor, flexShrink: 0,
      }} />
      <span style={{ color: isCurrent ? 'var(--todos-text)' : 'var(--todos-text-dim)' }}>{label}</span>
      {isCurrent && (
        <span style={{
          fontSize: 9, padding: '1px 6px', borderRadius: 3,
          background: 'var(--todos-accent)', color: '#0b1220',
          letterSpacing: '0.04em',
        }}>current</span>
      )}
      <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
    </div>
  )
}

function Row({
  todo, selected, onToggle, onSelect,
}: {
  todo: TodoSummary; selected: boolean; onToggle: (done: boolean) => void; onSelect: () => void
}): JSX.Element {
  // Non-project tags only; the project is communicated by the section header.
  const otherTags = todo.tags.filter((t) => !isProjectTag(t))

  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 20px',
        borderBottom: '1px solid var(--todos-border)',
        cursor: 'pointer',
        background: selected ? 'var(--todos-surface-2)' : 'transparent',
        transition: 'background 60ms ease',
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'var(--todos-surface)' }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent' }}
    >
      <button
        className={`todos-check ${todo.done ? 'done' : ''}`}
        title={todo.done ? 'Mark not done' : 'Mark done'}
        onClick={(e) => { e.stopPropagation(); onToggle(!todo.done) }}
      />
      <div style={{
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: todo.done ? 'var(--todos-text-faint)' : 'var(--todos-text)',
        textDecoration: todo.done ? 'line-through' : 'none',
      }}>
        {todo.title || <span style={{ color: 'var(--todos-text-faint)', fontStyle: 'italic' }}>untitled</span>}
      </div>
      {otherTags.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {otherTags.map((tag) => <TagChip key={tag} tag={tag} size="sm" />)}
        </div>
      )}
    </div>
  )
}

function Empty(): JSX.Element {
  return (
    <div style={{
      padding: 40, textAlign: 'center',
      color: 'var(--todos-text-faint)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      marginTop: 40,
    }}>
      <div style={{ fontSize: 14, color: 'var(--todos-text-dim)' }}>Nothing here</div>
      <div style={{ fontSize: 12 }}>Press ⌘N or click New to create a todo.</div>
    </div>
  )
}
