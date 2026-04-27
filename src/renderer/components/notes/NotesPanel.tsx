import { useEffect, useState, useCallback, useMemo } from 'react'
import { useStore } from '../../store'
import { NotesSidebar } from './NotesSidebar'
import { NoteEditor } from './NoteEditor'
import { TodoListEditor } from './TodoListEditor'
import { GlobalTodoView } from './GlobalTodoView'
import type { NoteEntry } from './types'

interface Props {
  visible: boolean
  onClose: () => void
}

export function NotesPanel({ visible, onClose }: Props): JSX.Element | null {
  const sessions = useStore((s) => s.sessions)
  const notesView = useStore((s) => s.notesView)
  const setNotesView = useStore((s) => s.setNotesView)
  const projectFilter = useStore((s) => s.notesProjectFilter)
  const selectedPath = useStore((s) => s.notesSelectedPath)
  const setSelectedPath = useStore((s) => s.setNotesSelectedPath)

  const zoom = useStore((s) => s.notesZoom)
  const setZoom = useStore((s) => s.setNotesZoom)

  const [entries, setEntries] = useState<NoteEntry[]>([])
  const [projects, setProjects] = useState<Array<{ name: string; manual: boolean }>>([])
  const [pendingCreate, setPendingCreate] = useState<{ project: string | null; kind: 'note' | 'todo-list' } | null>(null)
  const [pendingName, setPendingName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [pendingProject, setPendingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')

  const refresh = useCallback(async () => {
    const [eList, pList] = await Promise.all([
      window.api.notesListEntries(),
      window.api.notesListProjectsDetailed(),
    ])
    // Ensure every folio has its pinned agenda. Idempotent on the main side.
    await Promise.all(pList.map((p) => window.api.notesGetOrCreateAgenda(p.name).catch(() => null)))
    const freshEntries = await window.api.notesListEntries()
    setEntries(freshEntries as NoteEntry[])
    setProjects(pList)
  }, [])

  useEffect(() => {
    if (!visible) return
    refresh()
    const unsub = window.api.onNotesChanged(() => refresh())
    return unsub
  }, [visible, refresh])

  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent): void => {
      const isMac = navigator.platform.startsWith('Mac')
      const meta = isMac ? e.metaKey : e.ctrlKey
      // Zoom controls — Cmd+= / Cmd++ / Cmd+- / Cmd+0
      if (meta && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        setZoom(zoom + 0.1)
        return
      }
      if (meta && e.key === '-') {
        e.preventDefault()
        setZoom(zoom - 0.1)
        return
      }
      if (meta && e.key === '0') {
        e.preventDefault()
        setZoom(1.15)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (pendingCreate) { setPendingCreate(null); return }
        if (pendingDelete) { setPendingDelete(null); return }
        if (pendingProject) { setPendingProject(false); return }
        if (selectedPath) { setSelectedPath(null); return }
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [visible, selectedPath, pendingCreate, pendingDelete, pendingProject, setSelectedPath, onClose, zoom, setZoom])

  const activeProjects = useMemo(() => {
    const set = new Set<string>()
    for (const s of sessions) {
      const name = s.projectPath.split(/[\\/]/).filter(Boolean).pop()
      if (name) set.add(name)
    }
    return set
  }, [sessions])

  const handleSelect = useCallback((relPath: string) => {
    setSelectedPath(relPath)
    setNotesView('project')
  }, [setSelectedPath, setNotesView])

  const handleCreate = useCallback((project: string | null, kind: 'note' | 'todo-list') => {
    // Only the 'note' kind is user-creatable now; each folio has one pinned agenda already.
    setPendingCreate({ project, kind: 'note' })
    setPendingName('Untitled')
  }, [])

  const confirmCreate = useCallback(async () => {
    if (!pendingCreate) return
    const name = pendingName.trim()
    if (!name) { setPendingCreate(null); return }
    const rel = await window.api.notesCreateNote({ project: pendingCreate.project, name, kind: pendingCreate.kind })
    setPendingCreate(null)
    setPendingName('')
    setSelectedPath(rel)
    setNotesView('project')
    refresh()
  }, [pendingCreate, pendingName, refresh, setSelectedPath, setNotesView])

  const handleDeleteRequest = useCallback((relPath: string) => {
    setPendingDelete(relPath)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    await window.api.notesDelete(pendingDelete)
    if (selectedPath === pendingDelete) setSelectedPath(null)
    setPendingDelete(null)
    refresh()
  }, [pendingDelete, refresh, selectedPath, setSelectedPath])

  const confirmNewProject = useCallback(async () => {
    const name = newProjectName.trim()
    if (!name) { setPendingProject(false); return }
    await window.api.notesEnsureProject(name, { manual: true })
    setPendingProject(false)
    setNewProjectName('')
    refresh()
  }, [newProjectName, refresh])

  const handleOpenGlobal = useCallback(() => {
    setNotesView('global')
    setSelectedPath(null)
  }, [setNotesView, setSelectedPath])

  if (!visible) return null

  const displayedEntries = notesView === 'project' && projectFilter
    ? entries.filter((e) => e.project === projectFilter || e.project === null)
    : entries

  const selectedEntry = selectedPath ? entries.find((e) => e.relPath === selectedPath) : null

  const now = new Date()
  const dateLine = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <div
      className="fixed inset-0 z-30 flex flex-col notes-surface notes-grain"
      style={{ zoom }}
    >
      {/* Masthead */}
      <header className="titlebar-drag shrink-0 relative z-10 pl-20 pr-6" style={{ borderBottom: '1px solid var(--rule-strong)' }}>
        <div className="titlebar-no-drag flex items-baseline justify-between py-3">
          <div className="flex items-baseline gap-5">
            <h1 className="font-display text-[22px] leading-none tracking-tight" style={{ fontWeight: 400, color: 'var(--ink)' }}>
              <span style={{ color: 'var(--accent)' }}>❦</span>{' '}
              <span className="italic">The</span>{' '}
              <span className="smallcaps" style={{ fontVariant: 'all-small-caps', letterSpacing: '0.08em' }}>Ledger</span>
            </h1>
            <span className="font-mono-ui text-[10px] smallcaps" style={{ color: 'var(--ink-faint)' }}>
              {dateLine}
            </span>
          </div>
          <nav className="flex items-center gap-6 font-mono-ui text-[10px] smallcaps">
            <button
              onClick={() => { setNotesView('project'); setSelectedPath(null) }}
              className="ink-press transition-colors"
              style={{
                color: notesView === 'project' && !selectedPath ? 'var(--accent)' : 'var(--ink-dim)',
                borderBottom: notesView === 'project' && !selectedPath ? '1px solid var(--accent)' : '1px solid transparent',
                paddingBottom: 2,
              }}
            >
              Folio{projectFilter ? ` · ${projectFilter}` : ''}
            </button>
            <button
              onClick={handleOpenGlobal}
              className="ink-press transition-colors"
              style={{
                color: notesView === 'global' ? 'var(--accent)' : 'var(--ink-dim)',
                borderBottom: notesView === 'global' ? '1px solid var(--accent)' : '1px solid transparent',
                paddingBottom: 2,
              }}
            >
              Compendium
            </button>
            <div className="flex items-center gap-1" style={{ color: 'var(--ink-faint)' }}>
              <button
                onClick={() => setZoom(zoom - 0.1)}
                className="ink-press hover:brightness-150 px-1"
                title="Zoom out (⌘−)"
              >
                −
              </button>
              <button
                onClick={() => setZoom(1.15)}
                className="ink-press hover:brightness-150 px-1 font-mono-ui"
                style={{ minWidth: 34, textAlign: 'center' }}
                title="Reset zoom (⌘0)"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                onClick={() => setZoom(zoom + 0.1)}
                className="ink-press hover:brightness-150 px-1"
                title="Zoom in (⌘+)"
              >
                +
              </button>
            </div>
            <button
              onClick={onClose}
              className="ink-press transition-colors"
              style={{ color: 'var(--ink-faint)' }}
            >
              ⎋ Close
            </button>
          </nav>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex relative z-[1]">
        <aside className="w-[280px] shrink-0 paper-sidebar overflow-y-auto notes-scroll relative"
          style={{ borderRight: '1px solid var(--rule-strong)' }}>
          <NotesSidebar
            entries={displayedEntries}
            projects={projects}
            activeProjects={activeProjects}
            onSelect={handleSelect}
            onOpenGlobal={handleOpenGlobal}
            onCreateNote={handleCreate}
            onDelete={handleDeleteRequest}
            onNewProject={() => { setPendingProject(true); setNewProjectName('') }}
          />
        </aside>

        <main className="flex-1 min-w-0 min-h-0 overflow-hidden relative">
          {notesView === 'global' && !selectedPath ? (
            <GlobalTodoView onOpenList={(p) => { setSelectedPath(p); setNotesView('project') }} />
          ) : selectedEntry ? (
            selectedEntry.kind === 'note'
              ? <NoteEditor key={selectedEntry.relPath} relPath={selectedEntry.relPath} />
              : <TodoListEditor key={selectedEntry.relPath} relPath={selectedEntry.relPath} />
          ) : (
            <EmptyCanvas />
          )}
        </main>
      </div>

      {pendingCreate && (
        <Modal onClose={() => setPendingCreate(null)} title={`New ${pendingCreate.kind === 'note' ? 'entry' : 'agenda'}`}
          subtitle={pendingCreate.project ? `Filed under ${pendingCreate.project}` : 'At the root of the ledger'}>
          <input
            autoFocus
            value={pendingName}
            onChange={(e) => setPendingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmCreate()
              else if (e.key === 'Escape') setPendingCreate(null)
            }}
            className="note-input w-full focus-ink text-xl pb-1"
            style={{ borderBottom: '1px solid var(--rule-strong)' }}
          />
          <div className="flex justify-end gap-5 mt-5 font-mono-ui text-[10px] smallcaps">
            <button onClick={() => setPendingCreate(null)} className="ink-press" style={{ color: 'var(--ink-dim)' }}>
              Discard
            </button>
            <button onClick={confirmCreate} className="ink-press" style={{ color: 'var(--accent)' }}>
              Commit ↵
            </button>
          </div>
        </Modal>
      )}

      {pendingDelete && (
        <Modal onClose={() => setPendingDelete(null)} title="Strike from the record?" subtitle="This cannot be undone.">
          <div className="font-mono-ui text-xs p-3 rounded" style={{ background: 'var(--paper-raised)', color: 'var(--ink-dim)', border: '1px solid var(--rule-strong)' }}>
            {pendingDelete}
          </div>
          <div className="flex justify-end gap-5 mt-5 font-mono-ui text-[10px] smallcaps">
            <button onClick={() => setPendingDelete(null)} className="ink-press" style={{ color: 'var(--ink-dim)' }}>
              Keep
            </button>
            <button onClick={confirmDelete} className="ink-press" style={{ color: 'var(--danger)' }}>
              Strike ✕
            </button>
          </div>
        </Modal>
      )}

      {pendingProject && (
        <Modal onClose={() => setPendingProject(false)} title="Open a new folio" subtitle="A place to gather related entries.">
          <input
            autoFocus
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmNewProject()
              else if (e.key === 'Escape') setPendingProject(false)
            }}
            placeholder="folio-name"
            className="note-input w-full focus-ink text-xl pb-1"
            style={{ borderBottom: '1px solid var(--rule-strong)' }}
          />
          <div className="flex justify-end gap-5 mt-5 font-mono-ui text-[10px] smallcaps">
            <button onClick={() => setPendingProject(false)} className="ink-press" style={{ color: 'var(--ink-dim)' }}>
              Cancel
            </button>
            <button onClick={confirmNewProject} className="ink-press" style={{ color: 'var(--accent)' }}>
              Open ↵
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function EmptyCanvas(): JSX.Element {
  return (
    <div className="h-full flex items-center justify-center relative">
      <div className="text-center ink-fade-in" style={{ maxWidth: 420 }}>
        <div className="font-display italic text-[48px] leading-none mb-4" style={{ color: 'var(--ink-faint)' }}>❦</div>
        <p className="font-display italic text-lg mb-2" style={{ color: 'var(--ink-dim)' }}>
          A blank page awaits.
        </p>
        <p className="font-mono-ui text-[11px] smallcaps" style={{ color: 'var(--ink-faint)' }}>
          Select an entry from the margin, or open a new folio.
        </p>
      </div>
    </div>
  )
}

function Modal({
  children,
  onClose,
  title,
  subtitle,
}: {
  children: React.ReactNode
  onClose: () => void
  title: string
  subtitle?: string
}): JSX.Element {
  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center"
      style={{ background: 'rgba(5, 4, 3, 0.75)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="p-8 w-[480px] ink-fade-in relative"
        style={{
          background: 'var(--paper-raised)',
          border: '1px solid var(--rule-strong)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(212, 165, 116, 0.05)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute top-0 left-0 right-0 h-[2px]" style={{ background: 'linear-gradient(to right, transparent, var(--accent) 50%, transparent)' }} />
        <div className="mb-5">
          <h2 className="font-display text-2xl italic mb-1" style={{ color: 'var(--ink)' }}>{title}</h2>
          {subtitle && (
            <p className="font-mono-ui text-[10px] smallcaps" style={{ color: 'var(--ink-faint)' }}>{subtitle}</p>
          )}
        </div>
        {children}
      </div>
    </div>
  )
}
