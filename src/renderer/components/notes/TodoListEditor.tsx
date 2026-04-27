import { useEffect, useState, useCallback, useMemo } from 'react'
import { useStore } from '../../store'
import type { TodoListFile, TodoItem, TodoStatus } from './types'
import { TodoStatusBubble, nextStatus } from './TodoStatusBubble'
import { AssigneeChip } from './AssigneeChip'

interface Props {
  relPath: string
}

export function TodoListEditor({ relPath }: Props): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const focusedSessionId = useStore((s) => s.focusedSessionId)

  const [list, setList] = useState<TodoListFile | null>(null)
  const [newText, setNewText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')

  const project = relPath.includes('/') ? relPath.split('/')[0] : null

  const eligibleSessionIds = useMemo(
    () => project
      ? sessions.filter((s) => s.projectName === project).map((s) => s.id)
      : sessions.map((s) => s.id),
    [sessions, project],
  )

  const refresh = useCallback(async () => {
    const l = await window.api.notesReadTodoList(relPath)
    setList(l as TodoListFile)
  }, [relPath])

  useEffect(() => { refresh() }, [refresh])

  const applyStatusChange = useCallback(async (todo: TodoItem, newStatus: TodoStatus) => {
    await window.api.notesSetTodoStatus(relPath, todo.id, newStatus)

    // Silent auto-assign when the item transitions into agent-todo and has no
    // assignee yet. Safe because there's no inter-session message anymore — the
    // ambient hook only reacts to items that *remain* on agent-todo.
    const becameAgentTodo = newStatus === 'agent-todo' && todo.status !== 'agent-todo'
    if (becameAgentTodo && !todo.assignee) {
      const focused = focusedSessionId
        ? sessions.find((s) => s.id === focusedSessionId && (!project || s.projectName === project))
        : null
      const candidate = focused ?? sessions.find((s) => !project || s.projectName === project)
      if (candidate) {
        const storedId = candidate.claudeSessionId ?? candidate.id
        const label = candidate.terminalTitle || candidate.projectName || candidate.id.slice(0, 8)
        await window.api.notesSetTodoAssignee(relPath, todo.id, storedId, label)
      }
    }
    refresh()
  }, [relPath, sessions, focusedSessionId, project, refresh])

  const handleCycle = useCallback((t: TodoItem) => {
    applyStatusChange(t, nextStatus(t.status))
  }, [applyStatusChange])

  const handlePick = useCallback((t: TodoItem, s: TodoStatus) => {
    applyStatusChange(t, s)
  }, [applyStatusChange])

  // Assignment is silent — the assignee learns about it via the UserPromptSubmit
  // ambient-awareness hook on their next turn, which is when they can actually act.
  const handleAssign = useCallback(async (t: TodoItem, sessionId: string | null, label: string | null) => {
    await window.api.notesSetTodoAssignee(relPath, t.id, sessionId, label)
    refresh()
  }, [relPath, refresh])

  const handleAdd = useCallback(async () => {
    const text = newText.trim()
    if (!text) return
    await window.api.notesAddTodo(relPath, text)
    setNewText('')
    refresh()
  }, [newText, relPath, refresh])

  const handleRemove = useCallback(async (id: string) => {
    await window.api.notesRemoveTodo(relPath, id)
    refresh()
  }, [relPath, refresh])

  const commitEdit = useCallback(async () => {
    if (!editingId) return
    const trimmed = editingText.trim()
    if (trimmed) await window.api.notesUpdateTodoText(relPath, editingId, trimmed)
    setEditingId(null); setEditingText('')
    refresh()
  }, [editingId, editingText, relPath, refresh])

  if (!list) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="font-display italic text-sm" style={{ color: 'var(--ink-faint)' }}>loading…</span>
      </div>
    )
  }

  const total = list.todos.length
  const completed = list.todos.filter((t) => t.status === 'completed').length
  const inProgress = list.todos.filter((t) => t.status === 'in-progress').length
  const agentTodos = list.todos.filter((t) => t.status === 'agent-todo').length

  return (
    <div className="h-full flex flex-col ink-fade-in">
      {/* Head */}
      <div className="shrink-0 px-14 pt-10 pb-5">
        <div className="flex items-baseline justify-between mb-4 font-mono-ui text-[10px] smallcaps" style={{ color: 'var(--ink-faint)' }}>
          <span>{project && <>Folio · {project} · </>}Agenda</span>
          <span className="flex items-center gap-4">
            {agentTodos > 0 && <span style={{ color: 'var(--accent)' }}>{agentTodos} agent</span>}
            {inProgress > 0 && <span>{inProgress} active</span>}
            <span>{completed} / {total} struck</span>
          </span>
        </div>
        <h1 className="font-display text-[42px] leading-[1.05] tracking-tight" style={{ color: 'var(--ink)', fontWeight: 400 }}>
          {list.title}
        </h1>
        <div className="mt-3 flex items-center gap-3">
          <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, var(--accent) 0, var(--accent) 36px, var(--rule) 36px, var(--rule-strong))' }} />
          <span className="font-mono-ui text-[10px] smallcaps" style={{ color: 'var(--ink-faint)' }}>
            {new Date(list.updated).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 px-14 pt-2 pb-3">
        <div
          className="flex items-center gap-4 py-2 px-3 rounded-sm transition-colors focus-ink"
          style={{
            background: 'var(--paper-raised)',
            border: '1px solid var(--rule-strong)',
          }}
        >
          <div className="w-[18px] h-[18px] rounded-full shrink-0"
            style={{ border: '1.25px dashed var(--ink-faint)' }} />
          <input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
            placeholder="Jot the next item — press ↵ to inscribe"
            className="note-input flex-1"
          />
          <button
            onClick={handleAdd}
            disabled={!newText.trim()}
            className="font-mono-ui text-[10px] smallcaps ink-press transition-colors shrink-0"
            style={{
              color: newText.trim() ? 'var(--accent)' : 'var(--ink-faint)',
              cursor: newText.trim() ? 'pointer' : 'default',
            }}
          >
            inscribe ↵
          </button>
        </div>
      </div>

      {/* Items */}
      <div className="flex-1 min-h-0 overflow-y-auto notes-scroll px-14 pb-14">
        {total === 0 && (
          <div className="py-8 font-display italic text-base" style={{ color: 'var(--ink-faint)' }}>
            An empty agenda. Jot something above.
          </div>
        )}
        <ol className="space-y-0.5">
          {list.todos.map((t, i) => {
            const done = t.status === 'completed'
            return (
              <li
                key={t.id}
                className="group flex items-start gap-4 py-2.5 relative"
                style={{ borderBottom: '1px solid var(--rule)' }}
              >
                <span
                  className="font-mono-ui text-[10px] shrink-0 pt-1.5 select-none"
                  style={{
                    color: done ? 'var(--ink-faint)' : 'var(--ink-dim)',
                    minWidth: 24,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {String(i + 1).padStart(2, '0')}.
                </span>
                <div className="pt-0.5">
                  <TodoStatusBubble
                    status={t.status}
                    onCycle={() => handleCycle(t)}
                    onPick={(s) => handlePick(t, s)}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  {editingId === t.id ? (
                    <input
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEdit()
                        else if (e.key === 'Escape') { setEditingId(null); setEditingText('') }
                      }}
                      autoFocus
                      className="note-input w-full pb-0.5"
                      style={{ borderBottom: '1px solid var(--accent)' }}
                    />
                  ) : (
                    <span
                      onClick={() => { setEditingId(t.id); setEditingText(t.text) }}
                      className="cursor-text font-display transition-all block"
                      style={{
                        fontSize: 18,
                        lineHeight: 1.55,
                        color: done ? 'var(--ink-faint)' : t.status === 'in-progress' ? 'var(--ink)' : 'var(--ink)',
                        textDecoration: done ? 'line-through' : 'none',
                        textDecorationColor: 'var(--accent-deep)',
                        textDecorationThickness: '1px',
                        fontStyle: t.status === 'agent-todo' ? 'italic' : 'normal',
                      }}
                    >
                      {t.text}
                    </span>
                  )}
                  {/* Chip row — only show for agent-todo / in-progress, or when already assigned */}
                  {(t.status === 'agent-todo' || t.status === 'in-progress' || t.assignee) && (
                    <div className="mt-1.5">
                      <AssigneeChip
                        assignee={t.assignee}
                        assigneeLabel={t.assigneeLabel}
                        eligibleSessionIds={eligibleSessionIds}
                        onAssign={(id, label) => handleAssign(t, id, label)}
                      />
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleRemove(t.id)}
                  className="opacity-0 group-hover:opacity-100 font-mono-ui text-[10px] smallcaps ink-press transition-opacity shrink-0 pt-1"
                  style={{ color: 'var(--ink-faint)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--danger)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ink-faint)')}
                  title="Strike entry"
                >
                  strike
                </button>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
