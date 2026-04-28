import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { CleanupStatus } from '../../preload'

interface CleanupPanelProps {
  visible: boolean
  onClose: () => void
}

type RowKey =
  | 'mcp' | 'hooks' | 'statusline' | 'claudeMd' | 'slashCommands' | 'plugin'
  | 'memory' | 'embeddings' | 'notes' | 'sessions' | 'appSettings'

interface RowDef {
  key: RowKey
  title: string
  description: string
  destructive: boolean
  /** Returns badge label, badge variant, optional detail line, and isInstalled. */
  status: (s: CleanupStatus) => { label: string; variant: 'installed' | 'empty' | 'data'; detail?: string; isInstalled: boolean }
  remove: () => Promise<{ ok: boolean; error?: string }>
  confirmTitle?: string
  confirmBody?: (s: CleanupStatus) => string
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const ROWS: RowDef[] = [
  {
    key: 'mcp',
    title: 'MCP server registration',
    description: 'Entry in ~/.claude.json that lets Claude Code call session-manager tools',
    destructive: false,
    status: (s) => ({
      label: s.mcp.disabled ? 'Disabled' : s.mcp.installed ? 'Installed' : 'Not installed',
      variant: s.mcp.installed ? 'installed' : 'empty',
      isInstalled: s.mcp.installed,
    }),
    remove: () => window.api.cleanupRemoveMcp(),
  },
  {
    key: 'hooks',
    title: 'Claude Code hooks',
    description: 'Notification / Stop / PreToolUse / PostToolUse hooks in ~/.claude/settings.json',
    destructive: false,
    status: (s) => ({
      label: s.hooks.disabled ? 'Disabled' : s.hooks.installed ? 'Installed' : 'Not installed',
      variant: s.hooks.installed ? 'installed' : 'empty',
      isInstalled: s.hooks.installed,
    }),
    remove: () => window.api.cleanupRemoveHooks(),
  },
  {
    key: 'statusline',
    title: 'Statusline',
    description: '~/.claude/statusline-config.json, statusline-command script, and statusLine entry in settings.json',
    destructive: false,
    status: (s) => ({
      label: s.statusline.managed ? 'Managed' : s.statusline.hasCustom ? 'Custom present' : 'Not installed',
      variant: s.statusline.installed ? 'installed' : 'empty',
      isInstalled: s.statusline.installed,
    }),
    remove: () => window.api.cleanupRemoveStatusline(),
    confirmTitle: 'Remove statusline?',
    confirmBody: () => 'Removes the managed config, generated script, and the statusLine key from ~/.claude/settings.json. If you set up a custom statusline outside this app, it will also be cleared.',
  },
  {
    key: 'claudeMd',
    title: 'CLAUDE.md instructions',
    description: 'Block between session-manager-instructions markers in ~/.claude/CLAUDE.md',
    destructive: false,
    status: (s) => ({
      label: s.claudeMd.installed ? 'Installed' : 'Not installed',
      variant: s.claudeMd.installed ? 'installed' : 'empty',
      isInstalled: s.claudeMd.installed,
    }),
    remove: () => window.api.removeClaudeMdInstructions(),
  },
  {
    key: 'slashCommands',
    title: 'Slash commands',
    description: 'sm-*.md files in ~/.claude/commands/ (one per skill)',
    destructive: false,
    status: (s) => ({
      label: s.slashCommands.count > 0 ? `${s.slashCommands.count} installed` : 'Not installed',
      variant: s.slashCommands.installed ? 'installed' : 'empty',
      isInstalled: s.slashCommands.installed,
    }),
    remove: () => window.api.cleanupRemoveSlashCommands(),
  },
  {
    key: 'plugin',
    title: 'Plugin & marketplace',
    description: 'session-manager plugin and session-manager-local marketplace registered with the claude CLI',
    destructive: false,
    status: (s) => ({
      label: s.plugin.disabled ? 'Disabled' : s.plugin.pluginDirExists ? 'Installed' : 'Not installed',
      variant: s.plugin.pluginDirExists ? 'installed' : 'empty',
      isInstalled: s.plugin.pluginDirExists,
    }),
    remove: () => window.api.cleanupRemovePlugin(),
  },
  {
    key: 'memory',
    title: 'Memory notes',
    description: 'Knowledge-base notes stored under userData/memories/',
    destructive: true,
    status: (s) => ({
      label: s.memory.exists ? `${s.memory.files} files · ${fmtBytes(s.memory.bytes)}` : 'Empty',
      variant: s.memory.exists ? 'data' : 'empty',
      isInstalled: s.memory.exists,
    }),
    remove: () => window.api.cleanupRemoveMemory(),
    confirmTitle: 'Delete all memory notes?',
    confirmBody: (s) => `Permanently deletes ${s.memory.files} notes (${fmtBytes(s.memory.bytes)}). This cannot be undone.`,
  },
  {
    key: 'embeddings',
    title: 'Embeddings index & model cache',
    description: 'memory-embeddings.db (semantic-search index) and downloaded ONNX model cache. Bundled model in resources/ is unaffected.',
    destructive: true,
    status: (s) => {
      const bytes = s.embeddings.dbBytes + s.embeddings.modelCacheBytes
      const exists = s.embeddings.dbExists || s.embeddings.modelCacheExists
      const parts: string[] = []
      if (s.embeddings.dbExists) parts.push(`db ${fmtBytes(s.embeddings.dbBytes)}`)
      if (s.embeddings.modelCacheExists) parts.push(`model ${fmtBytes(s.embeddings.modelCacheBytes)}`)
      return {
        label: exists ? parts.join(' · ') : 'Empty',
        variant: exists ? 'data' : 'empty',
        detail: exists ? `Total ${fmtBytes(bytes)}` : undefined,
        isInstalled: exists,
      }
    },
    remove: () => window.api.cleanupRemoveEmbeddings(),
    confirmTitle: 'Remove embeddings?',
    confirmBody: () => 'Deletes the semantic-search index and any downloaded model cache. The index will be rebuilt from your notes on next launch.',
  },
  {
    key: 'notes',
    title: 'Notes & todos',
    description: 'User notes and todo lists stored under userData/notes/',
    destructive: true,
    status: (s) => ({
      label: s.notes.exists ? `${s.notes.files} files · ${fmtBytes(s.notes.bytes)}` : 'Empty',
      variant: s.notes.exists ? 'data' : 'empty',
      isInstalled: s.notes.exists,
    }),
    remove: () => window.api.cleanupRemoveNotes(),
    confirmTitle: 'Delete all notes & todos?',
    confirmBody: (s) => `Permanently deletes ${s.notes.files} files (${fmtBytes(s.notes.bytes)}) including all project notes and agendas. This cannot be undone.`,
  },
  {
    key: 'sessions',
    title: 'Saved sessions',
    description: 'Resumable Claude Code sessions and inter-session message inboxes',
    destructive: true,
    status: (s) => ({
      label: s.sessions.savedExists || s.sessions.messagesExists ? 'Present' : 'Empty',
      variant: s.sessions.savedExists || s.sessions.messagesExists ? 'data' : 'empty',
      isInstalled: s.sessions.savedExists || s.sessions.messagesExists,
    }),
    remove: () => window.api.cleanupRemoveSessions(),
    confirmTitle: 'Clear saved sessions?',
    confirmBody: () => 'Removes the resumable session list and any pending inter-session messages. Active terminals stay open.',
  },
  {
    key: 'appSettings',
    title: 'App settings',
    description: 'UI preferences (hotkeys, default project dir, popup behavior, etc.)',
    destructive: true,
    status: (s) => ({
      label: s.appSettings.exists ? 'Present' : 'Default',
      variant: s.appSettings.exists ? 'data' : 'empty',
      isInstalled: s.appSettings.exists,
    }),
    remove: () => window.api.cleanupResetAppSettings(),
    confirmTitle: 'Reset app settings?',
    confirmBody: () => 'Restores all settings to defaults on next launch. Won\'t affect your data, integrations, or notes.',
  },
]

const INTEGRATION_KEYS: RowKey[] = ['mcp', 'hooks', 'statusline', 'claudeMd', 'slashCommands', 'plugin']
const DATA_KEYS: RowKey[] = ['memory', 'embeddings', 'notes', 'sessions', 'appSettings']

export function CleanupPanel({ visible, onClose }: CleanupPanelProps): JSX.Element {
  const [status, setStatus] = useState<CleanupStatus | null>(null)
  const [busy, setBusy] = useState<RowKey | 'all' | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; onConfirm: () => void } | null>(null)

