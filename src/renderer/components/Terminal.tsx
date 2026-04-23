import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

interface TerminalProps {
  sessionId: string
  visible: boolean
  onTitleChange?: (title: string) => void
}

// Global xterm instances — persist across React renders and remounts
const terminalInstances = new Map<
  string,
  { term: XTerm; fitAddon: FitAddon; webglAddon: WebglAddon | null; initialized: boolean; cleanup?: () => void }
>()

// Persistent sticky-scroll state per terminal. Tracks whether the user has
// intentionally scrolled up (via wheel/touch). When false, every PTY data
// write forces scroll-to-bottom — this is immune to xterm's _isUserScrolling
// flag getting corrupted by fit() reflows or other stray scroll events.
const stickyScrollState = new Map<string, { userScrolledUp: boolean }>()

// Tracks when each terminal has performed its first render (i.e. the canvas
// has actual content). Used by snapshot capture to fire on the exact paint,
// avoiding timer-based guessing.
const terminalReadyState = new Map<string, { ready: boolean; waiters: Array<() => void> }>()

export function onTerminalReady(sessionId: string, cb: () => void): () => void {
  let state = terminalReadyState.get(sessionId)
  if (!state) {
    state = { ready: false, waiters: [] }
    terminalReadyState.set(sessionId, state)
  }
  if (state.ready) {
    queueMicrotask(cb)
    return () => {}
  }
  state.waiters.push(cb)
  return () => {
    const s = terminalReadyState.get(sessionId)
    if (!s) return
    s.waiters = s.waiters.filter((w) => w !== cb)
  }
}

function markTerminalReady(sessionId: string): void {
  let state = terminalReadyState.get(sessionId)
  if (!state) {
    state = { ready: true, waiters: [] }
    terminalReadyState.set(sessionId, state)
    return
  }
  if (state.ready) return
  state.ready = true
  const waiters = state.waiters
  state.waiters = []
  for (const w of waiters) w()
}

export function clearTerminalReady(sessionId: string): void {
  terminalReadyState.delete(sessionId)
}

export function getTerminalCanvas(sessionId: string): HTMLCanvasElement | null {
  const instance = terminalInstances.get(sessionId)
  if (!instance) return null

  const canvases = instance.term.element?.querySelectorAll('canvas')
  if (!canvases || canvases.length === 0) return null

  if (instance.webglAddon) {
    // WebGL active: the rendered text is on the last canvas (no xterm-*-layer class)
    return canvases[canvases.length - 1] as HTMLCanvasElement
  }

  // Canvas renderer: the text canvas has the xterm-text-layer class, or fallback to last canvas
  const textCanvas = instance.term.element?.querySelector('canvas.xterm-text-layer') as HTMLCanvasElement | null
  return textCanvas ?? (canvases[canvases.length - 1] as HTMLCanvasElement)
}

/**
 * Load (or reload) the WebGL addon for a terminal instance.
 * After context loss, schedules automatic re-creation so off-screen
 * terminals (graph view) recover their canvas for snapshot capture.
 */
function loadWebGL(instance: { term: XTerm; webglAddon: WebglAddon | null }): void {
  if (instance.webglAddon) return
  try {
    const addon = new WebglAddon(true)
    addon.onContextLoss(() => {
      console.warn('[Terminal] WebGL context lost, will recreate in 1s')
      try { addon.dispose() } catch { /* already disposed */ }
      instance.webglAddon = null
      // Auto-recreate after GPU stabilizes — needed for off-screen terminals
      // that never get visible=true (graph view snapshots)
      setTimeout(() => loadWebGL(instance), 1000)
    })
    instance.term.loadAddon(addon)
    instance.webglAddon = addon
  } catch {
    // WebGL not available — canvas renderer fallback
  }
}

