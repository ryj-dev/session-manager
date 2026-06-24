import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../../store'
import { Terminal, disposeTerminal } from '../Terminal'
import type { ScheduledTask, ScheduleRun, ScheduleRecurrence, ScheduleRunStatus } from '../../store'

/**
 * Scheduled Tasks (Cmd+J)
 *
 * A full-screen overlay (modeled on PipelineView's shell) for managing the
 * scheduled-task definitions owned by the main-process scheduler. The list is a
 * renderer mirror of the main store, kept fresh by the 'schedules:changed'
 * broadcast wired in App.tsx — this view never fetches, it just reads
 * `scheduledTasks` and calls the create/update/delete/run-now store actions.
 *
 * A finished run can be re-opened: clicking it resumes the saved Claude
 * conversation into an ephemeral PTY (mirroring PipelineView's
 * SessionTerminalPane), mounted in a drawer.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Human one-line summary of when a schedule fires. */
function summarizeSchedule(t: ScheduledTask): string {
  const parts: string[] = []
  if (t.onLaunch) parts.push('At launch')
  if (t.recurrence.kind === 'interval') parts.push(`Every ${t.recurrence.minutes} min`)
  else if (t.recurrence.kind === 'daily') parts.push(`Daily ${pad2(t.recurrence.hour)}:${pad2(t.recurrence.minute)}`)
  return parts.length ? parts.join(' · ') : 'Manual (run now only)'
}

function fmtTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

