import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store'

interface CustomComponentDef {
  id: string
  label: string
  description: string
  preview: string
  extract: string
  format: string
  guard?: string
  extractNode?: string  // JS expression for Windows (custom components)
}

interface StatuslineEditorProps {
  visible: boolean
  onClose: () => void
  onSpawn: (skillName: string, content: string) => void
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
  { id: 'rateLimitBar5h', label: '5h rate limit bar', description: 'Visual bar of 5-hour rate limit usage', preview: '5h ███░░░░░░░ 23%', group: 'Rate Limits' },
  { id: 'rateLimitBar7d', label: '7d rate limit bar', description: 'Visual bar of 7-day rate limit usage', preview: '7d ████░░░░░░ 41%', group: 'Rate Limits' },
  { id: 'contextUsage', label: 'Context usage', description: 'Context window usage percentage', preview: 'ctx: 8%', group: 'Session' },
  { id: 'contextBar', label: 'Context bar', description: 'Visual bar of context window usage', preview: 'ctx █░░░░░░░░░ 8%', group: 'Session' },
  { id: 'cost', label: 'Session cost', description: 'Total cost in USD', preview: '$0.12', group: 'Session' },
  { id: 'inputTokens', label: 'Input tokens', description: 'Input tokens in current context', preview: 'in: 12.4k', group: 'Tokens' },
  { id: 'outputTokens', label: 'Output tokens', description: 'Output tokens generated', preview: 'out: 3.2k', group: 'Tokens' },
  { id: 'totalTokens', label: 'Total tokens', description: 'Combined input + output tokens', preview: 'tok: 15.6k', group: 'Tokens' },
  { id: 'cacheReadTokens', label: 'Cache read tokens', description: 'Tokens read from prompt cache', preview: 'cache: 8.1k', group: 'Tokens' },
  { id: 'gitBranch', label: 'Git branch', description: 'Current branch name', preview: '⎇ main', group: 'Workspace' },
  { id: 'linesChanged', label: 'Lines changed', description: 'Lines added and removed', preview: '+156 -23', group: 'Workspace' },
]

const ELEMENT_MAP = new Map(ELEMENTS.map((e) => [e.id, e]))

const IS_WIN = typeof navigator !== 'undefined' && navigator.platform.startsWith('Win')

