import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, type MessageNotification, type MessagePopupMode } from '../store'

interface MessagePopupProps {
  focusedSessionId: string | null
}

function MessageBubble({
  msg,
  mode,
  seconds,
}: {
  msg: MessageNotification
  mode: MessagePopupMode
  seconds: number
}): JSX.Element {
  const dismissMessage = useStore((s) => s.dismissMessage)
  const toggleMessageExpanded = useStore((s) => s.toggleMessageExpanded)
  const updateMessageTimer = useStore((s) => s.updateMessageTimer)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startedRef = useRef<number | null>(null)
  const elapsedRef = useRef(0)
  const totalMsRef = useRef(msg.timerRemainingMs ?? seconds * 1000)
  // Track progress for the bar (0 = full, 1 = empty)
  const [progress, setProgress] = useState(0)
  const rafRef = useRef<number | null>(null)
  const [paused, setPaused] = useState(false)

  const isTimed = mode === 'timed'

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }, [])

  const startTimer = useCallback(() => {
    const remaining = totalMsRef.current - elapsedRef.current
    if (remaining <= 0) { dismissMessage(msg.id); return }
    startedRef.current = Date.now()
    timerRef.current = setTimeout(() => dismissMessage(msg.id), remaining)

    // Animate progress bar
    const tick = (): void => {
      if (!startedRef.current) return
      const currentElapsed = elapsedRef.current + (Date.now() - startedRef.current)
      setProgress(Math.min(1, currentElapsed / totalMsRef.current))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [msg.id, dismissMessage])

  const pauseTimer = useCallback(() => {
    clearTimer()
    if (startedRef.current) {
      elapsedRef.current += Date.now() - startedRef.current
      startedRef.current = null
    }
    setProgress(Math.min(1, elapsedRef.current / totalMsRef.current))
  }, [clearTimer])

  // Initialize and manage the timer lifecycle
  useEffect(() => {
    if (!isTimed) return

    totalMsRef.current = msg.timerRemainingMs ?? seconds * 1000
    elapsedRef.current = 0

    if (totalMsRef.current <= 0) {
      dismissMessage(msg.id)
      return
    }

    const handleVisibility = (): void => {
      if (document.hidden) { pauseTimer(); setPaused(true) }
      else { setPaused(false) }
    }

    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      clearTimer()
      if (startedRef.current) elapsedRef.current += Date.now() - startedRef.current
      updateMessageTimer(msg.id, Math.max(0, totalMsRef.current - elapsedRef.current))
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [isTimed, seconds, msg.id, dismissMessage, updateMessageTimer, clearTimer, pauseTimer])

  // Start/pause based on paused state, hover, and expanded
  const shouldPause = paused || msg.expanded
  useEffect(() => {
    if (!isTimed) return
    if (shouldPause) pauseTimer()
    else startTimer()
  }, [isTimed, shouldPause, pauseTimer, startTimer])

  const fromLabel = msg.fromSessionId
    ? `Session ${msg.fromSessionId.slice(0, 8)}...`
    : 'Another session'

  const timeAgo = formatTimeAgo(msg.receivedAt)

  const handleMouseEnter = (): void => { if (isTimed) setPaused(true) }
  const handleMouseLeave = (): void => {
    if (isTimed && !document.hidden) setPaused(false)
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 60, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 60, scale: 0.95 }}
      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      className="w-80 bg-zinc-900/95 backdrop-blur-md border border-zinc-700/80 rounded-lg shadow-2xl overflow-hidden"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/50">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
          <span className="text-[11px] text-zinc-400 truncate">{fromLabel}</span>
          <span className="text-[10px] text-zinc-600">{timeAgo}</span>
        </div>
        <button
          onClick={() => dismissMessage(msg.id)}
          className="text-zinc-600 hover:text-zinc-400 transition-colors p-0.5 -mr-0.5"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <button
        className="w-full text-left px-3 py-2.5 hover:bg-zinc-800/30 transition-colors"
        onClick={() => toggleMessageExpanded(msg.id)}
      >
        <p
          className={`text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-words ${
            msg.expanded ? '' : 'line-clamp-3'
          }`}
        >
          {msg.message}
        </p>
        {!msg.expanded && msg.message.length > 150 && (
          <span className="text-[10px] text-zinc-600 mt-1 block">Click to expand</span>
        )}
      </button>

      {/* Timer progress bar */}
      {isTimed && (
        <div className="h-0.5 bg-zinc-800">
          <div
            className="h-full bg-blue-500/60 transition-none"
            style={{ width: `${(1 - progress) * 100}%` }}
          />
        </div>
      )}
    </motion.div>
  )
}

function formatTimeAgo(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

export function MessagePopup({ focusedSessionId }: MessagePopupProps): JSX.Element {
  const pendingMessages = useStore((s) => s.pendingMessages)
  const messagePopup = useStore((s) => s.messagePopup)
  const messagePopupSeconds = useStore((s) => s.messagePopupSeconds)

  if (messagePopup === 'disabled') return <></>

  const visibleMessages = focusedSessionId
    ? pendingMessages.filter(
        (m) => !m.dismissed && m.targetSessionId === focusedSessionId
      )
    : []

  return (
    <div className="absolute top-14 right-4 z-30 flex flex-col gap-2 pointer-events-auto">
      <AnimatePresence mode="popLayout">
        {visibleMessages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            mode={messagePopup}
            seconds={messagePopupSeconds}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}
