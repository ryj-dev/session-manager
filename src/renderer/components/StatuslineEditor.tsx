import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface StatuslineEditorProps {
  visible: boolean
  onClose: () => void
}

interface ElementDef {
  id: string
  label: string
  description: string
  preview: string    // mock preview value
  group: string      // visual grouping
}

const ELEMENTS: ElementDef[] = [
  { id: 'model', label: 'Model name', description: 'Current Claude model', preview: '[Claude Sonnet 4]', group: 'General' },
  { id: 'rateLimit5h', label: '5h rate limit', description: 'Five-hour rolling window usage', preview: '5h: 23%', group: 'Rate Limits' },
  { id: 'rateLimit7d', label: '7d rate limit', description: 'Seven-day rolling window usage', preview: '7d: 41%', group: 'Rate Limits' },
  { id: 'resetTime5h', label: '5h reset time', description: 'Time until 5-hour limit resets', preview: '5h reset: 2h 15m', group: 'Rate Limits' },
  { id: 'resetTime7d', label: '7d reset time', description: 'Time until 7-day limit resets', preview: '7d reset: 3d 8h', group: 'Rate Limits' },
  { id: 'contextUsage', label: 'Context usage', description: 'Context window usage percentage', preview: 'ctx: 8%', group: 'Session' },
  { id: 'cost', label: 'Session cost', description: 'Total cost in USD', preview: '$0.12', group: 'Session' },
  { id: 'gitBranch', label: 'Git branch', description: 'Current branch name', preview: '⎇ main', group: 'Workspace' },
  { id: 'linesChanged', label: 'Lines changed', description: 'Lines added and removed', preview: '+156 -23', group: 'Workspace' },
]

const ELEMENT_MAP = new Map(ELEMENTS.map((e) => [e.id, e]))