/** mm:ss elapsed between two ISO timestamps; '—' while still in-flight. */
function fmtDuration(start: string, end?: string): string {
  if (!end) return '—'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.round(ms / 1000)
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`
}

const RUN_STATUS: Record<ScheduleRunStatus, { dot: string; chip: string; label: string; pulse: boolean }> = {
  working: { dot: 'bg-amber-400', chip: 'bg-amber-500/15 text-amber-300', label: 'working', pulse: true },
  done:    { dot: 'bg-green-400', chip: 'bg-green-500/15 text-green-300', label: 'done',    pulse: false },
  error:   { dot: 'bg-red-400',   chip: 'bg-red-500/15 text-red-300',     label: 'error',   pulse: false },
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

interface Props {
  visible: boolean
  onClose: () => void
}

export function ScheduledTasksView({ visible, onClose }: Props): JSX.Element | null {
  const scheduledTasks = useStore((s) => s.scheduledTasks)
  const createScheduledTask = useStore((s) => s.createScheduledTask)
  const updateScheduledTask = useStore((s) => s.updateScheduledTask)
  const deleteScheduledTask = useStore((s) => s.deleteScheduledTask)
  const setScheduledTaskEnabled = useStore((s) => s.setScheduledTaskEnabled)
  const runScheduledTaskNow = useStore((s) => s.runScheduledTaskNow)
  const baseProjectsDir = useStore((s) => s.baseProjectsDir)

  // null = closed, 'new' = create form, a task = edit form.
  const [editing, setEditing] = useState<ScheduledTask | 'new' | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  // A clicked finished run → resume drawer.
  const [openRun, setOpenRun] = useState<{ task: ScheduledTask; run: ScheduleRun } | null>(null)

  // Capture-phase Escape: close the innermost layer one per press
  // (run drawer → form → view). Mirrors PipelineView's handler.
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return
        e.stopPropagation()
        if (openRun) { setOpenRun(null); return }
        if (editing) { setEditing(null); return }
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [visible, openRun, editing, onClose])

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-zinc-950 text-zinc-200">
      {/* Header */}
      <header className="flex items-center gap-2.5 border-b border-zinc-800 px-4 py-2">
        <ClockGlyph />
        <h1 className="text-[13px] font-semibold tracking-tight text-zinc-100">Scheduled Tasks</h1>
        <button
          onClick={() => setEditing('new')}
          className="ml-auto rounded bg-sky-500/15 px-2.5 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25"
        >+ New schedule</button>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {scheduledTasks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <span className="text-2xl text-zinc-700">⧖</span>
            <p className="text-[13px] text-zinc-400">No scheduled tasks yet</p>
            <button
              onClick={() => setEditing('new')}
              className="rounded bg-sky-500/15 px-3 py-1.5 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25"
            >Create your first schedule</button>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-3">
            {scheduledTasks.map((task) => (
              <ScheduleCard
                key={task.id}
                task={task}
                expanded={expandedIds.has(task.id)}
                onToggleExpand={() => toggleExpand(task.id)}
                onRunNow={() => runScheduledTaskNow(task.id)}
                onEdit={() => setEditing(task)}
                onDelete={() => { if (window.confirm(`Delete schedule "${task.name}"?`)) deleteScheduledTask(task.id) }}
                onToggleEnabled={(enabled) => setScheduledTaskEnabled(task.id, enabled)}
                onOpenRun={(run) => setOpenRun({ task, run })}
              />
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {editing && (
          <ScheduleFormDrawer
            key={editing === 'new' ? 'new' : editing.id}
            task={editing === 'new' ? null : editing}
            baseProjectsDir={baseProjectsDir}
            onClose={() => setEditing(null)}
            onSubmit={(data) => {
              if (editing === 'new') createScheduledTask(data)
              else updateScheduledTask(editing.id, data)
              setEditing(null)
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {openRun && (
          <RunTerminalDrawer
            key={openRun.run.id}
            task={openRun.task}
            run={openRun.run}
            onClose={() => setOpenRun(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Schedule card
// ---------------------------------------------------------------------------

function ScheduleCard({
  task, expanded, onToggleExpand, onRunNow, onEdit, onDelete, onToggleEnabled, onOpenRun,
}: {
  task: ScheduledTask
  expanded: boolean
  onToggleExpand: () => void
  onRunNow: () => void
  onEdit: () => void
  onDelete: () => void
  onToggleEnabled: (enabled: boolean) => void
  onOpenRun: (run: ScheduleRun) => void
}): JSX.Element {
  const lastRun = task.runs.at(-1)
  const hasRuns = task.runs.length > 0

  return (
    <div className="group rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-zinc-100">{task.name}</span>
            {!task.enabled && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-500">disabled</span>}
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">{task.projectPath}</p>
          <p className="mt-1 text-[11px] text-zinc-400">{summarizeSchedule(task)}</p>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-500">
            {hasRuns ? (
              <>
                <span>Last run {fmtTime(task.lastRunAt)}</span>
                {lastRun && <RunStatusBadge status={lastRun.status} />}
              </>
            ) : (
              <span>Never run</span>
            )}
          </div>
        </div>
        <Toggle checked={task.enabled} onChange={onToggleEnabled} />
      </div>

      <div className="mt-2 flex items-center gap-1">
        <button
          onClick={onRunNow}
          className="rounded bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-300 hover:bg-rose-500/25"
        >▶ Run now</button>
        <button
          onClick={onEdit}
          className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-300 hover:bg-zinc-700"
        >Edit</button>
        <button
          onClick={onDelete}
          className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400 hover:bg-red-500/20 hover:text-red-300"
        >Delete</button>
        {hasRuns && (
          <button
            onClick={onToggleExpand}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
            title={expanded ? 'Hide run history' : 'Show run history'}
          >
            <Chevron open={expanded} /> {task.runs.length} run{task.runs.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {expanded && hasRuns && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-1 border-t border-zinc-800/80 pt-2">
              {[...task.runs].reverse().map((run) => (
                <RunHistoryItem key={run.id} run={run} onClick={() => onOpenRun(run)} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function RunHistoryItem({ run, onClick }: { run: ScheduleRun; onClick: () => void }): JSX.Element {
  const resumable = !!run.finishedAt && !!run.claudeSessionId
  return (
    <button
      onClick={resumable ? onClick : undefined}
      disabled={!resumable}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[10px] ${
        resumable ? 'hover:bg-zinc-800/60' : 'cursor-default opacity-50'
      }`}
      title={resumable ? 'Resume this run in a terminal' : run.finishedAt ? 'No saved conversation — cannot resume' : 'Run in progress'}
    >
      <span className="text-zinc-400">{fmtTime(run.startedAt)}</span>
      <span className="tabular-nums text-zinc-600">{fmtDuration(run.startedAt, run.finishedAt)}</span>
      <span className="ml-auto"><RunStatusBadge status={run.status} /></span>
    </button>
  )
}

