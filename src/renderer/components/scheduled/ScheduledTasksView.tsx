import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../../store'
import { Terminal, disposeTerminal } from '../Terminal'
import type { ScheduledTask, ScheduleRun, ScheduleRecurrence, ScheduleRunStatus, LaunchTrigger } from '../../store'

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

/** "every hour" / "every 2 hours" / "every 30 minutes" / "every minute". */
function humanInterval(minutes: number): string {
  if (minutes > 0 && minutes % 60 === 0) {
    const h = minutes / 60
    return h === 1 ? 'every hour' : `every ${h} hours`
  }
  return minutes === 1 ? 'every minute' : `every ${minutes} minutes`
}

/** Join trigger clauses into a readable sequence: "A", "A, then B". */
function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? ''
  return `${clauses.slice(0, -1).join(', ')}, then ${clauses.at(-1)}`
}

/** Plain-English description of when a schedule fires — the single source of
 *  truth for both the card summary and the live preview in the form. */
function describeSchedule(t: {
  launch: LaunchTrigger
  recurrence: ScheduleRecurrence
  maxRunsPerDay?: number
}): string {
  const clauses: string[] = []
  if (t.launch === 'every') clauses.push('every time you open the app')
  else if (t.launch === 'firstOfDay') clauses.push('the first time you open the app each day')

  if (t.recurrence.kind === 'interval') clauses.push(`${humanInterval(t.recurrence.minutes)} while the app is open`)
  else if (t.recurrence.kind === 'daily') clauses.push(`every day at ${pad2(t.recurrence.hour)}:${pad2(t.recurrence.minute)} while the app is open`)

  if (clauses.length === 0) return 'Runs only when you trigger it manually.'

  let sentence = `Runs ${joinClauses(clauses)}.`
  const cap = t.maxRunsPerDay
  if (cap && cap > 0) sentence += ` Up to ${cap} time${cap === 1 ? '' : 's'} a day.`
  return sentence
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
        {/* titlebar-no-drag: the view-mode titlebars underneath (GraphView/SplitView/
            focused) keep their app-region: drag strip active through this overlay —
            drag regions are window-level and ignore z-order — so controls in the
            top 40px must carve themselves out. */}
        <button
          onClick={() => setEditing('new')}
          className="titlebar-no-drag ml-auto rounded bg-sky-500/15 px-2.5 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25"
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
            {task.model && <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] text-violet-300">{task.model}</span>}
            {!task.enabled && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-500">disabled</span>}
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">{task.projectPath}</p>
          <p className="mt-1 text-[11px] text-zinc-400">{describeSchedule(task)}</p>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-500">
            {hasRuns ? (
              <>
                <span>Last run {fmtTime(task.lastRunAt)}</span>
                {lastRun && <RunStatusBadge status={lastRun.status} />}
                {lastRun?.status === 'error' && lastRun.error && (
                  <span className="truncate text-red-300/60" title={lastRun.error}>{lastRun.error}</span>
                )}
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
  // In-progress runs are always openable — opening attaches to the LIVE terminal
  // (RunTerminalPane's live branch), so a run stuck at a login prompt can be
  // signed into in place. Finished runs still require a saved conversation to
  // `claude --resume`.
  const inProgress = !run.finishedAt
  const openable = inProgress ? true : !!run.claudeSessionId
  const baseTitle = inProgress
    ? 'Open the live run'
    : openable
      ? 'Resume this run in a terminal'
      : 'No saved conversation — cannot resume'
  return (
    <button
      onClick={openable ? onClick : undefined}
      disabled={!openable}
      className={`flex w-full flex-col gap-0.5 rounded px-2 py-1 text-left text-[10px] ${
        openable ? 'hover:bg-zinc-800/60' : 'cursor-default opacity-50'
      }`}
      title={run.error ?? baseTitle}
    >
      <div className="flex w-full items-center gap-2">
        <span className="text-zinc-400">{fmtTime(run.startedAt)}</span>
        <span className="tabular-nums text-zinc-600">{fmtDuration(run.startedAt, run.finishedAt)}</span>
        <span className="ml-auto"><RunStatusBadge status={run.status} /></span>
      </div>
      {run.status === 'error' && run.error && (
        <span className="truncate text-[9px] text-red-300/70">{run.error}</span>
      )}
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
  const [launch, setLaunch] = useState<LaunchTrigger>(task?.launch ?? 'off')
  const [recurrenceKind, setRecurrenceKind] = useState<ScheduleRecurrence['kind']>(task?.recurrence.kind ?? 'none')
  // Interval is stored in minutes but edited as a value + unit so "hourly" reads
  // naturally (1 hour) rather than "60 minutes".
  const initialMinutes = task?.recurrence.kind === 'interval' ? task.recurrence.minutes : 60
  const initialUnitHours = initialMinutes % 60 === 0
  const [intervalValue, setIntervalValue] = useState(initialUnitHours ? initialMinutes / 60 : initialMinutes)
  const [intervalUnit, setIntervalUnit] = useState<'minutes' | 'hours'>(initialUnitHours ? 'hours' : 'minutes')
  const [dailyHour, setDailyHour] = useState(task?.recurrence.kind === 'daily' ? task.recurrence.hour : 10)
  const [dailyMinute, setDailyMinute] = useState(task?.recurrence.kind === 'daily' ? task.recurrence.minute : 0)
  // 0 = unlimited.
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(task?.maxRunsPerDay ?? 0)
  const [autoApprove, setAutoApprove] = useState(task?.autoApprove ?? true)
  // '' = inherit the user's current default model.
  const [model, setModel] = useState(task?.model ?? '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [allowedToolsText, setAllowedToolsText] = useState((task?.allowedTools ?? []).join(', '))

  const canSave = name.trim().length > 0

  const intervalMinutes = Math.max(1, Math.round(intervalUnit === 'hours' ? intervalValue * 60 : intervalValue) || 60)
  const recurrence: ScheduleRecurrence = useMemo(() =>
    recurrenceKind === 'interval' ? { kind: 'interval', minutes: intervalMinutes }
    : recurrenceKind === 'daily' ? { kind: 'daily', hour: dailyHour, minute: dailyMinute }
    : { kind: 'none' },
    [recurrenceKind, intervalMinutes, dailyHour, dailyMinute])
  const cap = maxRunsPerDay > 0 ? Math.round(maxRunsPerDay) : undefined

  const submit = (): void => {
    if (!canSave) return
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
      model: model || undefined,
      launch,
      recurrence,
      maxRunsPerDay: cap,
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
          <button onClick={onClose} className="titlebar-no-drag ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">✕</button>
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

          <Field label="Model">
            <select
              value={model} onChange={(e) => setModel(e.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
            >
              <option value="">Default (current model)</option>
              <option value="haiku">Haiku</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="fable">Fable</option>
              {/* A full model id set via MCP isn't one of the aliases — keep it
                  selectable so opening the form doesn't silently clear it. */}
              {model && !['haiku', 'sonnet', 'opus', 'fable'].includes(model) && (
                <option value={model}>{model}</option>
              )}
            </select>
          </Field>

          <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">When to run</span>

            <Field label="On app launch">
              <select
                value={launch} onChange={(e) => setLaunch(e.target.value as LaunchTrigger)}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
              >
                <option value="off">Don't run on launch</option>
                <option value="every">Every time the app launches</option>
                <option value="firstOfDay">First launch of the day</option>
              </select>
            </Field>

            <Field label="Repeat while open">
              <select
                value={recurrenceKind} onChange={(e) => setRecurrenceKind(e.target.value as ScheduleRecurrence['kind'])}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
              >
                <option value="none">Don't repeat</option>
                <option value="interval">On an interval</option>
                <option value="daily">Daily at a set time</option>
              </select>
            </Field>

            {recurrenceKind === 'interval' && (
              <div className="flex items-center gap-2 pl-1">
                <span className="text-[11px] text-zinc-500">Every</span>
                <input
                  type="number" min={1} value={intervalValue}
                  onChange={(e) => setIntervalValue(Math.max(1, Number(e.target.value)))}
                  className="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
                />
                <select
                  value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as 'minutes' | 'hours')}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </div>
            )}

            {recurrenceKind === 'daily' && (
              <div className="flex items-center gap-2 pl-1">
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

            <Field label="Max runs per day">
              <div className="flex items-center gap-2">
                <input
                  type="number" min={0} value={maxRunsPerDay}
                  onChange={(e) => setMaxRunsPerDay(Math.max(0, Number(e.target.value)))}
                  className="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-100 outline-none focus:border-sky-500"
                />
                <span className="text-[11px] text-zinc-500">{maxRunsPerDay > 0 ? `cap of ${maxRunsPerDay}/day` : '0 = unlimited'}</span>
              </div>
            </Field>

            {/* Live plain-English summary of the settings above. */}
            <p className="rounded border border-sky-500/20 bg-sky-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-sky-200/90">
              {describeSchedule({ launch, recurrence, maxRunsPerDay: cap })}
            </p>
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
          <button onClick={onClose} className="titlebar-no-drag rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">✕</button>
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