function getOrCreateInstance(sessionId: string): { term: XTerm; fitAddon: FitAddon; webglAddon: WebglAddon | null; initialized: boolean; cleanup?: () => void } {
  let instance = terminalInstances.get(sessionId)
  if (instance) return instance

  const term = new XTerm({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
    lineHeight: 1.2,
    theme: {
      background: '#0a0a0a',
      foreground: '#e4e4e7',
      cursor: '#e4e4e7',
      selectionBackground: '#3f3f46',
      black: '#18181b',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#eab308',
      blue: '#3b82f6',
      magenta: '#a855f7',
      cyan: '#06b6d4',
      white: '#e4e4e7',
      brightBlack: '#52525b',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#facc15',
      brightBlue: '#60a5fa',
      brightMagenta: '#c084fc',
      brightCyan: '#22d3ee',
      brightWhite: '#fafafa'
    }
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

  instance = { term, fitAddon, webglAddon: null, initialized: false }
  terminalInstances.set(sessionId, instance)
  return instance
}

// Minimum dimensions to prevent 1-column wrapping when off-screen
const MIN_COLS = 80
const MIN_ROWS = 24

// Active scroll guards keyed by sessionId — allows cleanup on re-entry
const activeScrollGuards = new Map<string, () => void>()

/**
 * Install a reactive scroll guard that keeps the viewport pinned to the bottom.
 *
 * After fit(), xterm's async reflow fires DOM scroll events that set its internal
 * _isUserScrolling flag, preventing auto-scroll on subsequent output. Instead of
 * racing with frame-counting (which is fragile), this guard listens for scroll
 * events and snaps back to bottom — reacting to the reflow whenever it actually
 * happens rather than guessing when.
 *
 * The guard auto-expires after `duration` ms. Real user scrolls (wheel/touch)
 * cancel it immediately so we don't fight the user.
 */
function installScrollGuard(sessionId: string, term: XTerm, duration = 300, onDone?: () => void): void {
  // Clean up any existing guard for this session
  activeScrollGuards.get(sessionId)?.()

  const viewport = term.element?.querySelector('.xterm-viewport') as HTMLElement | null
  if (!viewport) {
    term.scrollToBottom()
    onDone?.()
    return
  }

  let cancelled = false

  const snapToBottom = (): void => {
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
    term.scrollToBottom()
  }

  // Immediately snap to bottom
  snapToBottom()

  // React to any scroll-away events (caused by xterm reflow) by snapping back
  const onScroll = (): void => {
    if (cancelled) return
    const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
    if (gap > 2) {
      snapToBottom()
    }
  }

  // Poll every frame — catches scrollHeight changes from xterm reflow that
  // don't fire a scroll event (e.g. viewport starts at scrollTop=0 and stays
  // there while scrollHeight grows).
  let rafId: number
  const poll = (): void => {
    if (cancelled) return
    const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
    if (gap > 2) {
      snapToBottom()
    }
    rafId = requestAnimationFrame(poll)
  }
  rafId = requestAnimationFrame(poll)

  // Real user scroll intent — cancel the guard so we don't fight the user
  const onUserScroll = (): void => {
    cleanup()
  }

  const cleanup = (): void => {
    if (cancelled) return
    cancelled = true
    viewport.removeEventListener('scroll', onScroll)
    viewport.removeEventListener('wheel', onUserScroll)
    viewport.removeEventListener('touchmove', onUserScroll)
    cancelAnimationFrame(rafId)
    clearTimeout(timer)
    activeScrollGuards.delete(sessionId)
    onDone?.()
  }

  viewport.addEventListener('scroll', onScroll)
  viewport.addEventListener('wheel', onUserScroll)
  viewport.addEventListener('touchmove', onUserScroll)

  // Auto-expire — by this point xterm's reflow is long done
  const timer = setTimeout(cleanup, duration)
  activeScrollGuards.set(sessionId, cleanup)
}

export function Terminal({ sessionId, visible, onTitleChange }: TerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // Ref so the title change listener always calls the latest callback
  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange

  // Mount or reparent the xterm element into our container
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const instance = getOrCreateInstance(sessionId)
    const { term, fitAddon } = instance

    if (!instance.initialized) {
      // First time: open xterm into this container
      term.open(el)
      instance.initialized = true

      // Load WebGL addon (preserveDrawingBuffer needed for snapshot capture)
      loadWebGL(instance)

      // On Windows/Linux, Ctrl+C/V should copy/paste instead of being sent to PTY.
      // On Mac, Cmd+C/V are handled natively by the browser.
      const isMac = navigator.platform.startsWith('Mac')
      if (!isMac) {
        term.attachCustomKeyEventHandler((e) => {
          if (e.type !== 'keydown') return true
          // Block all Alt+key combos from reaching the PTY — Alt is the app's
          // hotkey modifier on Windows/Linux (like Cmd on Mac), so these should
          // never be forwarded as terminal escape sequences.
          if (e.altKey && e.key !== 'Alt') return false
          if (e.ctrlKey && e.key === 'c' && term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection())
            term.clearSelection()
            e.preventDefault()
            return false
          }
          if (e.ctrlKey && e.key === 'v') {
            navigator.clipboard.readText().then((text) => {
              if (text) term.paste(text)
            })
            e.preventDefault()
            return false
          }
          return true
        })
      }

      // Forward keyboard input to PTY
      term.onData((data) => {
        window.api.writeSession(sessionId, data)
      })

      // Persistent sticky-scroll: track user scroll intent via wheel events
      // so we know whether to auto-scroll on PTY output.
      const scrollInfo = { userScrolledUp: false }
      stickyScrollState.set(sessionId, scrollInfo)

      // wheel-up = user wants to read scrollback, don't fight them
      const onWheel = (e: WheelEvent): void => {
        if (e.deltaY < 0) {
          scrollInfo.userScrolledUp = true
        } else if (e.deltaY > 0) {
          // Scrolling down — check if we've reached the bottom
          const vp = term.element?.querySelector('.xterm-viewport') as HTMLElement | null
          if (vp) {
            // Check after the scroll event processes
            requestAnimationFrame(() => {
              const gap = vp.scrollHeight - vp.clientHeight - vp.scrollTop
              if (gap <= 5) {
                scrollInfo.userScrolledUp = false
              }
            })
          }
        }
      }
      // Keyboard scrolling (shift+pageup etc.) back to bottom re-engages auto-scroll
      const onVpScroll = (): void => {
        const vp = term.element?.querySelector('.xterm-viewport') as HTMLElement | null
        if (vp) {
          const gap = vp.scrollHeight - vp.clientHeight - vp.scrollTop
          if (gap <= 5) {
            scrollInfo.userScrolledUp = false
          }
        }
      }

      // Attach after open() so term.element exists
      const termEl = term.element
      termEl?.addEventListener('wheel', onWheel)
      const viewport = termEl?.querySelector('.xterm-viewport')
      viewport?.addEventListener('scroll', onVpScroll)

      // Listen for PTY data — after each write, force scroll-to-bottom unless
      // user has scrolled up. This bypasses xterm's _isUserScrolling entirely.
      // The write() callback fires after xterm has parsed AND rendered the
      // chunk, so it doubles as our "terminal has painted real content"
      // signal — fire the ready event exactly once on the first write.
      // Fire the "ready" signal once the data burst has settled — the first
      // chunk from a resumed PTY is often just a cursor-position report or a
      // tiny ack; the real screen content arrives in follow-up writes. We
      // restart a short debounce on every chunk and fire when it's quiet.
      // Fire the "ready" signal once the data burst has settled — the first
      // chunk from a resumed PTY is often just a cursor-position report or a
      // tiny ack; the real screen content arrives in follow-up writes. We
      // restart a short debounce on every chunk and fire when it's quiet.
      let readyTimer: ReturnType<typeof setTimeout> | null = null
      let readyFired = false
      const READY_DEBOUNCE_MS = 400
      const unsubPtyData = window.api.onPtyData(sessionId, (data) => {
        term.write(data, () => {
          if (!scrollInfo.userScrolledUp) {
            term.scrollToBottom()
          }
          if (readyFired) return
          if (readyTimer) clearTimeout(readyTimer)
          readyTimer = setTimeout(() => {
            readyTimer = null
            readyFired = true
            markTerminalReady(sessionId)
          }, READY_DEBOUNCE_MS)
        })
      })

      instance.cleanup = () => {
        unsubPtyData()
        termEl?.removeEventListener('wheel', onWheel)
        viewport?.removeEventListener('scroll', onVpScroll)
        stickyScrollState.delete(sessionId)
      }

      // Trim trailing whitespace from copied text (like iTerm2 does)
      term.element?.addEventListener('copy', (e: ClipboardEvent) => {
        const selection = term.getSelection()
        if (selection && e.clipboardData) {
          const trimmed = selection.split('\n').map(line => line.trimEnd()).join('\n')
          e.clipboardData.setData('text/plain', trimmed)
          e.preventDefault()
        }
      })

      // Zoom with Ctrl+=/- (or Cmd+=/- on Mac)
      const onZoomKey = (e: KeyboardEvent): void => {
        const mod = e.metaKey || e.ctrlKey
        if (!mod) return
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          const newSize = Math.min(term.options.fontSize! + 1, 32)
          term.options.fontSize = newSize
          fitAddon.fit()
          window.api.resizeSession(sessionId, term.cols, term.rows)
        } else if (e.key === '-') {
          e.preventDefault()
          const newSize = Math.max(term.options.fontSize! - 1, 8)
          term.options.fontSize = newSize
          fitAddon.fit()
          window.api.resizeSession(sessionId, term.cols, term.rows)
        } else if (e.key === '0') {
          e.preventDefault()
          term.options.fontSize = 14
          fitAddon.fit()
          window.api.resizeSession(sessionId, term.cols, term.rows)
        }
      }
      term.element?.addEventListener('keydown', onZoomKey)

      // Capture terminal title changes — use ref so callback is never stale
      term.onTitleChange((title) => {
        onTitleChangeRef.current?.(title)
      })



      // Initial fit — always attempt even when off-screen (container has real
      // dimensions behind the UI layer). Without this the xterm cols/rows stay at
      // the 80×24 default while the PTY was spawned at 120×30, causing snapshot
      // text to wrap incorrectly until the terminal is focused and refitted.
      if (el.offsetWidth > 100 && el.offsetHeight > 100) {
        requestAnimationFrame(() => {
          fitAddon.fit()
          window.api.resizeSession(sessionId, term.cols, term.rows)
        })
      } else {
        // Container not laid out yet — wait for it via ResizeObserver
        const initObserver = new ResizeObserver(() => {
          if (el.offsetWidth > 100 && el.offsetHeight > 100) {
            initObserver.disconnect()
            fitAddon.fit()
            window.api.resizeSession(sessionId, term.cols, term.rows)
          }
        })
        initObserver.observe(el)
      }
    } else if (term.element && term.element.parentElement !== el) {
      // Already initialized but container changed (remount) — reparent the DOM element
      el.appendChild(term.element)
      // Force WebGL to re-render after DOM reparent so snapshots stay sharp
      requestAnimationFrame(() => {
        term.refresh(0, term.rows - 1)
      })
    }
  }, [sessionId])

  // Re-create WebGL addon if context was lost and terminal becomes visible
  useEffect(() => {
    if (!visible) return
    const instance = terminalInstances.get(sessionId)
    if (!instance || instance.webglAddon) return
    loadWebGL(instance)
  }, [sessionId, visible])

  // Refit ONLY when visible — never resize the PTY when off-screen
  useEffect(() => {
    if (!visible) return

    const el = containerRef.current
    const instance = terminalInstances.get(sessionId)
    if (!el || !instance) return

    let isInitialFit = true

    const fit = (): void => {
      if (el.offsetWidth <= 100 || el.offsetHeight <= 100) return

      const buf = instance.term.buffer.active
      const wasAtBottom = buf.viewportY >= buf.baseY
      const wasInitial = isInitialFit
      isInitialFit = false

      instance.fitAddon.fit()
      if (instance.term.cols >= MIN_COLS) {
        window.api.resizeSession(sessionId, instance.term.cols, instance.term.rows)
      }

      if (wasInitial || wasAtBottom) {
        // Reset sticky-scroll state — we're intentionally at the bottom
        const scrollInfo = stickyScrollState.get(sessionId)
        if (scrollInfo) scrollInfo.userScrolledUp = false

        // Install a reactive scroll guard that snaps to bottom whenever xterm's
        // async reflow fires scroll events. The persistent sticky-scroll on PTY
        // writes handles ongoing output, but the guard is needed for the brief
        // window after fit() where reflow can desync the viewport before any
        // PTY data arrives.
        installScrollGuard(sessionId, instance.term, 300, () => {
          if (wasInitial) instance.term.focus()
        })
      }
    }

    // Immediate fit when becoming visible — ResizeObserver alone won't fire
    // if the container is already the right size (e.g. resuming a session).
    fit()

    // ResizeObserver fires when the container gets its real size
    const observer = new ResizeObserver(() => {
      fit()
    })
    observer.observe(el)

    // Also fit on window resize
    window.addEventListener('resize', fit)
    return () => {
      activeScrollGuards.get(sessionId)?.()
      observer.disconnect()
      window.removeEventListener('resize', fit)
    }
  }, [sessionId, visible])

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={visible ? {} : {
        // Keep reasonable dimensions so xterm doesn't reflow to 1 column.
        // Stays on-screen (behind visible UI) so WebGL canvas actually renders for snapshots.
        // Using left:-200vw causes Chromium to skip WebGL draw calls for off-viewport elements.
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        pointerEvents: 'none'
      }}
    />
  )
}

export function writeToTerminal(sessionId: string, data: string): void {
  const instance = terminalInstances.get(sessionId)
  if (instance) {
    instance.term.write(data)
  }
}

export function focusTerminal(sessionId: string): void {
  const instance = terminalInstances.get(sessionId)
  if (instance) {
    instance.term.focus()
  }
}

export function disposeTerminal(sessionId: string): void {
  const instance = terminalInstances.get(sessionId)
  if (instance) {
    instance.cleanup?.()
    if (instance.webglAddon) {
      try { instance.webglAddon.dispose() } catch { /* ignore */ }
    }
    instance.term.dispose()
    terminalInstances.delete(sessionId)
    stickyScrollState.delete(sessionId)
  }
}
