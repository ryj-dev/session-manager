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
  { term: XTerm; fitAddon: FitAddon; initialized: boolean; cleanup?: () => void }
>()

export function getTerminalCanvas(sessionId: string): HTMLCanvasElement | null {
  const instance = terminalInstances.get(sessionId)
  if (!instance) return null
  // WebGL addon creates multiple canvases: the link layer (xterm-link-layer class)
  // comes first in DOM order, but the actual rendered text is on the WebGL canvas
  // which has no xterm-*-layer class. Grab the last canvas as that's the WebGL one.
  const canvases = instance.term.element?.querySelectorAll('canvas')
  if (!canvases || canvases.length === 0) return null
  return canvases[canvases.length - 1] as HTMLCanvasElement
}

function getOrCreateInstance(sessionId: string): { term: XTerm; fitAddon: FitAddon; initialized: boolean; cleanup?: () => void } {
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

  instance = { term, fitAddon, initialized: false }
  terminalInstances.set(sessionId, instance)
  return instance
}

// Minimum dimensions to prevent 1-column wrapping when off-screen
const MIN_COLS = 80
const MIN_ROWS = 24

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

      // Try WebGL addon (preserveDrawingBuffer needed for snapshot capture)
      try {
        term.loadAddon(new WebglAddon(true))
      } catch {
        // Canvas renderer fallback
      }

      // Forward keyboard input to PTY
      term.onData((data) => {
        window.api.writeSession(sessionId, data)
      })

      // Listen for PTY data — store unsubscribe so disposeTerminal can clean up
      const unsubPtyData = window.api.onPtyData(({ id, data }) => {
        if (id === sessionId) {
          term.write(data)
        }
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
    }
  }, [sessionId])

  // Refit ONLY when visible — never resize the PTY when off-screen
  useEffect(() => {
    if (!visible) return

    const el = containerRef.current
    const instance = terminalInstances.get(sessionId)
    if (!el || !instance) return

    const fit = (): void => {
      // Only fit if the container has real dimensions (not the off-screen placeholder)
      if (el.offsetWidth > 100 && el.offsetHeight > 100) {
        instance.fitAddon.fit()
        // Guard against fitting to tiny sizes
        if (instance.term.cols >= MIN_COLS) {
          window.api.resizeSession(sessionId, instance.term.cols, instance.term.rows)
        }
        // After reparenting, xterm's viewport scroll position can be stale (stuck at top
        // even though the visual cursor is at the bottom). Defer scrollToBottom so xterm
        // finishes its reflow from fit() before we adjust the scroll position.
        requestAnimationFrame(() => {
          instance.term.scrollToBottom()
          instance.term.focus()
        })
      }
    }

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
    instance.term.dispose()
    terminalInstances.delete(sessionId)
  }
}