function buildCustomComponentSkill(scriptPath: string, configPath: string): string {
  const jsonSchema = `\`\`\`json
{
  "model": { "display_name": "Claude Sonnet 4" },
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1718000000 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1718500000 }
  },
  "context_window": {
    "used_percentage": 8.3,
    "total_input_tokens": 12400,
    "total_output_tokens": 3200,
    "current_usage": {
      "input_tokens": 12400,
      "output_tokens": 3200,
      "cache_creation_input_tokens": 1500,
      "cache_read_input_tokens": 8100
    }
  },
  "cost": {
    "total_cost_usd": 0.12,
    "total_lines_added": 156,
    "total_lines_removed": 23
  },
  "workspace": {
    "git_branch": "main"
  }
}
\`\`\``

  if (IS_WIN) {
    return `You are a statusline component designer for Claude Code. The user wants to create a custom statusline component.

## How the statusline works

Claude Code's statusline is powered by a Node.js script at \`${scriptPath}\`. The script receives JSON via stdin on every Claude Code response and outputs a single line of text.

The statusline configuration is stored at \`${configPath}\`. This JSON file tracks which elements are enabled and stores custom component definitions.

## JSON schema available via stdin

The script receives this JSON structure:

${jsonSchema}

## How to register a custom component

Custom components are stored in \`${configPath}\` under the \`customComponents\` array. Each component has:

\`\`\`json
{
  "id": "custom_my_component",
  "label": "My Component",
  "description": "What it does",
  "preview": "example output",
  "extract": "",
  "format": "",
  "extractNode": "JS expression that returns the formatted string (receives parsed JSON as 'd')"
}
\`\`\`

### Important rules for the extractNode field:
- It must be a JavaScript expression that evaluates to a string (or empty string to skip)
- The parsed JSON object is available as \`d\`
- Use optional chaining (\`d.cost?.total_cost_usd\`) for safe access
- Return empty string \`''\` to hide the component when data is unavailable

### Example: Cost warning component

\`\`\`json
{
  "id": "custom_cost_warning",
  "label": "Cost warning",
  "description": "Shows warning icon when session cost exceeds $1",
  "preview": "⚠ $1.23",
  "extract": "",
  "format": "",
  "extractNode": "(() => { const c = d.cost?.total_cost_usd; return c && c > 1 ? \`⚠ $\${c}\` : ''; })()"
}
\`\`\`

## Your task

Ask the user what they want their custom component to display. Then:

1. Design the JavaScript expression for the component
2. Read the current config at \`${configPath}\`
3. Add the new component to the \`customComponents\` array
4. Add the component's id to the \`elements\` array (to enable it)
5. Write the updated config back to \`${configPath}\`

After writing the config, the session manager will automatically regenerate the Node.js script on next toggle or reload.

You can use Unicode characters in the preview and output. ANSI escape codes are NOT supported — the statusline is plain text only.

Be creative! The user might want computed values, conditional formatting, emoji indicators, progress bars, or combinations of existing data. Ask what they'd like to build.`
  }

  return `You are a statusline component designer for Claude Code. The user wants to create a custom statusline component.

## How the statusline works

Claude Code's statusline is powered by a bash script at \`${scriptPath}\`. The script receives JSON via stdin on every Claude Code response and outputs a single line of text.

The statusline configuration is stored at \`${configPath}\`. This JSON file tracks which elements are enabled and stores custom component definitions.

## JSON schema available via stdin

The script receives this JSON structure:

${jsonSchema}

## How to register a custom component

Custom components are stored in \`${configPath}\` under the \`customComponents\` array. Each component has:

\`\`\`json
{
  "id": "custom_my_component",
  "label": "My Component",
  "description": "What it does",
  "preview": "example output",
  "extract": "bash code that extracts and formats the value into a variable",
  "format": "the bash expression that produces the display segment (references the variable from extract)",
  "guard": "VARIABLE_NAME (optional — if set, component is only shown when this variable is non-empty)"
}
\`\`\`

### Important rules for the extract field:
- Use \\n for newlines in the JSON string (the extract is a single JSON string, not an array)
- Extract data from \`$input\` using \`jq\`
- Store the result in a uniquely-named variable (prefix with CUSTOM_ to avoid collisions)

### Example: Cost warning component

\`\`\`json
{
  "id": "custom_cost_warning",
  "label": "Cost warning",
  "description": "Shows warning icon when session cost exceeds $1",
  "preview": "\\u26a0 $1.23",
  "extract": "CUSTOM_COST=$(echo \\"$input\\" | jq -r '.cost.total_cost_usd // empty')\\nCUSTOM_COST_WARN=\\"\\"\\nif [ -n \\"$CUSTOM_COST\\" ]; then\\n  if [ \\"$(echo \\"$CUSTOM_COST > 1.0\\" | bc)\\" -eq 1 ]; then\\n    CUSTOM_COST_WARN=\\"\\u26a0 \\\\$$CUSTOM_COST\\"\\n  fi\\nfi",
  "format": "\\"$CUSTOM_COST_WARN\\"",
  "guard": "CUSTOM_COST_WARN"
}
\`\`\`

## Your task

Ask the user what they want their custom component to display. Then:

1. Design the bash snippet for the component
2. Read the current config at \`${configPath}\`
3. Add the new component to the \`customComponents\` array
4. Add the component's id to the \`elements\` array (to enable it)
5. Write the updated config back to \`${configPath}\`

After writing the config, the session manager will automatically regenerate the bash script on next toggle or reload.

You can use Unicode characters in the preview and output. ANSI escape codes are NOT supported — the statusline is plain text only.

Be creative! The user might want computed values, conditional formatting, emoji indicators, progress bars, or combinations of existing data. Ask what they'd like to build.`
}