  const refresh = useCallback(async () => {
    const s = await window.api.cleanupStatus()
    setStatus(s)
  }, [])

  useEffect(() => {
    if (visible) void refresh()
  }, [visible, refresh])

  useEffect(() => {
    if (!visible) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (confirm) setConfirm(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [visible, onClose, confirm])

  const runRemove = useCallback(async (row: RowDef) => {
    setBusy(row.key)
    try {
      await row.remove()
      await refresh()
    } finally {
      setBusy(null)
    }
  }, [refresh])

  const handleClick = useCallback((row: RowDef) => {
    if (!status) return
    const st = row.status(status)
    if (!st.isInstalled) return
    if (row.confirmTitle && row.confirmBody) {
      setConfirm({
        title: row.confirmTitle,
        body: row.confirmBody(status),
        onConfirm: () => { setConfirm(null); void runRemove(row) },
      })
    } else {
      void runRemove(row)
    }
  }, [status, runRemove])

  const removeEverything = useCallback(() => {
    if (!status) return
    setConfirm({
      title: 'Remove everything?',
      body: 'Disconnects every Claude Code integration and deletes all session-manager data on this machine — memory notes, todos, embeddings, saved sessions, app settings. This cannot be undone.',
      onConfirm: async () => {
        setConfirm(null)
        setBusy('all')
        try {
          for (const row of ROWS) {
            const st = row.status(status)
            if (st.isInstalled) await row.remove()
          }
          await refresh()
        } finally {
          setBusy(null)
        }
      },
    })
  }, [status, refresh])

  const renderRow = (row: RowDef): JSX.Element => {
    if (!status) return <></>
    const st = row.status(status)
    const isBusy = busy === row.key || busy === 'all'
    const badgeColor = st.variant === 'installed'
      ? 'text-emerald-400 border-emerald-800 bg-emerald-950/50'
      : st.variant === 'data'
        ? 'text-amber-400 border-amber-800 bg-amber-950/50'
        : 'text-zinc-500 border-zinc-700 bg-zinc-900'
    const canRemove = st.isInstalled && !isBusy

    return (
      <div
        key={row.key}
        className="flex items-center gap-3 px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-200 font-medium">{row.title}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badgeColor}`}>
              {st.label}
            </span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-0.5">{row.description}</p>
          {st.detail && <p className="text-[10px] text-zinc-600 mt-0.5">{st.detail}</p>}
        </div>
        <button
          onClick={() => handleClick(row)}
          disabled={!canRemove}
          className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border ${
            canRemove
              ? row.destructive
                ? 'bg-red-950/40 hover:bg-red-900/60 text-red-300 border-red-900'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-zinc-700'
              : 'bg-zinc-900 text-zinc-600 border-zinc-800 cursor-not-allowed'
          }`}
        >
          {isBusy ? '...' : 'Remove'}
        </button>
      </div>
    )
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-0 z-50 bg-zinc-950 flex flex-col"
        >
          <div className="px-6 py-5 border-b border-zinc-800 flex items-center justify-between shrink-0">
            <div>
              <h2 className="text-sm font-medium text-zinc-200">Cleanup &amp; Uninstall</h2>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Remove anything session-manager has set up on your system. Each item can be removed independently.
              </p>
            </div>
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
            >
              Close
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 max-w-3xl mx-auto w-full">
            <section>
              <h3 className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">Claude Code integrations</h3>
              <p className="text-[11px] text-zinc-600 mb-3">
                These re-install on app launch unless removed here. Removing flips a persistent flag so they stay off.
              </p>
              <div className="space-y-2">
                {INTEGRATION_KEYS.map((k) => renderRow(ROWS.find((r) => r.key === k)!))}
              </div>
            </section>

            <section>
              <h3 className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">Stored data</h3>
              <p className="text-[11px] text-zinc-600 mb-3">
                Destructive — removing data here cannot be undone.
              </p>
              <div className="space-y-2">
                {DATA_KEYS.map((k) => renderRow(ROWS.find((r) => r.key === k)!))}
              </div>
            </section>
          </div>

          <div className="px-6 py-4 border-t border-zinc-800 shrink-0 flex items-center justify-between">
            <p className="text-[11px] text-zinc-600">
              For a complete uninstall, run "Remove everything" then quit and uninstall the app.
            </p>
            <button
              onClick={removeEverything}
              disabled={busy === 'all' || !status}
              className="px-4 py-2 bg-red-950/40 hover:bg-red-900/60 border border-red-900 text-red-300 text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {busy === 'all' ? 'Removing…' : 'Remove everything'}
            </button>
          </div>

          {/* Confirm modal */}
          <AnimatePresence>
            {confirm && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
                onClick={() => setConfirm(null)}
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.12 }}
                  className="bg-zinc-900 border border-zinc-700 rounded-xl p-5 max-w-md w-full mx-4 shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="text-sm font-medium text-zinc-200">{confirm.title}</h3>
                  <p className="text-[11px] text-zinc-400 mt-2 leading-relaxed">{confirm.body}</p>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      onClick={() => setConfirm(null)}
                      className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={confirm.onConfirm}
                      className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
