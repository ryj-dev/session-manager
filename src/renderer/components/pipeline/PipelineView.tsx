import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useStore, completedCutoffMs } from '../../store'
import { projectColor } from '../../lib/simulation'
import { Terminal, disposeTerminal } from '../Terminal'
import type {
  PipelineTask,
  PipelineSession,
  PipelineStage,
  PipelineSessionStatus,
  AutonomyLevel,
  PipelineTone,
} from '../../store'

/**
 * Agentic Pipeline (Cmd+L)
 *
 * A Kanban board where a todo flows through separate Claude sessions:
 *   Backlog → Plan → Implement → Review⇄Implement loop → Done
 *
 * Board state lives in the Zustand store (`pipelineTasks`, persisted via the
 * settings blob). The Backlog column is populated from real todos that aren't
 * yet in the pipeline. In-flight tasks carry a per-task autonomy level and,
 * once real orchestration is wired, an orchestrator session tree.
 *
 * The orchestrator / session-tree data (`task.orchestrator`) is populated by
 * real orchestration — spawn-session for the stage sessions, emit-milestone for
 * the feeds. Until that's wired it's undefined, and in-flight cards show an
 * "awaiting orchestrator" state. The drawer, recursive tree, fan-out grids and
 * feed/terminal views all render whatever real data is present.
 */

// ---------------------------------------------------------------------------
// Board-stage view model (store stages + the derived Backlog column)
// ---------------------------------------------------------------------------

type BoardStage = PipelineStage | 'backlog'

/** Unified card shape: a real todo (Backlog) or a PipelineTask (in-flight). */
interface BoardCard {
  id: string
  title: string
  tags: string[]
  stage: BoardStage
  autonomy?: AutonomyLevel
  reviewRound?: number
  gate?: { label: string; detail: string } | null
  orchestrator?: PipelineSession
}

const STAGES: { id: BoardStage; label: string; hint: string; accent: string; dot: string }[] = [
  { id: 'backlog',   label: 'Backlog',   hint: 'Your open todos',           accent: 'zinc',   dot: 'bg-zinc-500' },
  { id: 'plan',      label: 'Plan',      hint: 'Architect + research',      accent: 'violet', dot: 'bg-violet-400' },
  { id: 'implement', label: 'Implement', hint: 'Build (can fan out)',       accent: 'amber',  dot: 'bg-amber-400' },
  { id: 'review',    label: 'Review',    hint: 'Topic reviewers ⇄ fix',     accent: 'sky',    dot: 'bg-sky-400' },
  { id: 'done',      label: 'Done',      hint: 'Merged / closed',           accent: 'green',  dot: 'bg-green-400' },
]

const STAGE_FLOW: PipelineStage[] = ['plan', 'implement', 'review', 'done']
function nextStage(s: BoardStage): PipelineStage {
  const i = STAGE_FLOW.indexOf(s as PipelineStage)
  return STAGE_FLOW[Math.min(i + 1, STAGE_FLOW.length - 1)]
}

// Tailwind needs literal class names; map accent → concrete classes.
const ACCENT: Record<string, { ring: string; text: string; glow: string; chipBg: string; bar: string }> = {
  zinc:   { ring: 'border-zinc-700',      text: 'text-zinc-400',   glow: '',                                          chipBg: 'bg-zinc-800',      bar: 'bg-zinc-600' },
  rose:   { ring: 'border-rose-500/40',   text: 'text-rose-300',   glow: 'shadow-[0_0_18px_rgba(251,113,133,0.18)]', chipBg: 'bg-rose-500/15',   bar: 'bg-rose-400' },
  violet: { ring: 'border-violet-500/40', text: 'text-violet-300', glow: 'shadow-[0_0_18px_rgba(167,139,250,0.18)]', chipBg: 'bg-violet-500/15', bar: 'bg-violet-400' },
  amber:  { ring: 'border-amber-500/40',  text: 'text-amber-300',  glow: 'shadow-[0_0_18px_rgba(251,191,36,0.18)]',  chipBg: 'bg-amber-500/15',  bar: 'bg-amber-400' },
  sky:    { ring: 'border-sky-500/40',    text: 'text-sky-300',    glow: 'shadow-[0_0_18px_rgba(56,189,248,0.18)]',  chipBg: 'bg-sky-500/15',    bar: 'bg-sky-400' },
  green:  { ring: 'border-green-500/40',  text: 'text-green-300',  glow: 'shadow-[0_0_18px_rgba(74,222,128,0.18)]',  chipBg: 'bg-green-500/15',  bar: 'bg-green-400' },
}

const STATUS_DOT: Record<PipelineSessionStatus, { dot: string; label: string; pulse: boolean }> = {
  working:    { dot: 'bg-amber-400', label: 'working',         pulse: true },
  idle:       { dot: 'bg-zinc-500',  label: 'waiting for you', pulse: false },
  permission: { dot: 'bg-blue-400',  label: 'needs approval',  pulse: true },
  done:       { dot: 'bg-green-400', label: 'done',            pulse: false },
  queued:     { dot: 'bg-zinc-700',  label: 'queued',          pulse: false },
}

const TONE_CHIP: Record<PipelineTone, string> = {
  pass:    'bg-green-500/15 text-green-300',
  fail:    'bg-red-500/15 text-red-300',
  warn:    'bg-amber-500/15 text-amber-300',
  active:  'bg-sky-500/15 text-sky-300',
  neutral: 'bg-zinc-800 text-zinc-400',
}