export function StatuslineEditor({ visible, onClose, onSpawn }: StatuslineEditorProps): JSX.Element {
  const [enabledElements, setEnabledElements] = useState<string[]>([])
  const [customComponents, setCustomComponents] = useState<CustomComponentDef[]>([])
  const [loaded, setLoaded] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [hasCustom, setHasCustom] = useState(false)
  const [scriptPath, setScriptPath] = useState('')
  const [settingsPath, setSettingsPath] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>()

  const autoFocusOnSpawn = useStore((s) => s.autoFocusOnSpawn)

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 4000)
  }, [])

  // Load config on open
  useEffect(() => {
    if (!visible) return
    setLoaded(false)
    setNeedsSetup(false)
    setToast(null)
    window.api.getStatuslineConfig().then((config) => {
      if (config.managed) {
        setEnabledElements(config.elements)
        setCustomComponents(config.customComponents || [])
        setNeedsSetup(false)
      } else {
        setEnabledElements([])
        setCustomComponents([])
        setNeedsSetup(true)
        setHasCustom(config.hasCustom ?? false)
      }
      setScriptPath(config.scriptPath ?? '~/.claude/statusline-command.sh')
      setSettingsPath(config.settingsPath ?? '~/.claude/settings.json')
      // Derive config path from script path
      const sp = config.scriptPath ?? ''
      setConfigPath(sp.replace(/statusline-command\.sh$/, 'statusline-config.json') || '~/.claude/statusline-config.json')
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

  // Auto-apply: persist config whenever elements change (after initial load)
  const initialLoadDone = useRef(false)
  useEffect(() => {
    if (!loaded) {
      initialLoadDone.current = false
      return
    }
    if (!initialLoadDone.current) {
      initialLoadDone.current = true
      return
    }
    if (needsSetup) return
    window.api.setStatuslineConfig(enabledElements, customComponents)
  }, [enabledElements, customComponents, loaded, needsSetup])

  const toggleElement = useCallback((id: string) => {
    setEnabledElements((prev) => {
      if (prev.includes(id)) return prev.filter((e) => e !== id)
      return [...prev, id]
    })
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
  }, [])

  const handleSetup = useCallback(async () => {
    const success = await window.api.setStatuslineConfig([])
    if (success) {
      setNeedsSetup(false)
      setEnabledElements([])
      setCustomComponents([])
      initialLoadDone.current = true
    }
  }, [])

  const handleDeleteCustom = useCallback((id: string) => {
    setCustomComponents((prev) => prev.filter((c) => c.id !== id))
    setEnabledElements((prev) => prev.filter((e) => e !== id))
  }, [])

  const handleCreateCustom = useCallback(() => {
    const path = scriptPath || '~/.claude/statusline-command.sh'
    const cfgPath = configPath || '~/.claude/statusline-config.json'

    if (autoFocusOnSpawn) {
      onSpawn('statusline-component-creator', buildCustomComponentSkill(path, cfgPath))
      onClose()
    } else {
      onSpawn('statusline-component-creator', buildCustomComponentSkill(path, cfgPath))
      showToast('Custom component session started. Return to terminal view to interact with it.')
    }
  }, [scriptPath, configPath, autoFocusOnSpawn, onSpawn, onClose, showToast])

  // Build preview string from enabled elements (built-in + custom)
  const previewParts = enabledElements
    .map((id) => {
      const builtIn = ELEMENT_MAP.get(id)
      if (builtIn) return builtIn.preview
      const custom = customComponents.find((c) => c.id === id)
      return custom?.preview
    })
    .filter(Boolean)
  const previewString = previewParts.join(' | ') || 'No elements selected'

  // Group built-in elements for display
  const groups = new Map<string, ElementDef[]>()
  for (const el of ELEMENTS) {
    const list = groups.get(el.group) || []
    list.push(el)
    groups.set(el.group, list)
  }

  // Shorten paths for display (macOS: /Users/x → ~, Windows: C:\Users\x → ~)
  const shortenHome = (p: string): string =>
    p.replace(/^\/Users\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/, '~')
  const displayScript = shortenHome(scriptPath)
  const displaySettings = shortenHome(settingsPath)

  const renderToggleRow = (
    id: string,
    label: string,
    description: string,
    preview: string,
    extra?: JSX.Element
  ): JSX.Element => {
    const enabled = enabledElements.includes(id)
    const idx = enabledElements.indexOf(id)
    return (
      <div
        key={id}
        className={`flex items-center gap-3 py-2 px-3 rounded-lg transition-colors ${
          enabled ? 'bg-zinc-800/50' : 'hover:bg-zinc-800/30'
        }`}
      >
        <button
          onClick={() => toggleElement(id)}
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

        <div className="flex-1 min-w-0">
          <div className="text-xs text-zinc-300">{label}</div>
          <div className="text-[10px] text-zinc-600">{description}</div>
        </div>

        <span className={`font-mono text-[10px] px-2 py-0.5 rounded border shrink-0 ${
          enabled
            ? 'text-zinc-300 bg-zinc-800 border-zinc-700'
            : 'text-zinc-600 bg-zinc-900 border-zinc-800'
        }`}>
          {preview}
        </span>

        {enabled && (
          <div className="flex flex-col gap-0.5 shrink-0">
            <button
              onClick={() => moveElement(id, -1)}
              disabled={idx === 0}
              className="text-zinc-600 hover:text-zinc-400 disabled:opacity-30 disabled:hover:text-zinc-600 transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 6.5L5 3.5L8 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              onClick={() => moveElement(id, 1)}
              disabled={idx === enabledElements.length - 1}
              className="text-zinc-600 hover:text-zinc-400 disabled:opacity-30 disabled:hover:text-zinc-600 transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        )}

        {extra}
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
                          Generated {displayScript.endsWith('.js') ? 'Node.js' : 'bash'} script with your selected elements
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
                          {'    '}"command": "{displayScript.endsWith('.js') ? `node "${displayScript}"` : `bash ${displayScript}`}"{'\n'}
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
                      Changes apply automatically. Updated on next Claude Code response.
                    </p>
                  </div>

                  {/* Built-in elements */}
                  {Array.from(groups.entries()).map(([groupName, groupElements]) => (
                    <div key={groupName} className="mb-6">
                      <h3 className="text-[10px] text-zinc-600 uppercase tracking-wider mb-2">{groupName}</h3>
                      <div className="space-y-1">
                        {groupElements.map((el) => renderToggleRow(el.id, el.label, el.description, el.preview))}
                      </div>
                    </div>
                  ))}

                  {/* Custom components */}
                  {customComponents.length > 0 && (
                    <div className="mb-6">
                      <h3 className="text-[10px] text-zinc-600 uppercase tracking-wider mb-2">Custom</h3>
                      <div className="space-y-1">
                        {customComponents.map((c) =>
                          renderToggleRow(
                            c.id, c.label, c.description, c.preview,
                            <button
                              onClick={() => handleDeleteCustom(c.id)}
                              className="text-zinc-700 hover:text-red-400 transition-colors shrink-0 ml-1"
                              title="Delete custom component"
                            >
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                              </svg>
                            </button>
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Create custom component */}
                  <div className="mb-6">
                    <button
                      onClick={handleCreateCustom}
                      className="group w-full rounded-xl border border-dashed border-zinc-700 hover:border-zinc-500 transition-all bg-zinc-900/50 px-4 py-4 text-left flex items-center gap-3"
                    >
                      <span className="w-8 h-8 rounded-lg bg-zinc-800 group-hover:bg-zinc-700 flex items-center justify-center text-zinc-500 group-hover:text-zinc-300 transition-colors text-sm shrink-0">
                        +
                      </span>
                      <div>
                        <div className="text-xs text-zinc-400 group-hover:text-zinc-300 transition-colors font-medium">
                          Create custom component
                        </div>
                        <div className="text-[10px] text-zinc-600">
                          Spawn a Claude session to design and add a custom statusline component
                        </div>
                      </div>
                    </button>
                  </div>

                  {/* Footer */}
                  <div className="mt-8 pt-4 border-t border-zinc-800">
                    <p className="text-[10px] text-zinc-600">
                      Generates {displayScript} ({displayScript.endsWith('.js') ? 'Node.js' : 'bash'})
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Toast notification */}
          <AnimatePresence>
            {toast && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                transition={{ duration: 0.2 }}
                className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 shadow-lg"
              >
                <p className="text-xs text-zinc-300 whitespace-nowrap">{toast}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
