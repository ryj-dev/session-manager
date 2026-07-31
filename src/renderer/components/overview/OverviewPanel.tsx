import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore, type RegistryEntry, type RegistryStatus, type SessionKind } from '../../store'
import { InsightsInbox } from './InsightsInbox'

/**
 * Sessions Overview (Cmd+P)
 *
 * A full-screen overlay (same shell as ScheduledTasksView) listing EVERY live
 * session the app owns, grouped by who owns it. The data is the main-process
 * session registry (src/main/session-registry.ts) — a join of the live PTY
 * table with per-spawn origin tags and hook-derived status — mirrored into the
 * store by 'registry:changed' and re-polled while this panel is open so uptime
 * ticks and dead-PTY zombies surface promptly.
 *
 * Each row can be opened (attach the terminal in its home UI), focused in the
 * surface that owns it (graph / Cmd+J / the pipeline board), or killed. The
 * observer's insights inbox lives at the bottom of the same panel.
 */

const POLL_MS = 2000

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const KIND_BADGE: Record<SessionKind, { label: string; className: string }> = {
  user:      { label: 'graph',     className: 'bg-sky-500/15 text-sky-300' },
  terminal:  { label: 'terminal',  className: 'bg-zinc-500/15 text-zinc-300' },
  scheduled: { label: 'scheduled', className: 'bg-amber-500/15 text-amber-300' },
  pipeline:  { label: 'pipeline',  className: 'bg-violet-500/15 text-violet-300' },
  agent:     { label: 'agent',     className: 'bg-emerald-500/15 text-emerald-300' },
  observer:  { label: 'observer',  className: 'bg-fuchsia-500/15 text-fuchsia-300' },
  preview:   { label: 'preview',   className: 'bg-zinc-500/15 text-zinc-400' },
}

const STATUS_DOT: Record<RegistryStatus, { className: string; pulse: boolean; label: string }> = {
  working:    { className: 'bg-amber-400',  pulse: true,  label: 'working' },
  idle:       { className: 'bg-green-400',  pulse: false, label: 'idle' },
  permission: { className: 'bg-orange-400', pulse: true,  label: 'awaiting permission' },
  zombie:     { className: 'bg-red-400',    pulse: false, label: 'ended (stale)' },
  unknown:    { className: 'bg-zinc-600',   pulse: false, label: 'starting' },
}

/**
 * Where "open" takes each kind of session — or why it cannot.
 *
 * Only kinds with a real home UI are openable. Observer runs are headless and
 * were never added to the renderer's session store, so focusing one used to
 * put the app into focused-view on an id nothing knows about: a blank screen
 * with no way back except Escape. Drawer previews are owned and reaped by the
 * drawer that spawned them; focusing one from here would fight that owner.
 */
const OPEN_TARGET: Partial<Record<SessionKind, string>> = {
  user:      'Focus this session on the graph',
  terminal:  'Focus this terminal on the graph',
  agent:     'Focus this agent session on the graph',
  pipeline:  'Open the pipeline board (⌘L)',
  scheduled: 'Open the scheduled-tasks panel (⌘J)',
}

const NO_OPEN_TARGET: Partial<Record<SessionKind, string>> = {
  observer: 'The observer runs headless — it has no view. Its status and proposals are below.',
  preview:  'A drawer preview — it lives in the drawer that opened it.',
}

