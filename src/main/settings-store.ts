import { app } from 'electron'
import { join } from 'path'
import { readFileSync, mkdirSync } from 'fs'
import { atomicWriteSync } from './atomic-write'

import { defaultHotkeysFor, type HotkeyMap } from '../shared/hotkeys'

export type { HotkeyMap } from '../shared/hotkeys'

export const defaultHotkeys: HotkeyMap = defaultHotkeysFor(process.platform === 'darwin')

/** Default layer selection + tool-activity level for the Share Turn modal. */
export interface TurnShareDefaults {
  prompt: boolean
  tool: boolean
  result: boolean
  toolLevel: 'summary' | 'commands' | 'full'
}

export const defaultTurnShareDefaults: TurnShareDefaults = {
  prompt: true,
  tool: true,
  result: true,
  toolLevel: 'commands',
}

export type MessagePopupMode = 'manual' | 'timed' | 'disabled'

export interface DisabledIntegrations {
  mcp?: boolean
  hooks?: boolean
  plugin?: boolean
}

export interface AppSettings {
  baseProjectsDir: string | null
  autoFocusOnSpawn: boolean
  persistExplorerPath: boolean
  explorerFollowsProject: boolean
  colorExplorerByProject: boolean
  hotkeys: HotkeyMap
  messagePopup: MessagePopupMode
  messagePopupSeconds: number
  todosShowCompleted?: boolean
  todosSelectedTags?: string[]
  todosDetailWidth?: number
  completedFilter?: 'all' | 'day' | 'week' | 'month'
  disabledIntegrations?: DisabledIntegrations
  autoModeForChildSessions: boolean
  autoModeForManualSessions: boolean
  autoModeForRestoredSessions: boolean
  ambientTodoNudge: boolean
  /** Mix Session Manager feature tips into Claude Code's spinner tips
   *  (injected per-spawn via `claude --settings`). Opt-in, default false. */
  injectSpinnerTips: boolean
  /** Prompt-time memory injection: semantically match memory notes against
   *  submitted prompts and inject the top hits as context. Opt-in. */
  memoryInjectionMode: 'off' | 'first' | 'every'
  /** Max notes injected across one session; null = unlimited. */
  memoryInjectionSessionCap: number | null
  /** How similar a note must be to inject (strictness preset). */
  memoryInjectionThreshold: 'super-strict' | 'strict' | 'balanced' | 'lenient'
  /** Auto-display image paths from the user's submitted prompts on the
   *  session's canvas (drag-dropped / typed paths). Default true. */
  canvasAutoShowUserImages: boolean
  spawnIntoCurrentSplit: boolean
  /**
   * How a freshly-spawned Claude session is paired with a shell:
   *   - 'off'     : no shell spawned
   *   - 'split'   : shell opens alongside in a 2-pane split view
   *   - 'overlay' : shell attached as a hidden right-edge hover sidebar
   */
  terminalPairingMode: 'off' | 'split' | 'overlay'
  pipelineDefaultAutonomy?: 'manual' | 'gated' | 'auto'
  /** Share Turn export folder. Blank/null = `<projectPath>/turns/`. */
  turnExportFolder: string | null
  turnShareDefaults: TurnShareDefaults
  /** Cmd+B branch: open the fork beside the original in a split group. */
  openBranchInSplit: boolean
  /** GitHub panel: PR-state filter. 'active' hides merged/closed. */
  githubStateFilter?: 'active' | 'all'
  /** GitHub panel: how far back to show items (by notification updatedAt). */
  githubRangeFilter?: 'day' | 'week' | 'month' | 'all'
  /** Per-event auto-review modes. 'off' = manual buttons only; 'draft' =
   *  auto-spawn an agent whose response lands as a draft awaiting Submit;
   *  'auto' = agent's response is submitted immediately. */
  githubAutoReview?: GithubAutoReviewRules
}

export type GithubAutoMode = 'off' | 'draft' | 'auto'

export interface GithubAutoReviewRules {
  reviewRequest: GithubAutoMode
  mention: GithubAutoMode
  myPrActivity: GithubAutoMode
}

export const defaultGithubAutoReview: GithubAutoReviewRules = {
  reviewRequest: 'off',
  mention: 'off',
  myPrActivity: 'off',
}

const defaults: AppSettings = {
  baseProjectsDir: null,
  autoFocusOnSpawn: true,
  persistExplorerPath: true,
  explorerFollowsProject: true,
  colorExplorerByProject: false,
  hotkeys: { ...defaultHotkeys },
  messagePopup: 'manual',
  messagePopupSeconds: 15,
  todosShowCompleted: false,
  todosSelectedTags: [],
  todosDetailWidth: 460,
  completedFilter: 'week',
  disabledIntegrations: {},
  autoModeForChildSessions: false,
  autoModeForManualSessions: false,
  autoModeForRestoredSessions: false,
  ambientTodoNudge: false,
  injectSpinnerTips: false,
  memoryInjectionMode: 'off',
  memoryInjectionSessionCap: null,
  memoryInjectionThreshold: 'balanced',
  canvasAutoShowUserImages: true,
  spawnIntoCurrentSplit: false,
  terminalPairingMode: 'off',
  pipelineDefaultAutonomy: 'gated',
  turnExportFolder: null,
  turnShareDefaults: { ...defaultTurnShareDefaults },
  openBranchInSplit: true,
  githubStateFilter: 'active',
  githubRangeFilter: 'week',
  githubAutoReview: { ...defaultGithubAutoReview },
}

export function setDisabledIntegration(key: keyof DisabledIntegrations, value: boolean): void {
  const current = loadSettings()
  const disabled: DisabledIntegrations = { ...(current.disabledIntegrations ?? {}) }
  if (value) disabled[key] = true
  else delete disabled[key]
  saveSettings({ ...current, disabledIntegrations: disabled })
}

function getSettingsPath(): string {
  const dir = join(app.getPath('userData'), 'state')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const data = readFileSync(getSettingsPath(), 'utf-8')
    const parsed = JSON.parse(data)
    return {
      ...defaults,
      ...parsed,
      hotkeys: { ...defaults.hotkeys, ...parsed.hotkeys },
      turnShareDefaults: { ...defaults.turnShareDefaults, ...parsed.turnShareDefaults },
      githubAutoReview: { ...defaultGithubAutoReview, ...parsed.githubAutoReview },
    }
  } catch {
    return { ...defaults }
  }
}

export function saveSettings(settings: AppSettings): void {
  atomicWriteSync(getSettingsPath(), JSON.stringify(settings, null, 2))
}