const AUTONOMY: Record<AutonomyLevel, { label: string; glyph: string; desc: string }> = {
  manual: { label: 'Manual',     glyph: '◍', desc: 'Pause at every hand-off — you approve each transition.' },
  gated:  { label: 'Gated',      glyph: '◑', desc: 'Auto within a stage; pause at gates (approve plan, before merging to Done).' },
  auto:   { label: 'Autonomous', glyph: '●', desc: 'Runs the whole pipeline — accepts plans, implements, finishes review, moves to Done. Interrupts only for permissions or hard errors.' },
}

function roleAccent(role: PipelineSession['role']): string {
  return role === 'orchestrator' ? 'rose' : role === 'plan' ? 'violet' : role === 'implement' ? 'amber' : 'sky'
}

/** Recursive lookup through the session tree. */
function findSession(root: PipelineSession | undefined, id: string | null): PipelineSession | null {
  if (!root || !id) return null
  if (root.id === id) return root
  for (const c of root.children ?? []) {
    const found = findSession(c, id)
    if (found) return found
  }
  return null
}

/** Current live worker = the last stage run under the orchestrator. */
function liveStage(task: BoardCard): PipelineSession | undefined {
  const stages = task.orchestrator?.children
  return stages?.[stages.length - 1]
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

interface Props {
  visible: boolean
  onClose: () => void
}

export function PipelineView({ visible, onClose }: Props): JSX.Element | null {
  const pipelineTasks = useStore((s) => s.pipelineTasks)
  const defaultAutonomy = useStore((s) => s.pipelineDefaultAutonomy)
  const startTask = useStore((s) => s.startPipelineTask)
  const setStage = useStore((s) => s.setPipelineStage)
  const setAutonomy = useStore((s) => s.setPipelineAutonomy)
  const resolveGate = useStore((s) => s.resolvePipelineGate)
  const removeTask = useStore((s) => s.removePipelineTask)
  const completedFilter = useStore((s) => s.completedFilter)
  const projectFilter = useStore((s) => s.pipelineProjectFilter)
  const setProjectFilter = useStore((s) => s.setPipelineProjectFilter)

  // Backlog = open todos not already in the pipeline.
  const [backlogTodos, setBacklogTodos] = useState<{ id: string; title: string; tags: string[] }[]>([])
  const refreshBacklog = useCallback(async () => {
    const todos = await window.api.todosList({ done: false })
    setBacklogTodos(todos.map((t) => ({ id: t.id, title: t.title, tags: t.tags })))
  }, [])
  useEffect(() => {
    if (!visible) return
    refreshBacklog()
    const unsub = window.api.onNotesChanged(refreshBacklog)
    return unsub
  }, [visible, refreshBacklog])

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<{ cardId: string; sessionId: string | null } | null>(null)
  // Read-only detail panel for a clicked Backlog card. Backlog cards carry only
  // {id, title, tags}; the body is fetched lazily via todosRead on click.
  const [backlogDetail, setBacklogDetail] = useState<{ id: string; title: string; body: string; done: boolean; tags: string[] } | null>(null)
  const [backlogLoadingId, setBacklogLoadingId] = useState<string | null>(null)
  // True while the ProjectPicker dropdown is open. Checked in the global Escape
  // handler so it never closes the drawer/view while the popover owns Escape —
  // robust regardless of window-listener registration order.
  const popoverOpenRef = useRef(false)
  const [dragCard, setDragCard] = useState<BoardCard | null>(null)
  const [dragOver, setDragOver] = useState<BoardStage | null>(null)

  // Project filter (basename) — null = all. Cards match by their project: tag.
  const matchesProject = useCallback(
    (tags: string[]) => !projectFilter || tags.includes(`project:${projectFilter}`),
    [projectFilter],
  )
  // Projects with any todos/tasks in view, plus the active filter (so it always shows).
  const projectNames = useMemo(() => {
    const set = new Set<string>()
    const add = (tags: string[]) => tags.forEach((t) => { if (t.startsWith('project:')) set.add(t.slice('project:'.length)) })
    backlogTodos.forEach((t) => add(t.tags))
    pipelineTasks.forEach((t) => add(t.tags))
    if (projectFilter) set.add(projectFilter)
    return [...set].sort()
  }, [backlogTodos, pipelineTasks, projectFilter])

  const inPipeline = useMemo(() => new Set(pipelineTasks.map((t) => t.id)), [pipelineTasks])
  const backlogCards: BoardCard[] = useMemo(
    () => backlogTodos.filter((t) => !inPipeline.has(t.id) && matchesProject(t.tags)).map((t) => ({ ...t, stage: 'backlog' as const })),
    [backlogTodos, inPipeline, matchesProject],
  )

  const openTask = useMemo(() => pipelineTasks.find((t) => t.id === open?.cardId) ?? null, [pipelineTasks, open])

  const cardsForStage = useCallback(
    (stage: BoardStage): BoardCard[] => {
      if (stage === 'backlog') return backlogCards
      const list = pipelineTasks.filter((t) => t.stage === stage && matchesProject(t.tags))
      if (stage !== 'done') return list
      // Apply the recency window to completed cards.
      const cutoff = completedCutoffMs(completedFilter)
      return cutoff == null ? list : list.filter((t) => t.completedAt == null || t.completedAt >= cutoff)
    },
    [backlogCards, pipelineTasks, completedFilter, matchesProject],
  )

  // When a task lands in Done, mark its backing todo complete.
  const completeTodo = useCallback(async (id: string) => {
    try { await window.api.todosUpdate(id, { done: true }) } catch { /* ignore */ }
    refreshBacklog()
  }, [refreshBacklog])

  const moveToStage = useCallback((card: BoardCard, target: BoardStage) => {
    if (card.stage === target) return
    if (target === 'backlog') { if (card.stage !== 'backlog') removeTask(card.id); return }
    if (card.stage === 'backlog') {
      startTask({ id: card.id, title: card.title, tags: card.tags })
      if (target !== 'plan') setStage(card.id, target as PipelineStage)
    } else {
      setStage(card.id, target as PipelineStage)
    }
    if (target === 'done') completeTodo(card.id)
  }, [removeTask, startTask, setStage, completeTodo])

  // Open the read-only detail panel for a Backlog card. Show a shell immediately
  // (title + tags are already known) then fetch the body; a race guard ignores a
  // stale response if the user switched cards before it resolved.
  const openBacklogDetail = useCallback(async (card: BoardCard) => {
    setBacklogLoadingId(card.id)
    setBacklogDetail({ id: card.id, title: card.title, body: '', done: false, tags: card.tags })
    try {
      const full = await window.api.todosRead(card.id)
      setBacklogDetail((cur) => (cur && cur.id === card.id ? full : cur))
    } catch { /* keep the shell we already rendered */ }
    finally { setBacklogLoadingId((id) => (id === card.id ? null : id)) }
  }, [])

  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // The ProjectPicker dropdown owns Escape while it's open. The ref check
        // is order-independent (it doesn't rely on which window listener fired
        // first); defaultPrevented also covers the case where ProjectPicker ran
        // ahead of us. Either way, leave the drawer/view alone here.
        if (popoverOpenRef.current || e.defaultPrevented) return
        e.stopPropagation()
        if (backlogDetail) { setBacklogDetail(null); return }
        if (open) setOpen(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [visible, open, onClose, backlogDetail])

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
        <PipelineGlyph />
        <h1 className="text-[13px] font-semibold tracking-tight text-zinc-100">Agentic Pipeline</h1>
        <ProjectPicker value={projectFilter} options={projectNames} onChange={setProjectFilter} onOpenChange={(o) => { popoverOpenRef.current = o }} />
      </header>

      {/* Board */}
      <div className="flex flex-1 gap-3 overflow-x-auto px-4 py-4">
        {STAGES.map((stage) => {
          const stageCards = cardsForStage(stage.id)
          const accent = ACCENT[stage.accent]
          const isOver = dragOver === stage.id
          return (
            <div
              key={stage.id}
              onDragOver={(e) => { e.preventDefault(); setDragOver(stage.id) }}
              onDragLeave={() => setDragOver((s) => (s === stage.id ? null : s))}
              onDrop={() => { if (dragCard) moveToStage(dragCard, stage.id); setDragCard(null); setDragOver(null) }}
              className={`flex w-72 shrink-0 flex-col rounded-xl border bg-zinc-900/40 transition-colors ${
                isOver ? `${accent.ring} bg-zinc-900/80` : 'border-zinc-800/80'
              }`}
            >
              <div className="flex items-center gap-2 px-3 pt-3 pb-2">
                <span className={`h-1.5 w-1.5 rounded-full ${stage.dot}`} />
                <span className="text-xs font-medium text-zinc-200">{stage.label}</span>
                <span className="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400">{stageCards.length}</span>
                <span className="ml-auto text-[10px] text-zinc-600">{stage.hint}</span>
              </div>

              <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                <AnimatePresence mode="popLayout">
                  {stageCards.map((card) => (
                    <CardTile
                      key={card.id}
                      card={card}
                      defaultAutonomy={defaultAutonomy}
                      expanded={expandedIds.has(card.id)}
                      onToggleExpand={() => toggleExpand(card.id)}
                      onOpen={(sessionId) => { if (card.stage === 'backlog') openBacklogDetail(card); else setOpen({ cardId: card.id, sessionId }) }}
                      onStart={() => startTask({ id: card.id, title: card.title, tags: card.tags })}
                      onDragStart={() => setDragCard(card)}
                      onDragEnd={() => { setDragCard(null); setDragOver(null) }}
                    />
                  ))}
                </AnimatePresence>
                {stageCards.length === 0 && (
                  <div className="flex flex-1 items-center justify-center py-8 text-[11px] text-zinc-700">
                    {isOver ? 'Drop to move here' : stage.id === 'backlog' ? 'No open todos' : '—'}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <AnimatePresence>
        {openTask && (
          <SessionDrawer
            key={openTask.id}
            card={openTask}
            initialSessionId={open?.sessionId ?? openTask.orchestrator?.id ?? null}
            onClose={() => setOpen(null)}
            onSetAutonomy={(level) => setAutonomy(openTask.id, level)}
            onApprove={() => { const n = nextStage(openTask.stage); resolveGate(openTask.id, true); if (n === 'done') completeTodo(openTask.id) }}
            onReject={() => resolveGate(openTask.id, false)}
            onAdvance={() => { const n = nextStage(openTask.stage); setStage(openTask.id, n); if (n === 'done') completeTodo(openTask.id) }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {backlogDetail && (
          <BacklogDetailDrawer
            key={backlogDetail.id}
            todo={backlogDetail}
            loading={backlogLoadingId === backlogDetail.id}
            onClose={() => setBacklogDetail(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card tile (collapsed + expandable session tree)
// ---------------------------------------------------------------------------

function CardTile({
  card, defaultAutonomy, expanded, onToggleExpand, onOpen, onStart, onDragStart, onDragEnd,
}: {
  card: BoardCard
  defaultAutonomy: AutonomyLevel
  expanded: boolean
  onToggleExpand: () => void
  onOpen: (sessionId: string | null) => void
  onStart: () => void
  onDragStart: () => void
  onDragEnd: () => void
}): JSX.Element {
  const stageMeta = STAGES.find((s) => s.id === card.stage)!
  const accent = ACCENT[stageMeta.accent]
  const orch = card.orchestrator
  const stage = liveStage(card)
  const fanCount = stage?.children?.length ?? 0
  const narration = orch?.log[orch.log.length - 1]
  const autonomy = card.autonomy ?? defaultAutonomy
  const isInFlight = card.stage !== 'backlog' && card.stage !== 'done'

  return (
    <motion.div
      layout
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`rounded-lg border bg-zinc-900 ${orch ? `${accent.ring} ${accent.glow}` : 'border-zinc-800'}`}
    >
      <div className="group cursor-pointer p-2.5" onClick={() => onOpen(orch?.id ?? null)}>
        <div className="flex items-start gap-1.5">
          {orch && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
              className="mt-0.5 text-zinc-500 hover:text-zinc-200"
              title={expanded ? 'Collapse' : 'Show session tree'}
            >
              <Chevron open={expanded} />
            </button>
          )}
          <p className="line-clamp-2 flex-1 text-[12px] leading-snug text-zinc-100">{card.title}</p>
        </div>

        {card.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1 pl-[18px]">
            {card.tags.map((t) => (
              <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">{t.replace(/^project:/, '')}</span>
            ))}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2 pl-[18px]">
          {orch && (
            <span className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] ${ACCENT.rose.chipBg} ${ACCENT.rose.text}`}>
              <StatusDot status={orch.status} /> orchestrator
            </span>
          )}
          {card.stage !== 'backlog' && (
            <span className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400" title={AUTONOMY[autonomy].desc}>
              {AUTONOMY[autonomy].glyph} {AUTONOMY[autonomy].label}
            </span>
          )}
          {card.gate && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">⏳ {card.gate.label}</span>
          )}
          {card.stage === 'review' && card.reviewRound != null && (
            <span className={`rounded px-1.5 py-0.5 text-[9px] ${accent.chipBg} ${accent.text}`}>↻ round {card.reviewRound}</span>
          )}
          {fanCount > 0 && (
            <span className={`rounded px-1.5 py-0.5 text-[9px] ${accent.chipBg} ${accent.text}`}>⑂ {fanCount} {stage?.fanoutKind}</span>
          )}
          {card.stage === 'done' && <span className="text-[10px] text-green-400/80">✓ complete</span>}
          {card.stage === 'backlog' && (
            <button
              onClick={(e) => { e.stopPropagation(); onStart() }}
              className="ml-auto rounded bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-300 opacity-0 transition-opacity hover:bg-rose-500/25 group-hover:opacity-100"
            >▶ Start</button>
          )}
        </div>

        {/* In-flight but not yet wired to real sessions */}
        {isInFlight && !orch && (
          <p className="mt-2 flex items-center gap-1.5 pl-[18px] text-[10px] text-zinc-500">
            <StatusDot status="queued" /> awaiting orchestrator
          </p>
        )}
        {narration && card.stage !== 'done' && (
          <p className="mt-2 truncate pl-[18px] font-mono text-[10px] text-zinc-500">{narration}</p>
        )}
      </div>

      <AnimatePresence initial={false}>
        {expanded && orch && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-zinc-800/80"
          >
            <div className="space-y-0.5 p-1.5">
              <SessionTree node={orch} depth={0} onSelect={onOpen} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** Recursive session tree, used both inline (cards) and in the drawer rail. */
function SessionTree({
  node, depth, onSelect, selectedId,
}: {
  node: PipelineSession
  depth: number
  onSelect: (id: string) => void
  selectedId?: string | null
}): JSX.Element {
  const active = selectedId === node.id
  return (
    <div>
      <button
        onClick={(e) => { e.stopPropagation(); onSelect(node.id) }}
        style={{ paddingLeft: 6 + depth * 14 }}
        className={`flex w-full items-center gap-1.5 rounded py-1 pr-1.5 text-left ${depth === 0 ? 'text-[11px]' : 'text-[10px]'} ${
          active ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'
        }`}
      >
        <StatusDot status={node.status} />
        <span className={`truncate ${ACCENT[roleAccent(node.role)].text}`}>{node.label}</span>
        {node.badge && <span className={`ml-auto shrink-0 rounded px-1 text-[9px] ${TONE_CHIP[node.tone ?? 'neutral']}`}>{node.badge}</span>}
      </button>
      {node.children?.map((c) => (
        <SessionTree key={c.id} node={c} depth={depth + 1} onSelect={onSelect} selectedId={selectedId} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session drawer (drill-in: task controls + tree rail + content)
// ---------------------------------------------------------------------------

function SessionDrawer({
  card, initialSessionId, onClose, onAdvance, onSetAutonomy, onApprove, onReject,
}: {
  card: PipelineTask
  initialSessionId: string | null
  onClose: () => void
  onAdvance: () => void
  onSetAutonomy: (level: AutonomyLevel) => void
  onApprove: () => void
  onReject: () => void
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId)
  const selected = useMemo(() => findSession(card.orchestrator, selectedId), [card.orchestrator, selectedId])
  const stageMeta = STAGES.find((s) => s.id === card.stage)!

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
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${ACCENT[stageMeta.accent].chipBg} ${ACCENT[stageMeta.accent].text}`}>{stageMeta.label}</span>
            <h2 className="mt-1.5 truncate text-sm font-medium text-zinc-100">{card.title}</h2>
          </div>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">✕</button>
        </div>

        <StageStepper current={card.stage} />

        {/* Task-level controls: autonomy + pending gate */}
        <div className="space-y-2 border-b border-zinc-800 px-4 py-3">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Autonomy</p>
            <div className="flex gap-1">
              {(Object.keys(AUTONOMY) as AutonomyLevel[]).map((level) => {
                const active = card.autonomy === level
                return (
                  <button
                    key={level}
                    onClick={() => onSetAutonomy(level)}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-left ${active ? `${ACCENT.rose.ring} bg-rose-500/10` : 'border-zinc-800 hover:border-zinc-700'}`}
                  >
                    <span className={`text-[11px] font-medium ${active ? 'text-rose-200' : 'text-zinc-300'}`}>{AUTONOMY[level].glyph} {AUTONOMY[level].label}</span>
                  </button>
                )
              })}
            </div>
            <p className="mt-1 text-[10px] text-zinc-500">{AUTONOMY[card.autonomy].desc}</p>
          </div>

          {card.gate && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5">
              <p className="text-[11px] font-medium text-amber-200">⏳ Gate — {card.gate.label}</p>
              <p className="mt-0.5 text-[10px] text-amber-200/70">{card.gate.detail}</p>
              <div className="mt-2 flex gap-2">
                <button onClick={onApprove} className="rounded-md bg-amber-400 px-2.5 py-1 text-[10px] font-semibold text-amber-950 hover:bg-amber-300">Approve &amp; advance</button>
                <button onClick={onReject} className="rounded-md bg-zinc-800 px-2.5 py-1 text-[10px] font-medium text-zinc-300 hover:bg-zinc-700">Send back</button>
              </div>
            </div>
          )}
        </div>

        {/* Body: tree rail + content, or empty state until orchestration is wired */}
        {card.orchestrator ? (
          <div className="flex min-h-0 flex-1">
            <div className="w-60 shrink-0 overflow-y-auto border-r border-zinc-800 p-2">
              <p className="px-1 pb-1 text-[9px] font-semibold uppercase tracking-wider text-zinc-600">Session tree</p>
              <SessionTree node={card.orchestrator} depth={0} onSelect={setSelectedId} selectedId={selectedId} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              {selected ? (
                // Keyed by node id so switching sessions force-remounts SessionContent
                // (and the live Terminal pane within), firing ephemeral-resume teardown cleanly.
                <SessionContent key={selected.id} sess={selected} onSelectChild={setSelectedId} />
              ) : (
                <div className="flex flex-1 items-center justify-center text-[12px] text-zinc-600">Select a session</div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
            <span className="text-2xl text-zinc-700">⧉</span>
            <p className="text-[12px] text-zinc-400">No sessions yet</p>
            <p className="max-w-sm text-[11px] leading-relaxed text-zinc-600">
              The orchestrator session and its stage/fan-out children will appear here once orchestration is wired
              (<code className="text-zinc-500">spawn-session</code> + <code className="text-zinc-500">emit-milestone</code>).
              For now you can set autonomy and force the task through the stages.
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-zinc-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <input
              placeholder={
                !selected ? 'Orchestrator not running yet'
                  : selected.status === 'done' || selected.status === 'queued' ? 'This session has finished'
                  : selected.role === 'orchestrator' ? 'Steer the whole task (talk to the orchestrator)…'
                  : `Type to intervene in ${selected.label}…`
              }
              disabled={!selected || selected.status === 'done' || selected.status === 'queued'}
              className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={onAdvance}
              disabled={card.stage === 'done'}
              className="rounded-lg bg-zinc-800 px-3 py-2 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
            >Force advance →</button>
          </div>
          <p className="mt-1.5 text-[10px] text-zinc-600">
            Real flow: the orchestrator drives transitions; talking here writes to the selected session's PTY; Force advance overrides its gate.
          </p>
        </div>
      </motion.aside>
    </>
  )
}

// ---------------------------------------------------------------------------
// Backlog detail drawer (read-only: a clicked Backlog todo)
// ---------------------------------------------------------------------------

function BacklogDetailDrawer({
  todo, loading, onClose,
}: {
  todo: { id: string; title: string; body: string; done: boolean; tags: string[] }
  loading: boolean
  onClose: () => void
}): JSX.Element {
  const hasBody = todo.body.trim().length > 0
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
        className="fixed right-0 top-0 z-40 flex h-full w-[440px] max-w-[90vw] flex-col border-l border-zinc-800 bg-zinc-950"
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${ACCENT.zinc.chipBg} ${ACCENT.zinc.text}`}>Backlog</span>
            <h2 className="mt-1.5 line-clamp-3 text-sm font-medium text-zinc-100">{todo.title}</h2>
          </div>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">✕</button>
        </div>

        {/* Meta: status + tags */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 px-4 py-2.5">
          <span className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">
            <span className={`h-1.5 w-1.5 rounded-full ${todo.done ? 'bg-green-400' : 'bg-zinc-500'}`} />
            {todo.done ? 'Completed' : 'Open'}
          </span>
          {todo.tags.map((t) => (
            <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">{t.replace(/^project:/, '')}</span>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading
            ? <p className="text-[12px] text-zinc-600">Loading…</p>
            : hasBody
              ? <MarkdownBody content={todo.body} />
              : <p className="text-[12px] italic text-zinc-600">No description.</p>}
        </div>
      </motion.aside>
    </>
  )
}

/**
 * Self-contained markdown renderer for the backlog body. Mirrors the inline-style
 * component map from memory/NoteViewer.tsx — the app has no @tailwindcss/typography
 * plugin, so the `prose` classes are unavailable and styles are applied inline.
 */
function MarkdownBody({ content }: { content: string }): JSX.Element {
  return (
    <div className="text-[12px] leading-relaxed text-zinc-300">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: '#6cf' }}>{children}</a>,
          h1: ({ children }) => <h1 style={{ fontSize: 18, fontWeight: 600, color: '#e0e0e0', marginBottom: 8 }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ fontSize: 15, fontWeight: 600, color: '#c0c8d0', marginTop: 18, marginBottom: 6, borderBottom: '1px solid #1e2530', paddingBottom: 4 }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: 13, fontWeight: 600, color: '#aab8c0', marginTop: 14, marginBottom: 4 }}>{children}</h3>,
          p: ({ children }) => <p style={{ marginBottom: 10 }}>{children}</p>,
          ul: ({ children }) => <ul style={{ paddingLeft: 18, marginBottom: 10, listStyle: 'disc' }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ paddingLeft: 18, marginBottom: 10, listStyle: 'decimal' }}>{children}</ol>,
          li: ({ children }) => <li style={{ marginBottom: 3 }}>{children}</li>,
          code: ({ children, className }) => {
            if (className) {
              return <code style={{ display: 'block', background: '#111418', padding: 10, borderRadius: 4, fontSize: 11, fontFamily: 'ui-monospace, monospace', overflowX: 'auto', marginBottom: 10 }}>{children}</code>
            }
            return <code style={{ background: '#1a2030', padding: '1px 5px', borderRadius: 3, fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>{children}</code>
          },
          table: ({ children }) => <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10, fontSize: 12 }}>{children}</table>,
          th: ({ children }) => <th style={{ textAlign: 'left', padding: '5px 8px', borderBottom: '1px solid #2a3545', color: '#aab', fontWeight: 600, fontSize: 11 }}>{children}</th>,
          td: ({ children }) => <td style={{ padding: '4px 8px', borderBottom: '1px solid #1a1f28' }}>{children}</td>,
          blockquote: ({ children }) => <blockquote style={{ borderLeft: '3px solid #2a3545', paddingLeft: 14, color: '#889', marginBottom: 10 }}>{children}</blockquote>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function SessionContent({ sess, onSelectChild }: { sess: PipelineSession; onSelectChild: (id: string) => void }): JSX.Element {
  const termRef = useRef<HTMLDivElement>(null)
  const [visibleLines, setVisibleLines] = useState(0)
  const [tab, setTab] = useState<'feed' | 'terminal'>('feed')
  const isOrchestrator = sess.role === 'orchestrator'

  useEffect(() => {
    setVisibleLines(0)
    if (sess.log.length === 0) return
    const iv = setInterval(() => setVisibleLines((n) => (n >= sess.log.length ? (clearInterval(iv), n) : n + 1)), 350)
    return () => clearInterval(iv)
  }, [sess.id, sess.log.length])
  useEffect(() => { termRef.current?.scrollTo({ top: termRef.current.scrollHeight }) }, [visibleLines, tab])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <StatusDot status={sess.status} />
        <span className="text-[13px] font-medium text-zinc-100">{sess.label}</span>
        {sess.badge && <span className={`rounded px-1.5 py-0.5 text-[10px] ${TONE_CHIP[sess.tone ?? 'neutral']}`}>{sess.badge}</span>}
        {isOrchestrator
          ? <span className="ml-auto text-[10px] text-zinc-500">supervises {sess.children?.length ?? 0} stages</span>
          : sess.fanoutKind && <span className="ml-auto text-[10px] text-zinc-500">fan-out · {sess.children?.length} {sess.fanoutKind}</span>}
      </div>

      {sess.children && sess.children.length > 0 && (
        isOrchestrator ? (
          <div className="mb-3 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Pipeline stages</p>
            {sess.children.map((stage, i) => (
              <button
                key={stage.id}
                onClick={() => onSelectChild(stage.id)}
                className="flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-left hover:border-zinc-700"
              >
                <span className="w-4 text-[10px] text-zinc-600">{i + 1}</span>
                <StatusDot status={stage.status} />
                <span className={`text-[11px] ${ACCENT[roleAccent(stage.role)].text}`}>{stage.label}</span>
                {stage.children && <span className="text-[9px] text-zinc-600">⑂ {stage.children.length} {stage.fanoutKind}</span>}
                {stage.badge && <span className={`ml-auto rounded px-1 text-[9px] ${TONE_CHIP[stage.tone ?? 'neutral']}`}>{stage.badge}</span>}
              </button>
            ))}
          </div>
        ) : (
          <div className="mb-3 grid grid-cols-2 gap-2">
            {sess.children.map((child) => (
              <button
                key={child.id}
                onClick={() => onSelectChild(child.id)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-left hover:border-zinc-700"
              >
                <div className="flex items-center gap-1.5">
                  <StatusDot status={child.status} />
                  <span className="truncate text-[11px] font-medium text-zinc-100">{child.label}</span>
                  {child.badge && <span className={`ml-auto shrink-0 rounded px-1 text-[9px] ${TONE_CHIP[child.tone ?? 'neutral']}`}>{child.badge}</span>}
                </div>
                {child.worktreeBranch && (
                  <span
                    className={`mt-1.5 inline-flex max-w-full items-center gap-1 truncate rounded px-1 text-[9px] ${child.worktreeRemoved ? 'bg-zinc-800 text-zinc-500' : 'bg-violet-500/15 text-violet-300'}`}
                    title={child.worktreeRemoved ? 'Merged — worktree removed (read-only)' : `Isolated worktree on ${child.worktreeBranch}`}
                  >
                    {child.worktreeRemoved ? '🔒' : '⑂'} <span className="truncate">{child.worktreeBranch}</span>
                  </span>
                )}
                <p className="mt-1.5 line-clamp-2 font-mono text-[10px] text-zinc-500">{child.log[child.log.length - 1]}</p>
                <span className="mt-1.5 inline-block text-[10px] text-zinc-600">View session →</span>
              </button>
            ))}
          </div>
        )
      )}

      <div className="mb-1.5 flex items-center gap-1">
        <TabButton active={tab === 'feed'} onClick={() => setTab('feed')}>{isOrchestrator ? 'Decisions' : 'Milestones'}</TabButton>
        <TabButton active={tab === 'terminal'} onClick={() => setTab('terminal')}>Terminal</TabButton>
        <span className="ml-auto text-[9px] text-zinc-600">{tab === 'terminal' ? 'real interactive PTY' : 'curated via emit-milestone + hooks'}</span>
      </div>

      {/* Feed: cheap to mount/unmount on tab toggle. */}
      {tab === 'feed' && (
        <div ref={termRef} className="min-h-[180px] flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-black/60 p-3 font-mono text-[11px] leading-relaxed">
          {sess.log.slice(0, visibleLines).map((line, i) => (
            <div key={i} className={lineColor(line)}>{line}</div>
          ))}
          {(sess.status === 'working' || sess.status === 'permission') && visibleLines >= sess.log.length && (
            <span className="inline-block h-3 w-1.5 animate-pulse bg-zinc-500 align-middle" />
          )}
        </div>
      )}

      {/* Terminal: stays mounted for the drawer's life (hidden when on feed) so the live
          xterm/PTY persists across tab toggles. Teardown of an ephemeral resume only fires
          on unmount (drawer close / node switch via the SessionContent key). */}
      <SessionTerminalPane sess={sess} active={tab === 'terminal'} />
    </div>
  )
}

/**
 * Mounts the real interactive <Terminal> for a pipeline session in the drawer.
 *
 * Resolves one of three modes (best-effort live resume):
 *   1. LIVE      — a PTY for this node is still running (worker active). Attach to the
 *                  shared instance; teardown is a no-op (the worker / focus view owns it).
 *   2. EPHEMERAL — no live PTY but the node has a claudeSessionId + cwd → `claude --resume`
 *                  into a fresh PTY we own. Killed + disposed on unmount.
 *   3. READ-ONLY — worktreeRemoved, no claudeSessionId/cwd, or the resume failed/exited.
 *                  worktreeRemoved NEVER offers resume.
 */
function SessionTerminalPane({ sess, active }: { sess: PipelineSession; active: boolean }): JSX.Element {
  const [state, setState] = useState<{
    mode: 'resolving' | 'live' | 'ephemeral' | 'readonly'
    ptyId: string | null
  }>({ mode: 'resolving', ptyId: null })

  // Lazy one-way latch: resolution fires only once the Terminal tab is FIRST activated.
  // Without this, opening the drawer on (or arrow-keying through) resumable nodes would
  // spawn + kill a real `claude --resume` per node even for feed-only viewing. Once armed
  // it stays true, so flipping back to the feed never tears down or re-resumes — the pane
  // persists hidden, exactly as before. (The mid-resume tab-toggle race is already covered
  // by the `cancelled` flag, so eager resolution bought us nothing.) Node switch remounts
  // this component via SessionContent's key, which re-latches `armed` off → resume happens
  // again only when Terminal is opened on the new node.
  const [armed, setArmed] = useState(active)
  useEffect(() => {
    if (active) setArmed(true)
  }, [active])

  // Resolve + resume once per (open, node) — gated on `armed`. Deps are stable within a mount
  // (SessionContent is keyed by node id), so this runs once the tab is first opened; cleanup
  // runs once on unmount.
  useEffect(() => {
    // Not yet revealed — don't spawn anything (and never mount xterm into a hidden 0×0 box).
    if (!armed) return
    // worktreeRemoved is read-only and must never offer resume.
    if (sess.worktreeRemoved) {
      setState({ mode: 'readonly', ptyId: null })
      return
    }

    let cancelled = false
    let owned: string | null = null // the ephemeral PTY we must kill on teardown
    let unsubExit: (() => void) | null = null

    ;(async () => {
      try {
        // 1. LIVE — is a PTY for this node still running? Match by claudeSessionId, fall back to id.
        const actives = await window.api.listActiveSessions()
        if (cancelled) return
        const live = actives.find(
          (s) => (sess.claudeSessionId && s.claudeSessionId === sess.claudeSessionId) || s.id === sess.id
        )
        if (live) {
          setState({ mode: 'live', ptyId: live.id })
          return
        }

        // 2. EPHEMERAL view-resume — needs both a claude session id and a working dir.
        if (!sess.claudeSessionId || !sess.cwd) {
          setState({ mode: 'readonly', ptyId: null })
          return
        }
        const fresh = await window.api.resumeSession(sess.claudeSessionId, sess.cwd, false, true)
        if (cancelled) {
          // Drawer closed / node switched before resume resolved — kill the orphan PTY.
          window.api.killSession(fresh.id)
          disposeTerminal(fresh.id)
          return
        }
        owned = fresh.id
        // If the resumed process exits (e.g. `claude --resume` failed, session file gone, or
        // the conversation ended), fall back to read-only rather than showing a dead terminal.
        unsubExit = window.api.onPtyExit(({ id }) => {
          if (id !== fresh.id) return
          disposeTerminal(fresh.id)
          owned = null // already exiting — nothing left to kill
          setState({ mode: 'readonly', ptyId: null })
        })
        setState({ mode: 'ephemeral', ptyId: fresh.id })
      } catch {
        // Resume invoke rejected — fall back to read-only.
        if (cancelled) return
        setState({ mode: 'readonly', ptyId: null })
      }
    })()

    return () => {
      cancelled = true
      unsubExit?.()
      // Ephemeral teardown ONLY — never kill/dispose a LIVE session (the worker owns it).
      if (owned) {
        window.api.killSession(owned)
        disposeTerminal(owned)
      }
    }
  }, [armed, sess.id, sess.claudeSessionId, sess.cwd, sess.worktreeRemoved])

  const showTerminal = (state.mode === 'live' || state.mode === 'ephemeral') && state.ptyId

  return (
    <div className="flex min-h-[180px] flex-1 flex-col" style={{ display: active ? 'flex' : 'none' }}>
      {showTerminal ? (
        <div className="relative flex-1 overflow-hidden rounded-lg border border-zinc-800 bg-black/60">
          <Terminal sessionId={state.ptyId!} visible={active} autoFocus={false} />
        </div>
      ) : state.mode === 'resolving' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 bg-black/40 p-3 text-center">
          <span className="inline-block h-3 w-1.5 animate-pulse bg-zinc-500 align-middle" />
          <p className="text-[10px] text-zinc-600">Connecting to session…</p>
        </div>
      ) : sess.worktreeRemoved ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 bg-black/40 p-3 text-center">
          <span className="text-lg text-zinc-700">🔒</span>
          <p className="text-[11px] text-zinc-400">Read-only — worktree removed</p>
          <p className="max-w-xs text-[10px] text-zinc-600">
            This worker built on{sess.worktreeBranch ? <> branch <code className="text-zinc-500">{sess.worktreeBranch}</code></> : ' a worktree'}, which was merged and deleted. The transcript above is preserved; live resume is unavailable.
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 bg-black/40 p-3 text-center">
          <span className="text-lg text-zinc-700">○</span>
          <p className="text-[11px] text-zinc-400">Live resume unavailable</p>
          <p className="max-w-xs text-[10px] text-zinc-600">
            This session can't be resumed{sess.claudeSessionId ? ' right now' : ' (no saved conversation)'}. The milestone feed above is preserved.
          </p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button onClick={onClick} className={`rounded px-2 py-0.5 text-[10px] font-medium ${active ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}>{children}</button>
  )
}

/** Custom project filter dropdown — like a native <select> but renders project colour dots. */
function ProjectPicker({
  value, options, onChange, onOpenChange,
}: {
  value: string | null
  options: string[]
  onChange: (value: string | null) => void
  onOpenChange?: (open: boolean) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Keep the parent's popover flag in sync so its Escape handler can stand down.
  useEffect(() => { onOpenChange?.(open) }, [open, onOpenChange])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Both handlers live on window in the capture phase, so plain
        // stopPropagation() can't stop the view-level one (same target).
        // preventDefault marks the event so PipelineView bails out regardless
        // of listener order; stopImmediatePropagation blocks it directly when
        // we happen to run first.
        e.preventDefault()
        e.stopImmediatePropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    // Capture phase so we beat PipelineView's capture-phase Escape handler.
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const Dot = ({ name }: { name: string | null }): JSX.Element => (
    <span style={{ width: 8, height: 8, borderRadius: '50%', background: name ? projectColor(name) : 'var(--todos-text-faint)', flexShrink: 0 }} />
  )

  const select = (name: string | null): void => { onChange(name); setOpen(false) }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-500 focus:outline-none focus:border-zinc-500"
      >
        <Dot name={value} />
        <span>{value ?? 'All projects'}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <ul className="absolute left-0 z-40 mt-1 max-h-72 min-w-[160px] overflow-y-auto rounded border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
          <li>
            <button
              onClick={() => select(null)}
              className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-zinc-800 ${value == null ? 'text-zinc-100' : 'text-zinc-400'}`}
            >
              <Dot name={null} /> All projects
            </button>
          </li>
          {options.map((n) => (
            <li key={n}>
              <button
                onClick={() => select(n)}
                className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-zinc-800 ${value === n ? 'text-zinc-100' : 'text-zinc-400'}`}
              >
                <Dot name={n} /> {n}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: PipelineSessionStatus }): JSX.Element {
  const meta = STATUS_DOT[status]
  return (
    <span className={`relative h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`}>
      {meta.pulse && <span className={`absolute inset-0 animate-ping rounded-full ${meta.dot} opacity-75`} />}
    </span>
  )
}

function StageStepper({ current }: { current: BoardStage }): JSX.Element {
  const flow = STAGES.filter((s) => s.id !== 'backlog')
  const currentIdx = flow.findIndex((s) => s.id === current)
  return (
    <div className="flex items-center gap-1 border-b border-zinc-800 px-4 py-2.5">
      {flow.map((s, i) => {
        const accent = ACCENT[s.accent]
        const done = currentIdx > i
        const active = currentIdx === i
        return (
          <div key={s.id} className="flex flex-1 items-center gap-1">
            <div className={`flex items-center gap-1.5 ${active ? accent.text : done ? 'text-green-400' : 'text-zinc-600'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${active ? accent.bar : done ? 'bg-green-400' : 'bg-zinc-700'}`} />
              <span className="text-[10px] font-medium">{s.label}</span>
            </div>
            {i < flow.length - 1 && <div className={`h-px flex-1 ${done ? 'bg-green-400/40' : 'bg-zinc-800'}`} />}
          </div>
        )
      })}
    </div>
  )
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className={`transition-transform ${open ? 'rotate-90' : ''}`}>
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PipelineGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-zinc-300">
      <circle cx="4" cy="12" r="2.4" fill="currentColor" />
      <circle cx="12" cy="6" r="2.4" className="fill-violet-400" />
      <circle cx="20" cy="12" r="2.4" className="fill-sky-400" />
      <circle cx="12" cy="18" r="2.4" className="fill-amber-400" />
      <path d="M6 11 11 7M13 7l6 4M19 13l-6 4M11 17 6 13" stroke="currentColor" strokeWidth="1.2" className="text-zinc-700" />
    </svg>
  )
}

function lineColor(line: string): string {
  const t = line.trimStart()
  if (t.startsWith('✓')) return 'text-green-400'
  if (t.startsWith('✗')) return 'text-red-400'
  if (t.startsWith('⚠')) return 'text-amber-300'
  if (t.startsWith('⏵')) return 'text-blue-300'
  if (t.startsWith('✻')) return 'text-violet-300'
  if (t.startsWith('◌')) return 'text-zinc-500'
  return 'text-zinc-300'
}
