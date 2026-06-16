import { useEffect, useState, useCallback, useMemo } from 'react'
import { useStore, completedCutoffMs } from '../../store'
import { NotesSidebar } from './NotesSidebar'
import { TodoList } from './TodoList'
import { TodoDetail } from './TodoDetail'
import type { Todo, TodoSummary, TagCount } from './types'

interface Props {
  visible: boolean
  onClose: () => void
}

export function NotesPanel({ visible, onClose }: Props): JSX.Element | null {
  const selectedId = useStore((s) => s.todosSelectedId)
  const setSelectedId = useStore((s) => s.setTodosSelectedId)
  const selectedTags = useStore((s) => s.todosSelectedTags)
  const search = useStore((s) => s.todosSearch)
  const showCompleted = useStore((s) => s.todosShowCompleted)
  const setShowCompleted = useStore((s) => s.setTodosShowCompleted)
  const sessionProjectTag = useStore((s) => s.todosSessionProjectTag)
  const sessions = useStore((s) => s.sessions)
  const detailWidth = useStore((s) => s.todosDetailWidth)
  const setDetailWidth = useStore((s) => s.setTodosDetailWidth)
  const completedFilter = useStore((s) => s.completedFilter)

  // Project tags from currently-active sessions (so projects with no todos yet still appear in pickers).
  const activeProjectTags = useMemo(() => {
    const set = new Set<string>()
    for (const s of sessions) {
      const basename = s.projectPath.split(/[\\/]/).filter(Boolean).pop()
      if (basename) set.add(`project:${basename}`)
    }
    return [...set]
  }, [sessions])

  const [todos, setTodos] = useState<TodoSummary[]>([])
  const [totals, setTotals] = useState<{ all: number; open: number; done: number }>({ all: 0, open: 0, done: 0 })
  const [tags, setTags] = useState<TagCount[]>([])
  const [openTodo, setOpenTodo] = useState<Todo | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  // Load full list (unfiltered) for totals + tag counts.
  const refreshAll = useCallback(async () => {
    const [all, tagList] = await Promise.all([
      window.api.todosList(),
      window.api.todosListTags(),
    ])
    const cutoff = completedCutoffMs(completedFilter)
    const doneVisible = (t: TodoSummary): boolean => t.done && (cutoff == null || Date.parse(t.updated) >= cutoff)
    setTotals({
      all: all.length,
      open: all.filter((t) => !t.done).length,
      done: all.filter(doneVisible).length,
    })
    setTags(tagList)
  }, [completedFilter])

  // Load filtered list for the main view.
  const refreshFiltered = useCallback(async () => {
    const filter: { tags?: string[]; done?: boolean; search?: string } = {}
    if (selectedTags.length > 0) filter.tags = selectedTags
    if (!showCompleted) filter.done = false
    if (search.trim()) filter.search = search.trim()
    const list = await window.api.todosList(filter)
    // Apply the recency window to completed items (open items always show).
    const cutoff = completedCutoffMs(completedFilter)
    setTodos(cutoff == null ? list : list.filter((t) => !t.done || Date.parse(t.updated) >= cutoff))
  }, [selectedTags, showCompleted, search, completedFilter])

  // Load the selected todo's full body.
  const refreshOpenTodo = useCallback(async () => {
    if (!selectedId) { setOpenTodo(null); return }
    try {
      const t = await window.api.todosRead(selectedId)
      setOpenTodo(t)
    } catch {
      setOpenTodo(null)
      setSelectedId(null)
    }
  }, [selectedId, setSelectedId])

  useEffect(() => {
    if (!visible) return
    refreshAll()
    refreshFiltered()
    const unsub = window.api.onNotesChanged(() => {
      refreshAll()
      refreshFiltered()
      refreshOpenTodo()
    })
    return unsub
  }, [visible, refreshAll, refreshFiltered, refreshOpenTodo])

  useEffect(() => { if (visible) refreshFiltered() }, [visible, refreshFiltered])
  useEffect(() => { if (visible) refreshOpenTodo() }, [visible, refreshOpenTodo])

  const handleToggle = useCallback(async (id: string, done: boolean) => {
    await window.api.todosUpdate(id, { done })
    refreshAll()
    refreshFiltered()
    if (id === selectedId) refreshOpenTodo()
  }, [refreshAll, refreshFiltered, refreshOpenTodo, selectedId])

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
  }, [setSelectedId])

  const handleNewTodo = useCallback(async () => {
    const initialTags = sessionProjectTag ? [sessionProjectTag] : []
    const t = await window.api.todosCreate({ title: '', tags: initialTags })
    setSelectedId(t.id)
    setOpenTodo(t)
    refreshAll()
    refreshFiltered()
  }, [sessionProjectTag, setSelectedId, refreshAll, refreshFiltered])

  const handleUpdateTodo = useCallback(async (patch: { title?: string; body?: string; done?: boolean; tags?: string[] }) => {
    if (!selectedId) return
    const updated = await window.api.todosUpdate(selectedId, patch)
    setOpenTodo(updated)
    refreshAll()
    refreshFiltered()
  }, [selectedId, refreshAll, refreshFiltered])

  const handleDeleteRequest = useCallback(() => {
    if (selectedId) setPendingDelete(selectedId)
  }, [selectedId])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    await window.api.todosDelete(pendingDelete)
    if (selectedId === pendingDelete) {
      setSelectedId(null)
      setOpenTodo(null)
    }
    setPendingDelete(null)
    refreshAll()
    refreshFiltered()
  }, [pendingDelete, selectedId, setSelectedId, refreshAll, refreshFiltered])

  // Keyboard. Cmd+N is intentionally NOT bound here — it's the global
  // open-notes hotkey; re-using it would double-fire and auto-create a blank
  // todo on open.
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (pendingDelete) { setPendingDelete(null); return }
        if (selectedId) { setSelectedId(null); return }
        onClose()
        return
      }
      // Single-letter shortcuts only fire when no text field is focused.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      if (e.key.toLowerCase() === 'h') {
        e.preventDefault()
        setShowCompleted(!showCompleted)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [visible, selectedId, pendingDelete, setSelectedId, onClose, showCompleted, setShowCompleted])

  const totalUnfiltered = useMemo(() => ({ open: totals.open, done: totals.done }), [totals])

  if (!visible) return null

  return (
    <div
      className="todos-root"
      style={{
        position: 'fixed', inset: 0, zIndex: 30,
        display: 'grid',
        gridTemplateColumns: openTodo ? `240px 1fr ${detailWidth}px` : '240px 1fr',
        height: '100vh',
      }}
    >
      <NotesSidebar tags={tags} totals={totals} onNewTodo={handleNewTodo} />
      <TodoList
        todos={todos}
        totalUnfiltered={totalUnfiltered}
        onToggle={handleToggle}
        onSelect={handleSelect}
        onNewTodo={handleNewTodo}
      />
      {openTodo && (
        <div style={{ position: 'relative', minWidth: 0, minHeight: 0, height: '100%' }}>
          <DetailResizer width={detailWidth} onChange={setDetailWidth} />
          <TodoDetail
            todo={openTodo}
            allTags={tags}
            activeProjectTags={activeProjectTags}
            onUpdate={handleUpdateTodo}
            onDelete={handleDeleteRequest}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}

      {pendingDelete && (
        <DeleteModal
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
          title={openTodo?.title || 'this todo'}
        />
      )}
    </div>
  )
}