export function StatuslineEditor({ visible, onClose }: StatuslineEditorProps): JSX.Element {
  const [enabledElements, setEnabledElements] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [hasCustom, setHasCustom] = useState(false)
  const [scriptPath, setScriptPath] = useState('')
  const [settingsPath, setSettingsPath] = useState('')

  // Load config on open
  useEffect(() => {
    if (!visible) return
    setLoaded(false)
    setSaved(false)
    setNeedsSetup(false)
    window.api.getStatuslineConfig().then((config) => {
      if (config.managed) {
        setEnabledElements(config.elements)
        setNeedsSetup(false)
      } else {
        // No managed config — show setup prompt
        setEnabledElements([])
        setNeedsSetup(true)
        setHasCustom(config.hasCustom ?? false)
        setScriptPath(config.scriptPath ?? '~/.claude/statusline-command.sh')
        setSettingsPath(config.settingsPath ?? '~/.claude/settings.json')
      }
      setLoaded(true)
    })
  }, [visible])

  // Escape to close
  useEffect(() => {
    if (!visible) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [visible, onClose])

  const toggleElement = useCallback((id: string) => {
    setEnabledElements((prev) => {
      if (prev.includes(id)) return prev.filter((e) => e !== id)
      return [...prev, id]
    })
    setSaved(false)
  }, [])

  const moveElement = useCallback((id: string, direction: -1 | 1) => {
    setEnabledElements((prev) => {
      const idx = prev.indexOf(id)
      if (idx === -1) return prev
      const target = idx + direction
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      next[idx] = next[target]
      next[target] = id
      return next
    })
    setSaved(false)
  }, [])

  const handleSave = useCallback(async () => {
    const success = await window.api.setStatuslineConfig(enabledElements)
    if (success) {
      setSaved(true)
      setNeedsSetup(false)
    }
  }, [enabledElements])

  const handleSetup = useCallback(async () => {
    // Create with no elements enabled — user will toggle what they want
    const success = await window.api.setStatuslineConfig([])
    if (success) {
      setNeedsSetup(false)
      setEnabledElements([])
    }
  }, [])

  // Build preview string
  const previewParts = enabledElements
    .map((id) => ELEMENT_MAP.get(id)?.preview)
    .filter(Boolean)
  const previewString = previewParts.join(' | ') || 'No elements selected'

  // Group elements for display
  const groups = new Map<string, ElementDef[]>()
  for (const el of ELEMENTS) {
    const list = groups.get(el.group) || []
    list.push(el)
    groups.set(el.group, list)
  }

  // Shorten paths for display
  const displayScript = scriptPath.replace(/^\/Users\/[^/]+/, '~')
  const displaySettings = settingsPath.replace(/^\/Users\/[^/]+/, '~')

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
          {/* Titlebar */}
          <div className="h-10 flex items-center px-4 shrink-0 titlebar-drag border-b border-zinc-800/50">
            <button
              onClick={onClose}
              className="titlebar-no-drag flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M7.5 2.5L4 6L7.5 9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Settings
            </button>
            <span className="ml-3 text-xs text-zinc-400 font-medium">Statusline</span>
            <span className="ml-auto titlebar-no-drag text-[10px] text-zinc-600">Esc close</span>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-6 py-8">

              {/* Setup prompt — shown when no managed config exists */}
              {loaded && needsSetup && (
                <div className="flex flex-col items-center justify-center py-16">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 max-w-md w-full">
                    <h3 className="text-sm text-zinc-200 font-medium mb-3">
                      {hasCustom ? 'Custom statusline detected' : 'No statusline configured'}
                    </h3>

                    {hasCustom ? (
                      <p className="text-xs text-zinc-400 leading-relaxed mb-4">
                        You have an existing statusline script configured in{' '}
                        <code className="text-zinc-300 bg-zinc-800 px-1 rounded">{displaySettings}</code>.
                        Setting up the editor will replace it with a managed script.
                      </p>
                    ) : (
                      <p className="text-xs text-zinc-400 leading-relaxed mb-4">
                        The statusline displays persistent info at the bottom of Claude Code.
                        This will create a managed script and configure it in your settings.
                      </p>
                    )}

                    <div className="bg-zinc-800/50 rounded-lg p-3 mb-5 space-y-2.5">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] text-zinc-500 shrink-0">create</span>
                          <code className="text-[10px] text-zinc-300 break-all">{displayScript}</code>
                        </div>
                        <div className="text-[10px] text-zinc-600 ml-[3.25rem]">
                          Generated bash script with your selected elements
                        </div>
                      </div>
                      <div className="border-t border-zinc-700/50 pt-2.5">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[10px] text-zinc-500 shrink-0">{hasCustom ? 'replace' : 'add to'}</span>
                          <code className="text-[10px] text-zinc-300 break-all">{displaySettings}</code>
                        </div>
                        <pre className="text-[10px] leading-relaxed font-mono rounded bg-zinc-900/80 border border-zinc-700/40 px-2.5 py-2 overflow-x-auto">
                          <span className="text-emerald-400/80">+ "statusLine": {'{\n'}
                          {'    '}"type": "command",{'\n'}
                          {'    '}"command": "bash {displayScript}"{'\n'}
                          {'  }'}</span>
                        </pre>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={handleSetup}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        Set up statusline
                      </button>
                      <button
                        onClick={onClose}
                        className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Editor — shown when managed config exists */}
              {loaded && !needsSetup && (
                <>
                  {/* Preview */}
                  <div className="mb-8">
                    <h3 className="text-[10px] text-zinc-600 uppercase tracking-wider mb-2">Preview</h3>
                    <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 font-mono text-xs text-zinc-300 overflow-x-auto whitespace-nowrap">
                      {previewString}
                    </div>
                    <p className="text-[10px] text-zinc-600 mt-1.5">
                      This is how your statusline will appear at the bottom of Claude Code. Elements are separated by |
                    </p>
                  </div>

                  {/* Elements */}
                  {Array.from(groups.entries()).map(([groupName, groupElements]) => (
                    <div key={groupName} className="mb-6">
                      <h3 className="text-[10px] text-zinc-600 uppercase tracking-wider mb-2">{groupName}</h3>
                      <div className="space-y-1">
                        {groupElements.map((el) => {
                          const enabled = enabledElements.includes(el.id)
                          const idx = enabledElements.indexOf(el.id)
                          return (
                            <div
                              key={el.id}
                              className={`flex items-center gap-3 py-2 px-3 rounded-lg transition-colors ${
                                enabled ? 'bg-zinc-800/50' : 'hover:bg-zinc-800/30'
                              }`}
                            >
                              {/* Toggle */}
                              <button
                                onClick={() => toggleElement(el.id)}
                                className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 ${
                                  enabled ? 'bg-blue-500' : 'bg-zinc-700'
                                }`}
                              >
                                <div
                                  className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
                                    enabled ? 'translate-x-[16px]' : 'translate-x-[2px]'
                                  }`}
                                />
                              </button>

                              {/* Label & description */}
                              <div className="flex-1 min-w-0">
                                <div className="text-xs text-zinc-300">{el.label}</div>
                                <div className="text-[10px] text-zinc-600">{el.description}</div>
                              </div>

                              {/* Preview chip */}
                              <span className={`font-mono text-[10px] px-2 py-0.5 rounded border shrink-0 ${
                                enabled
                                  ? 'text-zinc-300 bg-zinc-800 border-zinc-700'
                                  : 'text-zinc-600 bg-zinc-900 border-zinc-800'
                              }`}>
                                {el.preview}
                              </span>

                              {/* Reorder buttons (only for enabled) */}
                              {enabled && (
                                <div className="flex flex-col gap-0.5 shrink-0">
                                  <button
                                    onClick={() => moveElement(el.id, -1)}
                                    disabled={idx === 0}
                                    className="text-zinc-600 hover:text-zinc-400 disabled:opacity-30 disabled:hover:text-zinc-600 transition-colors"
                                  >
                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                      <path d="M2 6.5L5 3.5L8 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={() => moveElement(el.id, 1)}
                                    disabled={idx === enabledElements.length - 1}
                                    className="text-zinc-600 hover:text-zinc-400 disabled:opacity-30 disabled:hover:text-zinc-600 transition-colors"
                                  >
                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  </button>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}

                  {/* Save */}
                  <div className="flex items-center gap-3 mt-8 pt-4 border-t border-zinc-800">
                    <button
                      onClick={handleSave}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      Apply
                    </button>
                    {saved && (
                      <span className="text-[10px] text-emerald-400">
                        Statusline updated. Changes take effect on next Claude Code response.
                      </span>
                    )}
                    <p className="text-[10px] text-zinc-600 ml-auto">
                      Generates {displayScript}
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