function RunStatusBadge({ status }: { status: ScheduleRunStatus }): JSX.Element {
  const meta = RUN_STATUS[status]
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] ${meta.chip}`}>
      <span className={`relative h-1.5 w-1.5 rounded-full ${meta.dot}`}>
        {meta.pulse && <span className={`absolute inset-0 animate-ping rounded-full ${meta.dot} opacity-75`} />}
      </span>
      {meta.label}
    </span>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      title={checked ? 'Enabled — click to disable' : 'Disabled — click to enable'}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${checked ? 'bg-green-500/40' : 'bg-zinc-700'}`}
    >
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-zinc-200 transition-transform ${checked ? 'left-0.5 translate-x-3' : 'left-0.5'}`} />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Create / edit form drawer
// ---------------------------------------------------------------------------

function ScheduleFormDrawer({
  task, baseProjectsDir, onClose, onSubmit,
}: {
  task: ScheduledTask | null
  baseProjectsDir: string | null
  onClose: () => void
  onSubmit: (data: Omit<ScheduledTask, 'id' | 'createdAt' | 'runs' | 'lastRunAt'>) => void
}): JSX.Element {
  const [name, setName] = useState(task?.name ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [projectPath, setProjectPath] = useState(task?.projectPath ?? baseProjectsDir ?? '')
  const [onLaunch, setOnLaunch] = useState(task?.onLaunch ?? false)
  const [recurrenceKind, setRecurrenceKind] = useState<ScheduleRecurrence['kind']>(task?.recurrence.kind ?? 'none')
  const [intervalMinutes, setIntervalMinutes] = useState(task?.recurrence.kind === 'interval' ? task.recurrence.minutes : 60)
  const [dailyHour, setDailyHour] = useState(task?.recurrence.kind === 'daily' ? task.recurrence.hour : 10)
  const [dailyMinute, setDailyMinute] = useState(task?.recurrence.kind === 'daily' ? task.recurrence.minute : 0)
  const [autoApprove, setAutoApprove] = useState(task?.autoApprove ?? true)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [allowedToolsText, setAllowedToolsText] = useState((task?.allowedTools ?? []).join(', '))

  const canSave = name.trim().length > 0

  const submit = (): void => {
    if (!canSave) return
    const recurrence: ScheduleRecurrence =
      recurrenceKind === 'interval' ? { kind: 'interval', minutes: Math.max(1, Math.round(intervalMinutes) || 60) }
      : recurrenceKind === 'daily' ? { kind: 'daily', hour: dailyHour, minute: dailyMinute }
      : { kind: 'none' }
    const allowedTools = allowedToolsText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    onSubmit({
      name: name.trim(),
      prompt,
      projectPath: projectPath.trim() || baseProjectsDir || '',
      allowedTools: allowedTools.length ? allowedTools : undefined,
      autoApprove,
      onLaunch,
      recurrence,
      enabled: task?.enabled ?? true,
    })
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
      />
      <motion.aside
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        className="fixed right-0 top-0 z-40 flex h-full w-[480px] max-w-[95vw] flex-col border-l border-zinc-800 bg-zinc-950"
      >
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
          <h2 className="text-sm font-medium text-zinc-100">{task ? 'Edit schedule' : 'New schedule'}</h2>
          <button onClick={onClose} className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">✕</button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <Field label="Name">
            <input
              value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly cleanup"
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
            />
          </Field>

          <Field label="Prompt">
            <textarea
              value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="What should Claude do each run?"
              className="w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
            />
          </Field>

          <Field label="Directory">
            <input
              value={projectPath} onChange={(e) => setProjectPath(e.target.value)} placeholder={baseProjectsDir ?? '/path/to/project'}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-100 outline-none focus:border-sky-500"
            />
          </Field>

          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-zinc-300">
              <input type="checkbox" checked={onLaunch} onChange={(e) => setOnLaunch(e.target.checked)} />
              Run once at app launch
            </label>

            <Field label="Recurrence">
              <select
                value={recurrenceKind} onChange={(e) => setRecurrenceKind(e.target.value as ScheduleRecurrence['kind'])}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
              >
                <option value="none">None</option>
                <option value="interval">Every N minutes</option>
                <option value="daily">Daily at a time</option>
              </select>
            </Field>

            {recurrenceKind === 'interval' && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-zinc-500">Every</span>
                <input
                  type="number" min={1} value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                  className="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
                />
                <span className="text-[11px] text-zinc-500">minutes</span>
              </div>
            )}

            {recurrenceKind === 'daily' && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-zinc-500">At</span>
                <input
                  type="number" min={0} max={23} value={dailyHour}
                  onChange={(e) => setDailyHour(Math.min(23, Math.max(0, Number(e.target.value))))}
                  className="w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
                />
                <span className="text-[11px] text-zinc-500">:</span>
                <input
                  type="number" min={0} max={59} value={dailyMinute}
                  onChange={(e) => setDailyMinute(Math.min(59, Math.max(0, Number(e.target.value))))}
                  className="w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
                />
                <span className="text-[11px] text-zinc-500">(24h)</span>
              </div>
            )}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-zinc-300">
            <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
            Auto-approve (runs with permission-mode auto)
          </label>

          <div>
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300"
            >
              <Chevron open={showAdvanced} /> Advanced
            </button>
            {showAdvanced && (
              <Field label="Allowed tools (comma or newline separated; empty = unrestricted)">
                <textarea
                  value={allowedToolsText} onChange={(e) => setAllowedToolsText(e.target.value)} rows={2}
                  placeholder="Read, Edit, Bash"
                  className="mt-2 w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-100 outline-none focus:border-sky-500"
                />
              </Field>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button onClick={onClose} className="rounded px-3 py-1 text-[11px] text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button
            onClick={submit}
            disabled={!canSave}
            className="rounded bg-sky-500/20 px-3 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >Save</button>
        </div>
      </motion.aside>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
      {children}
    </label>
  )
}

// ---------------------------------------------------------------------------
// Run terminal drawer (resume a finished run)
// ---------------------------------------------------------------------------

function RunTerminalDrawer({ task, run, onClose }: { task: ScheduledTask; run: ScheduleRun; onClose: () => void }): JSX.Element {
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
      />
      <motion.aside
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        className="fixed right-0 top-0 z-40 flex h-full w-[780px] max-w-[95vw] flex-col border-l border-zinc-800 bg-zinc-950"
      >
        <div className="flex items-start gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">Run · {fmtTime(run.startedAt)}</span>
            <h2 className="mt-1.5 truncate text-sm font-medium text-zinc-100">{task.name}</h2>
          </div>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">✕</button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <RunTerminalPane task={task} run={run} />
        </div>
      </motion.aside>
    </>
  )
}

/**
 * Mounts the real interactive <Terminal> for a finished run, mirroring
 * PipelineView's SessionTerminalPane resolution:
 *   1. LIVE      — a PTY for this run is still running → attach (teardown is a no-op).
 *   2. EPHEMERAL — has a claudeSessionId → `claude --resume` into a PTY we own.
 *   3. READ-ONLY — no claudeSessionId, or the resume failed/exited.
 */
function RunTerminalPane({ task, run }: { task: ScheduledTask; run: ScheduleRun }): JSX.Element {
  const [state, setState] = useState<{ mode: 'resolving' | 'live' | 'ephemeral' | 'readonly'; ptyId: string | null }>({
    mode: 'resolving', ptyId: null,
  })

  useEffect(() => {
    let cancelled = false
    let owned: string | null = null
    let unsubExit: (() => void) | null = null

    ;(async () => {
      try {
        const actives = await window.api.listActiveSessions()
        if (cancelled) return
        const live = actives.find(
          (s) => (run.claudeSessionId && s.claudeSessionId === run.claudeSessionId) || s.id === run.sessionId
        )
        if (live) {
          setState({ mode: 'live', ptyId: live.id })
          return
        }

        if (!run.claudeSessionId) {
          setState({ mode: 'readonly', ptyId: null })
          return
        }
        const fresh = await window.api.resumeSession(run.claudeSessionId, task.projectPath, false, true)
        if (cancelled) {
          window.api.killSession(fresh.id)
          disposeTerminal(fresh.id)
          return
        }
        owned = fresh.id
        unsubExit = window.api.onPtyExit(({ id }) => {
          if (id !== fresh.id) return
          disposeTerminal(fresh.id)
          owned = null
          setState({ mode: 'readonly', ptyId: null })
        })
        setState({ mode: 'ephemeral', ptyId: fresh.id })
      } catch {
        if (cancelled) return
        setState({ mode: 'readonly', ptyId: null })
      }
    })()

    return () => {
      cancelled = true
      unsubExit?.()
      if (owned) {
        window.api.killSession(owned)
        disposeTerminal(owned)
      }
    }
  }, [run.claudeSessionId, run.sessionId, task.projectPath])

  const showTerminal = (state.mode === 'live' || state.mode === 'ephemeral') && state.ptyId

  return (
    <div className="flex min-h-[180px] flex-1 flex-col">
      {showTerminal ? (
        <div className="relative flex-1 overflow-hidden rounded-lg border border-zinc-800 bg-black/60">
          <Terminal sessionId={state.ptyId!} visible autoFocus={false} />
        </div>
      ) : state.mode === 'resolving' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 bg-black/40 p-3 text-center">
          <span className="inline-block h-3 w-1.5 animate-pulse bg-zinc-500 align-middle" />
          <p className="text-[10px] text-zinc-600">Connecting to session…</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 bg-black/40 p-3 text-center">
          <span className="text-lg text-zinc-700">○</span>
          <p className="text-[11px] text-zinc-400">Live resume unavailable</p>
          <p className="max-w-xs text-[10px] text-zinc-600">
            This run can't be resumed{run.claudeSessionId ? ' right now' : ' (no saved conversation)'}.
          </p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className={`transition-transform ${open ? 'rotate-90' : ''}`}>
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ClockGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-zinc-300">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