/** Compact uptime: 42s / 7m / 3h 12m / 2d 4h. */
function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`
}

/** Short id for the parent-linkage chip — full ids are unreadable in a row. */
function shortId(id: string): string {
  return id.slice(0, 8)
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

interface Section {
  key: string
  title: string
  hint: string
  entries: RegistryEntry[]
  /** Pipeline sections are sub-grouped by task. */
  subGroups?: Array<{ key: string; title: string; entries: RegistryEntry[] }>
}

function buildSections(
  entries: RegistryEntry[],
  pipelineTitles: Map<string, string>,
  scheduleNames: Map<string, string>,
): Section[] {
  const by = (kind: SessionKind): RegistryEntry[] => entries.filter((e) => e.origin.kind === kind)

  const pipeline = by('pipeline')
  const pipelineTasks = new Map<string, RegistryEntry[]>()
  for (const e of pipeline) {
    const key = e.origin.pipelineTaskId ?? 'unknown'
    const list = pipelineTasks.get(key)
    if (list) list.push(e)
    else pipelineTasks.set(key, [e])
  }

  const scheduled = by('scheduled')
  const scheduleGroups = new Map<string, RegistryEntry[]>()
  for (const e of scheduled) {
    const key = e.origin.scheduleId ?? 'unknown'
    const list = scheduleGroups.get(key)
    if (list) list.push(e)
    else scheduleGroups.set(key, [e])
  }

  return [
    {
      key: 'graph',
      title: 'Graph sessions',
      hint: 'Claude sessions you own — what the graph view shows',
      entries: by('user'),
    },
    {
      key: 'pipeline',
      title: 'Pipeline sessions',
      hint: 'Orchestrators and workers, grouped by task (⌘L board)',
      entries: pipeline,
      subGroups: [...pipelineTasks.entries()].map(([taskId, list]) => ({
        key: taskId,
        title: pipelineTitles.get(taskId) ?? `Task ${shortId(taskId)}`,
        // Orchestrator first, then workers in spawn order.
        entries: [...list].sort((a, b) => {
          const ao = a.origin.pipelineRole === 'orchestrator' ? 0 : 1
          const bo = b.origin.pipelineRole === 'orchestrator' ? 0 : 1
          return ao - bo || a.startedAt - b.startedAt
        }),
      })),
    },
    {
      key: 'scheduled',
      title: 'Scheduled task runs',
      hint: 'In-flight runs of your saved schedules (⌘J panel)',
      entries: scheduled,
      subGroups: [...scheduleGroups.entries()].map(([scheduleId, list]) => ({
        key: scheduleId,
        title: scheduleNames.get(scheduleId) ?? list[0]?.origin.scheduleName ?? 'Deleted schedule',
        entries: list,
      })),
    },
    {
      key: 'agents',
      title: 'Spawned agents & terminals',
      hint: 'Agent-gallery sessions and raw shells',
      entries: [...by('agent'), ...by('terminal')].sort((a, b) => b.startedAt - a.startedAt),
    },
    {
      key: 'observer',
      title: 'Background observer',
      hint: 'The curator agent — mines your usage and proposes automations',
      entries: by('observer'),
    },
    // Previews are ephemeral and the ephemeral filter runs before grouping, so
    // this section only ever appears with "Show N preview sessions" on. Omitted
    // entirely when empty rather than showing a permanent "Nothing running".
    ...(by('preview').length > 0
      ? [{
          key: 'preview',
          title: 'Drawer previews',
          hint: 'Throwaway PTYs rendering an existing conversation — closed with the drawer',
          entries: by('preview'),
        }]
      : []),
  ]
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface Props {
  visible: boolean
  onClose: () => void
}

export function OverviewPanel({ visible, onClose }: Props): JSX.Element | null {
  const entries = useStore((s) => s.registryEntries)
  const setRegistryEntries = useStore((s) => s.setRegistryEntries)
  const killRegistrySession = useStore((s) => s.killRegistrySession)
  const pipelineTasks = useStore((s) => s.pipelineTasks)
  const scheduledTasks = useStore((s) => s.scheduledTasks)
  const observerInbox = useStore((s) => s.observerInbox)

  const [confirmKillId, setConfirmKillId] = useState<string | null>(null)
  const [showEphemeral, setShowEphemeral] = useState(false)

  // Poll while open. The 'registry:changed' broadcast (wired in App.tsx) covers
  // spawn/exit/status transitions; the poll is what makes uptime tick and
  // surfaces dead-PTY zombies, which are only computed on read.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const pull = (): void => {
      window.api.registryList().then((list) => {
        if (!cancelled) setRegistryEntries(list as RegistryEntry[])
      }).catch(() => { /* main is shutting down */ })
    }
    pull()
    const timer = setInterval(pull, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [visible, setRegistryEntries])

  // Escape closes the kill confirmation first, then the panel.
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.stopPropagation()
      if (confirmKillId) { setConfirmKillId(null); return }
      onClose()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [visible, confirmKillId, onClose])

  const pipelineTitles = useMemo(
    () => new Map(pipelineTasks.map((t) => [t.id, t.title])),
    [pipelineTasks],
  )
  const scheduleNames = useMemo(
    () => new Map(scheduledTasks.map((t) => [t.id, t.name])),
    [scheduledTasks],
  )

  const visibleEntries = useMemo(
    () => (showEphemeral ? entries : entries.filter((e) => !e.ephemeral)),
    [entries, showEphemeral],
  )
  const sections = useMemo(
    () => buildSections(visibleEntries, pipelineTitles, scheduleNames),
    [visibleEntries, pipelineTitles, scheduleNames],
  )

  const ephemeralCount = entries.length - entries.filter((e) => !e.ephemeral).length

  /** Open a session in the surface that owns it, then close the overview. */
  const focusInHomeUi = useCallback((entry: RegistryEntry) => {
    const store = useStore.getState()
    switch (entry.origin.kind) {
      case 'pipeline':
        store.setPipelineProjectFilter(null)
        store.setActivePanel('pipeline')
        return
      case 'scheduled':
        store.setActivePanel('scheduled')
        return
      case 'observer':
      case 'preview':
        // No home UI — the button is disabled for these (see OPEN_TARGET), so
        // this is only reachable if that ever drifts. Do nothing rather than
        // focus an id the renderer store has never heard of, which lands the
        // app on a blank focused view.
        return
      default:
        // Graph sessions, agents and terminals are real graph/focus targets.
        store.setActivePanel(null)
        store.setFocusedSessionId(entry.id)
        store.setViewMode('focused')
    }
  }, [])

  const handleKill = useCallback(async (id: string) => {
    setConfirmKillId(null)
    await killRegistrySession(id)
    const list = await window.api.registryList().catch(() => null)
    if (list) setRegistryEntries(list as RegistryEntry[])
  }, [killRegistrySession, setRegistryEntries])

  if (!visible) return null

  const total = visibleEntries.length

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-zinc-950 text-zinc-200">
      <header className="flex items-center gap-2.5 border-b border-zinc-800 px-4 py-2">
        <span className="text-[13px] text-zinc-500">◉</span>
        <h1 className="text-[13px] font-semibold tracking-tight text-zinc-100">Sessions Overview</h1>
        <span className="text-[11px] text-zinc-600 tabular-nums">
          {total} live session{total === 1 ? '' : 's'}
        </span>
        {/* titlebar-no-drag: the view-mode titlebar underneath keeps its
            app-region drag strip active through this overlay. */}
        {ephemeralCount > 0 && (
          <button
            onClick={() => setShowEphemeral((v) => !v)}
            className="titlebar-no-drag ml-auto rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
          >
            {showEphemeral ? 'Hide' : 'Show'} {ephemeralCount} preview session{ephemeralCount === 1 ? '' : 's'}
          </button>
        )}
        <span className={`text-[10px] text-zinc-600 ${ephemeralCount > 0 ? '' : 'ml-auto'}`}>Esc close</span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-4xl space-y-6">
          {sections.map((section) => (
            <SectionBlock
              key={section.key}
              section={section}
              observerStatusLine={section.key === 'observer' ? observerInbox?.statusLine ?? null : null}
              onOpen={focusInHomeUi}
              onRequestKill={setConfirmKillId}
            />
          ))}

          {/* The observer's proposals live in the same panel — one place to see
              everything the app is doing on your behalf. */}
          <InsightsInbox />
        </div>
      </div>

      {confirmKillId && (
        <ConfirmKill
          entry={entries.find((e) => e.id === confirmKillId) ?? null}
          onCancel={() => setConfirmKillId(null)}
          onConfirm={() => handleKill(confirmKillId)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section + row
// ---------------------------------------------------------------------------

function SectionBlock({
  section,
  observerStatusLine,
  onOpen,
  onRequestKill,
}: {
  section: Section
  observerStatusLine: string | null
  onOpen: (entry: RegistryEntry) => void
  onRequestKill: (id: string) => void
}): JSX.Element {
  const isEmpty = section.entries.length === 0
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[12px] font-semibold text-zinc-300">{section.title}</h2>
        <span className="text-[10px] text-zinc-600 tabular-nums">{section.entries.length}</span>
        <span className="truncate text-[10px] text-zinc-600">{section.hint}</span>
      </div>

      {/* The observer section shows its schedule even with no live run — that
          "nothing running, next pass in ~2h" state is the useful signal. */}
      {observerStatusLine && (
        <p className="mb-2 rounded border border-zinc-800/80 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-400">
          {observerStatusLine}
        </p>
      )}

      {isEmpty ? (
        !observerStatusLine && (
          <p className="rounded border border-dashed border-zinc-800 px-3 py-2.5 text-[11px] text-zinc-600">
            Nothing running.
          </p>
        )
      ) : section.subGroups ? (
        <div className="space-y-3">
          {section.subGroups.map((group) => (
            <div key={group.key}>
              <div className="mb-1 truncate text-[11px] font-medium text-zinc-400">{group.title}</div>
              <div className="space-y-1">
                {group.entries.map((entry) => (
                  <Row key={entry.id} entry={entry} onOpen={onOpen} onRequestKill={onRequestKill} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          {section.entries.map((entry) => (
            <Row key={entry.id} entry={entry} onOpen={onOpen} onRequestKill={onRequestKill} />
          ))}
        </div>
      )}
    </section>
  )
}

function Row({
  entry,
  onOpen,
  onRequestKill,
}: {
  entry: RegistryEntry
  onOpen: (entry: RegistryEntry) => void
  onRequestKill: (id: string) => void
}): JSX.Element {
  const badge = KIND_BADGE[entry.origin.kind]
  const status = STATUS_DOT[entry.status]
  const isZombie = entry.status === 'zombie'
  const openTarget = OPEN_TARGET[entry.origin.kind]

  return (
    <div className="group flex items-center gap-2.5 rounded border border-zinc-800/70 bg-zinc-900/40 px-3 py-2 hover:border-zinc-700">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.className} ${status.pulse ? 'animate-pulse' : ''}`}
        title={status.label}
      />
      <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-medium ${badge.className}`}>
        {badge.label}
      </span>
      {entry.origin.pipelineRole && entry.origin.pipelineRole !== 'orchestrator' && (
        <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">
          {entry.origin.pipelineRole}
        </span>
      )}

      <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200">{entry.displayName}</span>

      {entry.projectName && (
        <span className="shrink-0 truncate font-mono text-[10px] text-zinc-500" title={entry.projectPath}>
          {entry.projectName}
        </span>
      )}
      {entry.origin.parentSessionId && (
        <span
          className="shrink-0 font-mono text-[10px] text-zinc-600"
          title={`Spawned by session ${entry.origin.parentSessionId}`}
        >
          ↳{shortId(entry.origin.parentSessionId)}
        </span>
      )}
      <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-500">
        {isZombie ? '—' : fmtUptime(entry.uptimeMs)}
      </span>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          disabled={isZombie || !openTarget}
          onClick={() => onOpen(entry)}
          className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
          title={openTarget ?? NO_OPEN_TARGET[entry.origin.kind]}
        >open</button>
        <button
          disabled={isZombie}
          onClick={() => onRequestKill(entry.id)}
          className="rounded px-1.5 py-0.5 text-[10px] text-red-400/80 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-30"
          title="Kill this session"
        >kill</button>
      </div>
    </div>
  )
}

function ConfirmKill({
  entry,
  onCancel,
  onConfirm,
}: {
  entry: RegistryEntry | null
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element | null {
  if (!entry) return null
  const isPipeline = entry.origin.kind === 'pipeline'
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
        <h2 className="mb-2 text-[13px] font-medium text-zinc-200">Kill this session?</h2>
        <p className="mb-1 text-[11px] text-zinc-400">
          <span className="text-zinc-200">{entry.displayName}</span>
          {entry.projectName ? ` · ${entry.projectName}` : ''}
        </p>
        <p className="mb-4 text-[11px] text-zinc-500">
          {isPipeline
            ? 'Its in-flight turn is lost, but the task stays on the board and its conversation can be resumed.'
            : 'The PTY is terminated. Anything the session was mid-way through is lost.'}
        </p>
        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-[11px] font-medium text-white hover:bg-red-500"
          >Kill session</button>
          <button
            onClick={onCancel}
            className="flex-1 rounded-lg bg-zinc-800 px-3 py-2 text-[11px] font-medium text-zinc-300 hover:bg-zinc-700"
          >Cancel</button>
        </div>
      </div>
    </div>
  )
}
