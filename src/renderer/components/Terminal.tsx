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
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
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

/**
 * Force the xterm viewport to the bottom after fit(). Direct scrollToBottom()
 * doesn't stick on the first entry because fit()'s reflow hasn't finished
 * updating the viewport's scrollable dimensions yet. Driving scrollTop on the
 * DOM element after a frame lets the layout settle first, then the final
 * scrollToBottom() syncs xterm's internal state (clears isUserScrolling).
 */
function forceScrollToBottom(term: XTerm, onDone?: () => void): void {
  const viewport = term.element?.querySelector('.xterm-viewport') as HTMLElement | null
  if (!viewport) {
    term.scrollToBottom()
    onDone?.()
    return
  }

  // fit() schedules an internal syncScrollArea in a rAF that updates the scroll
  // area height. We need to wait for that to finish before our scrollTop assignment
  // will stick. Double rAF: first lets xterm's refresh run, second drives scrollTop.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
      term.scrollToBottom()
      onDone?.()
    })
  })
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

      // Forward keyboard input to PTY
      term.onData((data) => {
        window.api.writeSession(sessionId, data)
      })

      // Listen for PTY data on session-specific channel — no filtering needed
      const unsubPtyData = window.api.onPtyData(sessionId, (data) => {
        term.write(data)
      })
      instance.cleanup = unsubPtyData

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

    // fit() → resize() triggers a viewport reflow that can fire a DOM scroll event,
    // which xterm interprets as user-initiated scrolling. This sets the internal
    // isUserScrolling flag, which prevents auto-scroll on subsequent output — so
    // commands like /resume dump everything but the viewport stays stuck at the top.
    // After fit(), we scrollToBottom to reset isUserScrolling, then again on the next
    // frame to catch the async DOM scroll event from the reflow.
    let isInitialFit = true

    const fit = (): void => {
      // Only fit if the container has real dimensions (not the off-screen placeholder)
      if (el.offsetWidth > 100 && el.offsetHeight > 100) {
        const buf = instance.term.buffer.active
        const wasInitial = isInitialFit
        isInitialFit = false

        instance.fitAddon.fit()
        // Guard against fitting to tiny sizes
        if (instance.term.cols >= MIN_COLS) {
          window.api.resizeSession(sessionId, instance.term.cols, instance.term.rows)
        }

        if (wasInitial) {
          // First fit after becoming visible. The viewport is desynced from
          // being off-screen — scrollToBottom() alone doesn't stick because
          // fit()'s reflow hasn't finished updating scroll dimensions yet.
          // Force via the DOM element after a frame to let layout settle.
          forceScrollToBottom(instance.term, () => {
            instance.term.focus()
          })
        } else if (buf.viewportY >= buf.baseY) {
          // Subsequent fit while already at bottom (window resize, etc.)
          instance.term.scrollToBottom()
          requestAnimationFrame(() => {
            instance.term.scrollToBottom()
            instance.term.focus()
          })
        }
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
  }
}