function DetailResizer({
  width, onChange,
}: { width: number; onChange: (w: number) => void }): JSX.Element {
  const startXRef = { current: 0 } as { current: number }
  const startWRef = { current: width } as { current: number }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    startXRef.current = e.clientX
    startWRef.current = width
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)

    const handleMove = (ev: PointerEvent): void => {
      // Dragging left grows the detail pane; right shrinks.
      const dx = startXRef.current - ev.clientX
      onChange(startWRef.current + dx)
    }
    const handleUp = (ev: PointerEvent): void => {
      try { target.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }

  return (
    <div
      onPointerDown={onPointerDown}
      title="Drag to resize"
      style={{
        position: 'absolute',
        left: -3, top: 0, bottom: 0,
        width: 6,
        cursor: 'col-resize',
        zIndex: 5,
        background: 'transparent',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--todos-accent-dim)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    />
  )
}

function DeleteModal({
  onCancel, onConfirm, title,
}: { onCancel: () => void; onConfirm: () => void; title: string }): JSX.Element {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'absolute', inset: 0, zIndex: 40,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 400, padding: 24,
          background: 'var(--todos-surface-2)',
          border: '1px solid var(--todos-border-strong)',
          borderRadius: 8,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Delete this todo?</div>
        <div style={{ fontSize: 13, color: 'var(--todos-text-dim)', marginBottom: 18 }}>
          “{title}” will be permanently removed.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '6px 12px', borderRadius: 6,
              border: '1px solid var(--todos-border)',
              color: 'var(--todos-text-dim)', fontSize: 12,
            }}
          >Cancel</button>
          <button
            onClick={onConfirm}
            style={{
              padding: '6px 12px', borderRadius: 6,
              background: 'var(--todos-danger)', color: '#160a0a',
              fontSize: 12, fontWeight: 500,
            }}
          >Delete</button>
        </div>
      </div>
    </div>
  )
}
