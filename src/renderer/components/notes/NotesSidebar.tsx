import { useMemo } from 'react'
import { useStore } from '../../store'
import type { NoteEntry } from './types'

interface Props {
  entries: NoteEntry[]
  projects: Array<{ name: string; manual: boolean }>
  activeProjects: Set<string>
  onSelect: (relPath: string) => void
  onOpenGlobal: () => void
  onCreateNote: (project: string | null, kind: 'note' | 'todo-list') => void
  onDelete: (relPath: string) => void
  onNewProject: () => void
}

interface TreeNode {
  name: string
  relPath: string
  isDir: boolean
  kind?: 'note' | 'todo-list'
  children: TreeNode[]
}

const AGENDA_FILENAME = 'Agenda.todo.yaml'

function buildTree(entries: NoteEntry[], project: string | null): TreeNode {
  const root: TreeNode = { name: project ?? '(root)', relPath: project ?? '', isDir: true, children: [] }
  // Exclude the pinned agenda from the normal tree — we render it separately up top.
  const filtered = entries.filter((e) =>
    e.project === project && !(project && e.subdir.length === 0 && e.name === AGENDA_FILENAME)
  )
  for (const e of filtered) {
    let cursor = root
    const parts = [...e.subdir, e.name]
    const pathSoFar: string[] = project ? [project] : []
    for (let i = 0; i < parts.length; i++) {
      pathSoFar.push(parts[i])
      const isLast = i === parts.length - 1
      const existing = cursor.children.find((c) => c.name === parts[i] && c.isDir !== isLast)
      if (existing) { cursor = existing } else {
        const node: TreeNode = {
          name: parts[i], relPath: pathSoFar.join('/'),
          isDir: !isLast, kind: isLast ? e.kind : undefined, children: [],
        }
        cursor.children.push(node); cursor = node
      }
    }
  }
  function sort(node: TreeNode): void {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    node.children.forEach(sort)
  }
  sort(root)
  return root
}

function Row({
  node, depth, selectedPath, onSelect, onDelete,
}: {
  node: TreeNode; depth: number; selectedPath: string | null
  onSelect: (rel: string) => void; onDelete: (rel: string) => void
}): JSX.Element {
  const selected = node.relPath === selectedPath
  if (node.isDir) {
    return (
      <>
        {depth > 0 && (
          <div
            className="font-mono-ui text-[9px] smallcaps mt-2 mb-1 margin-pull"
            style={{ paddingLeft: 18 + depth * 10, color: 'var(--ink-faint)' }}
          >
            ▸ {node.name}
          </div>
        )}
        {node.children.map((c) => (
          <Row key={c.relPath} node={c} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} onDelete={onDelete} />
        ))}
      </>
    )
  }
  const isTodo = node.kind === 'todo-list'
  const displayName = node.name.replace(/\.todo\.yaml$|\.md$/, '')
  const glyph = isTodo ? '▦' : '◦'
  return (
    <div
      onClick={() => onSelect(node.relPath)}
      onContextMenu={(e) => { e.preventDefault(); onDelete(node.relPath) }}
      className="group relative flex items-baseline gap-2 py-[5px] pr-3 cursor-pointer margin-pull transition-colors"
      style={{
        paddingLeft: 18 + depth * 10,
        color: selected ? 'var(--accent)' : 'var(--ink)',
      }}
    >
      {selected && (
        <span
          className="absolute left-0 top-0 bottom-0"
          style={{ width: 2, background: 'var(--accent)' }}
        />
      )}
      <span
        className="font-mono-ui text-[10px] shrink-0"
        style={{ color: selected ? 'var(--accent)' : 'var(--ink-faint)' }}
      >
        {glyph}
      </span>
      <span
        className={`truncate text-[13px] ${isTodo ? 'font-mono-ui' : 'font-display'} ${!isTodo ? '' : ''}`}
        style={{
          fontWeight: isTodo ? 400 : 400,
          letterSpacing: isTodo ? '-0.01em' : '0',
        }}
      >
        {displayName}
      </span>
    </div>
  )
}

