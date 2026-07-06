import { useMemo, useState } from 'react'
import type { CanvasTableCell, CanvasTableSpec } from '../../store'

/** Rows rendered before the "show all" escape hatch. Payloads are already
 *  capped at 2,000 rows server-side; this only bounds DOM size. */
const DISPLAY_ROW_CAP = 300

type SortDir = 'asc' | 'desc'

function compareCells(a: CanvasTableCell, b: CanvasTableCell): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/** Sortable, filterable result-table artifact. All interaction is client-side
 *  over the already-delivered rows — no re-querying. */
export function ResultTable({ table }: { table: CanvasTableSpec }): JSX.Element {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [filter, setFilter] = useState('')
  const [showAll, setShowAll] = useState(false)

  const processed = useMemo(() => {
    let rows = table.rows
    const needle = filter.trim().toLowerCase()
    if (needle) {
      rows = rows.filter((row) =>
        table.columns.some((c) => String(row[c.key] ?? '').toLowerCase().includes(needle)),
      )
    }
    if (sortKey) {
      rows = [...rows].sort((ra, rb) => {
        const cmp = compareCells(ra[sortKey] ?? null, rb[sortKey] ?? null)
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return rows
  }, [table, filter, sortKey, sortDir])

  const visible = showAll ? processed : processed.slice(0, DISPLAY_ROW_CAP)
  const truncated = processed.length - visible.length

  const onHeaderClick = (key: string): void => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
    } else if (sortDir === 'asc') {
      setSortDir('desc')
    } else {
      setSortKey(null) // third click clears the sort
    }
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 px-3 py-2 border-b border-zinc-800/60 flex items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter rows…"
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
        />
        <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">
          {filter ? `${processed.length}/${table.rows.length}` : `${table.rows.length} rows`}
        </span>
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr>
              {table.columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => onHeaderClick(col.key)}
                  className="sticky top-0 bg-[#0d0d0f] px-2.5 py-1.5 text-[10px] font-semibold text-zinc-400 border-b border-zinc-700/60 cursor-pointer select-none hover:text-zinc-200 whitespace-nowrap"
                  style={{ textAlign: col.align ?? 'left' }}
                  title="Click to sort"
                >
                  {col.label ?? col.key}
                  {sortKey === col.key && (
                    <span className="ml-1 text-zinc-500">{sortDir === 'asc' ? '▲' : '▼'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={i} className="hover:bg-zinc-900/50">
                {table.columns.map((col) => {
                  const v = row[col.key]
                  return (
                    <td
                      key={col.key}
                      className={`px-2.5 py-1 border-b border-zinc-900 ${v === null || v === undefined ? 'text-zinc-700' : 'text-zinc-300'} ${typeof v === 'number' ? 'tabular-nums' : ''}`}
                      style={{ textAlign: col.align ?? 'left' }}
                    >
                      {v === null || v === undefined ? '—' : String(v)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {truncated > 0 && (
          <div className="px-3 py-2 text-[10px] text-zinc-500 flex items-center gap-2">
            showing {visible.length} of {processed.length} — refine the filter, or
            <button
              onClick={() => setShowAll(true)}
              className="text-zinc-400 underline decoration-zinc-700 hover:text-zinc-200"
            >
              show all
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
