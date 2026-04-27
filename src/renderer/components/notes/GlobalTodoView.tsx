import { useEffect, useMemo, useState, useCallback } from 'react'
import { useStore } from '../../store'
import type { AggregatedTodo, TodoStatus } from './types'
import { TodoStatusBubble, nextStatus } from './TodoStatusBubble'
import { AssigneeChip } from './AssigneeChip'

interface Props {
  onOpenList: (relPath: string) => void
}

type GroupBy = 'project' | 'status' | 'assignee'
type StatusFilter = 'all' | TodoStatus
type AssigneeFilter = 'all' | 'mine' | 'unassigned'

const STATUS_LABEL: Record<TodoStatus, string> = {
  'not-started': 'unstarted',
  'agent-todo': 'agent todo',
  'in-progress': 'in progress',
  'completed': 'completed',
}

export function GlobalTodoView({ onOpenList }: Props): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const focusedSessionId = useStore((s) => s.focusedSessionId)

  const [items, setItems] = useState<AggregatedTodo[]>([])
  const [groupBy, setGroupBy] = useState<GroupBy>('project')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>('all')
  const [hideCompleted, setHideCompleted] = useState(true)

  const refresh = useCallback(async () => {
    const all = await window.api.notesListAllTodos() as AggregatedTodo[]
    setItems(all)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleCycle = useCallback(async (item: AggregatedTodo) => {
    const next = nextStatus(item.todo.status)
    await window.api.notesSetTodoStatus(item.listRelPath, item.todo.id, next)
    refresh()
  }, [refresh])

  const handlePick = useCallback(async (item: AggregatedTodo, s: TodoStatus) => {
    await window.api.notesSetTodoStatus(item.listRelPath, item.todo.id, s)
    refresh()
  }, [refresh])

  const handleAssign = useCallback(async (item: AggregatedTodo, sessionId: string | null, label: string | null) => {
    await window.api.notesSetTodoAssignee(item.listRelPath, item.todo.id, sessionId, label)
    refresh()
  }, [refresh])

  // Filter
  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (hideCompleted && it.todo.status === 'completed') return false
      if (statusFilter !== 'all' && it.todo.status !== statusFilter) return false
      if (assigneeFilter === 'mine' && it.todo.assignee !== focusedSessionId) return false
      if (assigneeFilter === 'unassigned' && it.todo.assignee) return false
      return true
    })
  }, [items, hideCompleted, statusFilter, assigneeFilter, focusedSessionId])

  // Group
  const groups = useMemo(() => {
    const m = new Map<string, AggregatedTodo[]>()
    for (const it of filtered) {
      let key: string
      if (groupBy === 'project') key = it.project ?? '—'
      else if (groupBy === 'status') key = STATUS_LABEL[it.todo.status]
      else {
        const sess = it.todo.assignee ? sessions.find((s) => s.id === it.todo.assignee) : null
        key = sess
          ? (sess.terminalTitle || sess.projectName || sess.id.slice(0, 8))
          : it.todo.assignee
            ? (it.todo.assigneeLabel || it.todo.assignee.slice(0, 8))
            : 'unassigned'
      }
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(it)
    }
    return m
  }, [filtered, groupBy, sessions])

  const totalOpen = items.filter((i) => i.todo.status !== 'completed').length
  const totalDone = items.filter((i) => i.todo.status === 'completed').length
  const totalAgent = items.filter((i) => i.todo.status === 'agent-todo').length

  return (
    <div className="h-full flex flex-col ink-fade-in">
      {/* Head */}
      <div className="shrink-0 px-14 pt-10 pb-5">
        <div className="mb-4 font-mono-ui text-[10px] smallcaps" style={{ color: 'var(--ink-faint)' }}>
          Index · all folios
        </div>
        <h1 className="font-display text-[48px] leading-[1.05] tracking-tight" style={{ color: 'var(--ink)', fontWeight: 400 }}>
          <span className="italic">The</span> Compendium
        </h1>
        <div className="mt-3 flex items-center gap-4 font-mono-ui text-[11px]">
          <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, var(--accent) 0, var(--accent) 48px, var(--rule) 48px, var(--rule-strong))' }} />
          <span style={{ color: 'var(--ink-dim)' }}>
            <span style={{ color: 'var(--accent)' }}>{totalOpen}</span> open
          </span>
          {totalAgent > 0 && (
            <>
              <span style={{ color: 'var(--ink-faint)' }}>·</span>
              <span style={{ color: 'var(--accent)' }}>{totalAgent} agent</span>
            </>
          )}
          <span style={{ color: 'var(--ink-faint)' }}>·</span>
          <span style={{ color: 'var(--ink-faint)' }}>{totalDone} struck</span>
        </div>

        {/* Filter bar */}
        <div className="mt-5 flex flex-wrap items-center gap-4 font-mono-ui text-[10px] smallcaps"
          style={{ color: 'var(--ink-faint)' }}>
          <FilterGroup label="group by">
            {(['project', 'status', 'assignee'] as GroupBy[]).map((g) => (
              <Chip key={g} active={groupBy === g} onClick={() => setGroupBy(g)}>{g}</Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="status">
            <Chip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>all</Chip>
            {(['not-started', 'agent-todo', 'in-progress', 'completed'] as TodoStatus[]).map((s) => (
              <Chip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
                {STATUS_LABEL[s]}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="assignee">
            <Chip active={assigneeFilter === 'all'} onClick={() => setAssigneeFilter('all')}>any</Chip>
            <Chip active={assigneeFilter === 'mine'} onClick={() => setAssigneeFilter('mine')}>mine</Chip>
            <Chip active={assigneeFilter === 'unassigned'} onClick={() => setAssigneeFilter('unassigned')}>unassigned</Chip>
          </FilterGroup>

          <label className="flex items-center gap-2 cursor-pointer ml-auto">
            <input
              type="checkbox"
              checked={!hideCompleted}
              onChange={(e) => setHideCompleted(!e.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            show struck
          </label>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto notes-scroll px-14 pb-14">
        {groups.size === 0 && (
          <div className="py-12 text-center">
            <div className="font-display italic text-[32px] mb-2" style={{ color: 'var(--ink-faint)' }}>❦</div>
            <p className="font-display italic text-base" style={{ color: 'var(--ink-faint)' }}>
              Nothing to attend to.
            </p>
          </div>
        )}

        {[...groups.entries()].map(([groupKey, todos], idx) => {
          const roman = toRoman(idx + 1)

          // For project-grouping, also subdivide by list.
          const byList = groupBy === 'project'
            ? (() => {
                const m = new Map<string, AggregatedTodo[]>()
                for (const t of todos) {
                  if (!m.has(t.listRelPath)) m.set(t.listRelPath, [])
                  m.get(t.listRelPath)!.push(t)
                }
                return m
              })()
            : null

          return (
            <section key={groupKey} className="mb-10">
              <header className="flex items-baseline gap-4 mb-4">
                <span className="font-display italic text-[14px]" style={{ color: 'var(--ink-faint)' }}>
                  {roman}.
                </span>
                <h2 className="font-display text-[22px] tracking-tight" style={{ color: 'var(--ink)' }}>
                  {groupKey}
                </h2>
                <div className="flex-1 h-px mx-2" style={{ background: 'var(--rule-strong)', alignSelf: 'center' }} />
                <span className="font-mono-ui text-[10px] smallcaps" style={{ color: 'var(--ink-faint)' }}>
                  {todos.length} {todos.length === 1 ? 'entry' : 'entries'}
                </span>
              </header>

              <div className="pl-8 space-y-5">
                {byList
                  ? [...byList.entries()].map(([listPath, listTodos]) => (
                      <ListGroup
                        key={listPath}
                        listPath={listPath}
                        listTitle={listTodos[0].listTitle}
                        todos={listTodos}
                        onOpen={() => onOpenList(listPath)}
                        onCycle={handleCycle}
                        onPick={handlePick}
                        onAssign={handleAssign}
                      />
                    ))
                  : (
                      <FlatRows
                        todos={todos}
                        onCycle={handleCycle}
                        onPick={handlePick}
                        onAssign={handleAssign}
                        onOpenList={onOpenList}
                      />
                    )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span>{label}:</span>
      <div className="flex gap-1.5">{children}</div>
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="ink-press px-2 py-0.5 transition-all"
      style={{
        color: active ? 'var(--paper)' : 'var(--ink-dim)',
        background: active ? 'var(--accent)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--rule-strong)'}`,
        borderRadius: 999,
        fontSize: 'inherit',
        letterSpacing: 'inherit',
      }}
    >
      {children}
    </button>
  )
}

function ListGroup({
  listPath, listTitle, todos, onOpen, onCycle, onPick, onAssign,
}: {
  listPath: string; listTitle: string; todos: AggregatedTodo[]; onOpen: () => void
  onCycle: (t: AggregatedTodo) => void
  onPick: (t: AggregatedTodo, s: TodoStatus) => void
  onAssign: (t: AggregatedTodo, id: string | null, label: string | null) => void
}): JSX.Element {
  return (
    <div>
      <button onClick={onOpen} className="group inline-flex items-baseline gap-2 mb-2 ink-press">
        <span className="font-mono-ui text-[10px] smallcaps" style={{ color: 'var(--ink-faint)' }}>Agenda</span>
        <span
          className="font-display italic text-[16px] transition-colors"
          style={{ color: 'var(--ink-dim)' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ink-dim)')}
        >
          {listTitle}
        </span>
        <span className="font-mono-ui text-[9px] opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ color: 'var(--accent)' }}>⟶ open</span>
      </button>
      <FlatRows todos={todos} onCycle={onCycle} onPick={onPick} onAssign={onAssign} listPath={listPath} />
    </div>
  )
}

function FlatRows({
  todos, onCycle, onPick, onAssign, onOpenList, listPath,
}: {
  todos: AggregatedTodo[]
  onCycle: (t: AggregatedTodo) => void
  onPick: (t: AggregatedTodo, s: TodoStatus) => void
  onAssign: (t: AggregatedTodo, id: string | null, label: string | null) => void
  onOpenList?: (rel: string) => void
  listPath?: string
}): JSX.Element {
  return (
    <ul className="space-y-0.5">
      {todos.map((it, i) => {
        const done = it.todo.status === 'completed'
        return (
          <li
            key={`${it.listRelPath}:${it.todo.id}`}
            className="flex items-start gap-4 py-2 group"
            style={{ borderBottom: '1px solid var(--rule)' }}
          >
            <span className="font-mono-ui text-[10px] shrink-0 pt-1.5" style={{
              color: 'var(--ink-faint)', minWidth: 22, fontVariantNumeric: 'tabular-nums',
            }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <div className="pt-0.5">
              <TodoStatusBubble
                status={it.todo.status}
                onCycle={() => onCycle(it)}
                onPick={(s) => onPick(it, s)}
                size={16}
              />
            </div>
            <div className="flex-1 min-w-0">
              <span
                className="font-display block"
                style={{
                  fontSize: 16.5, lineHeight: 1.55,
                  color: done ? 'var(--ink-faint)' : 'var(--ink)',
                  textDecoration: done ? 'line-through' : 'none',
                  textDecorationColor: 'var(--accent-deep)',
                  fontStyle: it.todo.status === 'agent-todo' ? 'italic' : 'normal',
                }}
              >
                {it.todo.text}
              </span>
              <div className="mt-1 flex items-center gap-2">
                {(it.todo.status === 'agent-todo' || it.todo.status === 'in-progress' || it.todo.assignee) && (
                  <AssigneeChip
                    assignee={it.todo.assignee}
                    assigneeLabel={it.todo.assigneeLabel}
                    onAssign={(id, label) => onAssign(it, id, label)}
                  />
                )}
                {onOpenList && (
                  <button
                    onClick={() => onOpenList(it.listRelPath)}
                    className="font-mono-ui text-[9px] smallcaps ink-press opacity-60 hover:opacity-100 transition-opacity"
                    style={{ color: 'var(--ink-faint)' }}
                  >
                    {it.project ? `${it.project} · ` : ''}{it.listTitle} ⟶
                  </button>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function toRoman(n: number): string {
  const map: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ]
  let out = ''
  for (const [v, s] of map) {
    while (n >= v) { out += s; n -= v }
  }
  return out
}