export function NotesSidebar({
  entries, projects, activeProjects,
  onSelect, onOpenGlobal, onCreateNote, onDelete, onNewProject,
}: Props): JSX.Element {
  const expanded = useStore((s) => s.notesExpandedProjects)
  const toggle = useStore((s) => s.toggleNotesProjectExpanded)
  const selectedPath = useStore((s) => s.notesSelectedPath)
  const showInactive = useStore((s) => s.notesShowInactive)
  const setShowInactive = useStore((s) => s.setNotesShowInactive)
  const projectFilter = useStore((s) => s.notesProjectFilter)

  // Visibility rule:
  //   - Manual (user-created) folios always show.
  //   - Session-derived folios show if their session is active, they match the current filter, or "show dormant" is on.
  const visibleProjects = useMemo(
    () => projects.filter((p) => {
      if (p.manual) return true
      if (activeProjects.has(p.name)) return true
      if (p.name === projectFilter) return true
      return showInactive
    }),
    [projects, activeProjects, projectFilter, showInactive],
  )

  const dormantCount = projects.filter(
    (p) => !p.manual && !activeProjects.has(p.name) && p.name !== projectFilter
  ).length

  const rootEntries = entries.filter((e) => e.project === null)

  // Count todos per project for small indicator
  const projectCounts = useMemo(() => {
    const counts = new Map<string, { notes: number; lists: number }>()
    for (const e of entries) {
      if (!e.project) continue
      const c = counts.get(e.project) ?? { notes: 0, lists: 0 }
      if (e.kind === 'note') c.notes++
      else c.lists++
      counts.set(e.project, c)
    }
    return counts
  }, [entries])

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 pt-5 pb-3 shrink-0">
        <button
          onClick={onOpenGlobal}
          className="group w-full text-left ink-press"
        >
          <div className="font-mono-ui text-[9px] smallcaps mb-1" style={{ color: 'var(--ink-faint)' }}>
            Index
          </div>
          <div
            className="font-display italic text-base group-hover:translate-x-0.5 transition-transform"
            style={{ color: 'var(--ink)' }}
          >
            Compendium <span style={{ color: 'var(--accent)' }}>⟶</span>
          </div>
          <div className="font-mono-ui text-[10px] mt-1" style={{ color: 'var(--ink-faint)' }}>
            all entries, every folio
          </div>
        </button>
      </div>

      <div className="hairline mx-5" />

      <div className="flex-1 overflow-y-auto notes-scroll py-3">
        {rootEntries.length > 0 && (
          <div className="mb-4">
            <div className="px-5 mb-1 font-mono-ui text-[9px] smallcaps" style={{ color: 'var(--ink-faint)' }}>
              Loose leaves
            </div>
            {buildTree(entries, null).children.map((n) => (
              <Row key={n.relPath} node={n} depth={0} selectedPath={selectedPath} onSelect={onSelect} onDelete={onDelete} />
            ))}
          </div>
        )}

        <div className="px-5 mb-2 font-mono-ui text-[9px] smallcaps"
          style={{ color: 'var(--ink-faint)' }}>
          Folios · {visibleProjects.length}
        </div>

        {visibleProjects.map(({ name: proj, manual }, idx) => {
          const isOpen = expanded[proj] ?? true
          const tree = buildTree(entries, proj)
          const hasChildren = tree.children.length > 0
          const isActive = activeProjects.has(proj)
          const counts = projectCounts.get(proj) ?? { notes: 0, lists: 0 }
          const roman = toRoman(idx + 1)

          return (
            <section key={proj} className="mb-3">
              <div
                className="group px-5 py-1 flex items-baseline gap-2 cursor-pointer"
                onClick={() => toggle(proj)}
              >
                <span
                  className="font-display italic text-[11px] shrink-0"
                  style={{ color: 'var(--ink-faint)', minWidth: 20 }}
                >
                  {roman}.
                </span>
                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                  <span
                    className="font-display text-[14px] truncate transition-colors"
                    style={{
                      color: isActive ? 'var(--ink)' : 'var(--ink-dim)',
                      fontStyle: 'normal',
                      letterSpacing: '-0.005em',
                    }}
                  >
                    {proj}
                  </span>
                  {isActive && (
                    <span
                      className="w-1 h-1 rounded-full shrink-0 self-center"
                      style={{ background: 'var(--accent)', boxShadow: '0 0 4px var(--accent)' }}
                      title="Active session"
                    />
                  )}
                  {manual && !isActive && (
                    <span className="font-mono-ui text-[8px] smallcaps shrink-0 self-center"
                      style={{ color: 'var(--ink-faint)' }} title="User-created folio">
                      manual
                    </span>
                  )}
                  <span className="ml-auto font-mono-ui text-[9px]" style={{ color: 'var(--ink-faint)' }}>
                    {counts.notes + counts.lists || '—'}
                  </span>
                </div>
              </div>
              <div className="px-5 pl-[46px] flex items-center gap-4 mt-0.5 font-mono-ui text-[9px] smallcaps">
                <button
                  onClick={() => onCreateNote(proj, 'note')}
                  className="ink-press transition-colors hover:brightness-125"
                  style={{ color: 'var(--ink-faint)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ink-faint)')}
                >
                  + entry
                </button>
              </div>

              {isOpen && (
                <div className="mt-1">
                  {/* Pinned agenda — always first, cannot be deleted */}
                  <div
                    onClick={() => onSelect(`${proj}/${AGENDA_FILENAME}`)}
                    className="group relative flex items-baseline gap-2 py-[5px] pr-3 cursor-pointer margin-pull transition-colors"
                    style={{
                      paddingLeft: 28,
                      color: `${proj}/${AGENDA_FILENAME}` === selectedPath ? 'var(--accent)' : 'var(--ink)',
                    }}
                  >
                    {`${proj}/${AGENDA_FILENAME}` === selectedPath && (
                      <span className="absolute left-0 top-0 bottom-0" style={{ width: 2, background: 'var(--accent)' }} />
                    )}
                    <span className="font-mono-ui text-[10px] shrink-0"
                      style={{ color: `${proj}/${AGENDA_FILENAME}` === selectedPath ? 'var(--accent)' : 'var(--accent-deep)' }}>
                      ▦
                    </span>
                    <span className="truncate text-[13px] font-display italic">Agenda</span>
                  </div>
                  {hasChildren && tree.children.map((c) => (
                    <Row key={c.relPath} node={c} depth={1} selectedPath={selectedPath} onSelect={onSelect} onDelete={onDelete} />
                  ))}
                  {!hasChildren && (
                    <div className="pl-[46px] py-1 font-display italic text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                      no other entries
                    </div>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>

      <div className="shrink-0 px-5 py-3" style={{ borderTop: '1px solid var(--rule-strong)' }}>
        <button
          onClick={onNewProject}
          className="w-full text-left ink-press mb-2 group"
        >
          <div className="font-display italic text-[14px] flex items-center gap-2"
            style={{ color: 'var(--ink)' }}>
            <span style={{ color: 'var(--accent)' }}>+</span>
            <span className="group-hover:translate-x-0.5 transition-transform">Open folio</span>
          </div>
        </button>
        {(dormantCount > 0 || showInactive) && (
          <label className="flex items-center gap-2 font-mono-ui text-[10px] smallcaps cursor-pointer"
            style={{ color: 'var(--ink-faint)' }}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            show dormant {dormantCount > 0 && <span>({dormantCount})</span>}
          </label>
        )}
      </div>
    </div>
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
