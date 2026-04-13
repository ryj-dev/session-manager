/**
 * Memory panel — orchestrates sidebar, graph, note viewer, and floating panels.
 * Ported from tc-sql-atlas AppShell.tsx.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import MemoryGraph from './MemoryGraph'
import MemorySidebar from './MemorySidebar'
import PhysicsPanel from './PhysicsPanel'
import DisplayPanel from './DisplayPanel'
import OptionsPanel from './OptionsPanel'
import NoteViewer from './NoteViewer'
import NoteEditor from './NoteEditor'
import {
  DEFAULT_PHYSICS, DEFAULT_COLORS, DEFAULT_OPTIONS,
  type PhysicsParams, type NodeColors, type GraphOptions, type GraphData, type GraphNode
} from '../../lib/memory-types'

type ActiveSubPanel = 'display' | 'physics' | 'options' | null

interface Props {
  visible: boolean
  onClose: () => void
}

export default function MemoryPanel({ visible, onClose }: Props) {
  const [graphData, setGraphData] = useState<GraphData | null>(null)
  const [selectedNote, setSelectedNote] = useState<string | null>(null)
  const [editingNote, setEditingNote] = useState<string | null>(null)
  const [physics, setPhysics] = useState<PhysicsParams>(DEFAULT_PHYSICS)
  const [nodeColors, setNodeColors] = useState<NodeColors>(DEFAULT_COLORS)
  const [activeSubPanel, setActiveSubPanel] = useState<ActiveSubPanel>(null)
  const [search, setSearch] = useState('')
  const [searchMatchPaths, setSearchMatchPaths] = useState<Set<string> | null>(null)
  const [graphOptions, setGraphOptions] = useState<GraphOptions>(DEFAULT_OPTIONS)

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const sidebarHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const SIDEBAR_WIDTH = 260

  // Fetch graph data on mount
  useEffect(() => {
    if (!visible) return
    window.api.memoryGraph().then((data) => {
      setGraphData(data as GraphData)
    })
  }, [visible])

  // Listen for memory changes
  useEffect(() => {
    if (!visible) return
    const unsub = window.api.onMemoryChanged(() => {
      window.api.memoryGraph().then((data) => {
        setGraphData(data as GraphData)
      })
    })
    return unsub
  }, [visible])

  // Debounced search
  useEffect(() => {
    if (!search.trim()) {
      setSearchMatchPaths(null)
      return
    }
    const timer = setTimeout(async () => {
      const results = await window.api.memorySearch(search) as { filename: string }[]
      setSearchMatchPaths(new Set(results.map((r) => r.filename)))
    }, 150)
    return () => clearTimeout(timer)
  }, [search])

  // Panel hover logic
  const showPanel = useCallback((panel: ActiveSubPanel) => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
    setActiveSubPanel(panel)
  }, [])

  const hidePanel = useCallback(() => {
    hideTimerRef.current = setTimeout(() => {
      setActiveSubPanel(null)
      hideTimerRef.current = null
    }, 120)
  }, [])

  const handleSelectNote = useCallback((filename: string) => {
    setSelectedNote(filename)
    setEditingNote(null)
  }, [])

  const handleBackToGraph = useCallback(() => {
    setSelectedNote(null)
    setEditingNote(null)
  }, [])

  const handleCreateNote = useCallback(() => {
    setEditingNote('__new__')
    setSelectedNote(null)
  }, [])

  const handleSaveNote = useCallback(async () => {
    // Refresh graph after save
    const data = await window.api.memoryGraph()
    setGraphData(data as GraphData)
    setEditingNote(null)
  }, [])

  const handleNoteChanged = useCallback(async () => {
    const data = await window.api.memoryGraph()
    setGraphData(data as GraphData)
  }, [])

  const handleSidebarMouseEnter = useCallback(() => {
    if (sidebarHideTimer.current) { clearTimeout(sidebarHideTimer.current); sidebarHideTimer.current = null }
    setSidebarOpen(true)
  }, [])

  const handleSidebarMouseLeave = useCallback(() => {
    sidebarHideTimer.current = setTimeout(() => {
      setSidebarOpen(false)
      setActiveSubPanel(null)
      sidebarHideTimer.current = null
    }, 300)
  }, [])

  if (!visible) return null

  const showDisplay = activeSubPanel === 'display' && !selectedNote && !editingNote
  const showPhysics = activeSubPanel === 'physics' && !selectedNote && !editingNote
  const showOptions = activeSubPanel === 'options' && !selectedNote && !editingNote

  const notes: GraphNode[] = graphData?.nodes ?? []

  return (
    <div className="fixed inset-0 z-30 flex" style={{ background: '#0a0a0a' }}>
      {/* Sidebar hover trigger zone — always present at left edge */}
      <div
        style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: sidebarOpen ? 0 : 16,
          zIndex: 50,
        }}
        onMouseEnter={handleSidebarMouseEnter}
      />

      {/* Sidebar */}
      <div
        style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: SIDEBAR_WIDTH,
          zIndex: 40,
          transform: sidebarOpen ? 'translateX(0)' : `translateX(-${SIDEBAR_WIDTH}px)`,
          transition: 'transform 0.2s ease',
          background: '#0a0a0a',
        }}
        onMouseEnter={handleSidebarMouseEnter}
        onMouseLeave={handleSidebarMouseLeave}
      >
        <MemorySidebar
          notes={notes}
          selectedNote={selectedNote}
          onSelectNote={handleSelectNote}
          onDisplayMouseEnter={() => showPanel('display')}
          onDisplayMouseLeave={hidePanel}
          showDisplay={showDisplay}
          onPhysicsMouseEnter={() => showPanel('physics')}
          onPhysicsMouseLeave={hidePanel}
          showPhysics={showPhysics}
          onOptionsMouseEnter={() => showPanel('options')}
          onOptionsMouseLeave={hidePanel}
          showOptions={showOptions}
          search={search}
          onSearchChange={setSearch}
          searchMatchPaths={searchMatchPaths}
          onCreateNote={handleCreateNote}
        />
      </div>

      {/* Main content — full width */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {/* Minimal top bar — only when viewing a note or creating */}
        {(selectedNote || editingNote) && (
          <div style={{
            height: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 16px 0 80px', borderBottom: '1px solid #1a1f28', flexShrink: 0,
            WebkitAppRegion: 'drag',
          } as React.CSSProperties}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              <button onClick={handleBackToGraph} style={{
                background: 'none', border: 'none', cursor: 'pointer', color: '#889',
                fontFamily: 'ui-monospace, monospace', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4,
              }}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M8 2L4 6L8 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Graph
              </button>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#e0e0e0' }}>
                {editingNote === '__new__' ? 'New Note' : selectedNote?.replace(/\.md$/, '')}
              </span>
            </div>
            <button onClick={handleBackToGraph} style={{
              background: 'none', border: 'none', cursor: 'pointer', color: '#556', fontSize: 16, padding: '0 4px',
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}>✕</button>
          </div>
        )}

        {/* Content area */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {editingNote ? (
            <NoteEditor
              filename={editingNote === '__new__' ? null : editingNote}
              onSave={handleSaveNote}
              onCancel={() => setEditingNote(null)}
            />
          ) : selectedNote ? (
            <NoteViewer
              filename={selectedNote}
              onNavigate={handleSelectNote}
              onChanged={handleNoteChanged}
            />
          ) : (
            <MemoryGraph
              graphData={graphData}
              onSelectNote={handleSelectNote}
              physics={physics}
              searchMatchPaths={searchMatchPaths}
              nodeColors={nodeColors}
              searchMode={graphOptions.searchMode}
              autoFitOnSearch={graphOptions.autoFitOnSearch}
            />
          )}
        </div>
      </div>

      {/* Floating panels — anchored to sidebar when open */}
      <DisplayPanel
        colors={nodeColors} onChange={setNodeColors}
        onMouseEnter={() => { showPanel('display'); handleSidebarMouseEnter() }}
        onMouseLeave={() => { hidePanel(); handleSidebarMouseLeave() }}
        sidebarWidth={SIDEBAR_WIDTH} visible={showDisplay && sidebarOpen}
      />
      <PhysicsPanel
        params={physics} onChange={setPhysics}
        onMouseEnter={() => { showPanel('physics'); handleSidebarMouseEnter() }}
        onMouseLeave={() => { hidePanel(); handleSidebarMouseLeave() }}
        sidebarWidth={SIDEBAR_WIDTH} visible={showPhysics && sidebarOpen}
      />
      <OptionsPanel
        options={graphOptions} onChange={setGraphOptions}
        onMouseEnter={() => { showPanel('options'); handleSidebarMouseEnter() }}
        onMouseLeave={() => { hidePanel(); handleSidebarMouseLeave() }}
        sidebarWidth={SIDEBAR_WIDTH} visible={showOptions && sidebarOpen}
      />
    </div>
  )
}
