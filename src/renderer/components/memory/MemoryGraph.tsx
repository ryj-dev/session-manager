/**
 * Knowledge graph visualization using Sigma.js + Graphology + d3-force Web Worker.
 * Ported from tc-sql-atlas GraphView.tsx.
 */

import { useEffect, useRef, useCallback } from 'react'
import type {
  GraphData, PhysicsParams, NodeColors, WorkerNode, MainToWorker
} from '../../lib/memory-types'
import { getNodeColor, getNodeSize } from '../../lib/memory-types'

const DEFAULT_COLOR = '#B0BAC7'

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface D3Node {
  id: string; x: number; y: number; fx: number | null; fy: number | null
  nodeType: string; size: number
}

function computeFit(
  graph: import('graphology').default,
  sigma: import('sigma').default,
  nodeFilter?: (id: string) => boolean,
  padding = 0.05
): { x: number; y: number; ratio: number } | null {
  const defaultCamera = { x: 0.5, y: 0.5, ratio: 1, angle: 0 }
  const override = { cameraState: defaultCamera }
  const dims = sigma.getDimensions()

  let minVX = Infinity, maxVX = -Infinity, minVY = Infinity, maxVY = -Infinity
  let count = 0
  graph.forEachNode((id, attrs) => {
    if (nodeFilter && !nodeFilter(id)) return
    const x = attrs.x as number, y = attrs.y as number
    if (isNaN(x) || isNaN(y)) return
    const vp = sigma.graphToViewport({ x, y }, override)
    if (vp.x < minVX) minVX = vp.x
    if (vp.x > maxVX) maxVX = vp.x
    if (vp.y < minVY) minVY = vp.y
    if (vp.y > maxVY) maxVY = vp.y
    count++
  })
  if (count === 0) return null

  const centerVP = { x: (minVX + maxVX) / 2, y: (minVY + maxVY) / 2 }
  const center = sigma.viewportToFramedGraph(centerVP, override)
  const rangeVX = (maxVX - minVX) || 1
  const rangeVY = (maxVY - minVY) || 1
  const ratio = Math.max(rangeVX / dims.width, rangeVY / dims.height) * (1 + padding)

  return { x: center.x, y: center.y, ratio: Math.max(ratio, 0.001) }
}

interface Props {
  graphData: GraphData | null
  onSelectNote: (filename: string) => void
  physics: PhysicsParams
  searchMatchPaths: Set<string> | null
  nodeColors: NodeColors
  searchMode: 'filter' | 'recalculate'
  autoFitOnSearch: boolean
}

export default function MemoryGraph({
  graphData, onSelectNote, physics, searchMatchPaths, nodeColors,
  searchMode, autoFitOnSearch
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sigmaRef = useRef<import('sigma').default | null>(null)
  const graphRef = useRef<import('graphology').default | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const generationRef = useRef(0)
  const simRef = useRef<{ activeNodeIds: string[]; idToIdx: Map<string, number> } | null>(null)

  const allD3Nodes = useRef<D3Node[]>([])
  const allD3Links = useRef<{ sourceId: string; targetId: string }[]>([])

  const physicsRef = useRef(physics)
  physicsRef.current = physics
  const colorsRef = useRef(nodeColors)
  colorsRef.current = nodeColors
  const searchModeRef = useRef(searchMode)
  searchModeRef.current = searchMode
  const autoFitRef = useRef(autoFitOnSearch)
  autoFitRef.current = autoFitOnSearch

  const hoveredNodeRef = useRef<string | null>(null)
  const hoveredNeighborsRef = useRef<Set<string>>(new Set())
  const searchMatchRef = useRef<Set<string> | null>(null)
  searchMatchRef.current = searchMatchPaths

  const postWorker = useCallback((msg: MainToWorker) => {
    workerRef.current?.postMessage(msg)
  }, [])

  const buildSimulation = useCallback((visibleIds: Set<string> | null, preheatTicks: number) => {
    const graph = graphRef.current
    if (!graph || !workerRef.current) return

    const p = physicsRef.current
    const all = allD3Nodes.current

    const activeNodes = visibleIds ? all.filter((n) => visibleIds.has(n.id)) : [...all]

    for (const n of activeNodes) {
      if (graph.hasNode(n.id)) {
        const attrs = graph.getNodeAttributes(n.id)
        n.x = attrs.x as number
        n.y = attrs.y as number
      }
      n.fx = null; n.fy = null
    }

    const activeIdSet = new Set(activeNodes.map((n) => n.id))
    const activeNodeIds = activeNodes.map((n) => n.id)
    const idToIdx = new Map(activeNodes.map((n, i) => [n.id, i]))

    const activeLinks = allD3Links.current
      .filter((l) => activeIdSet.has(l.sourceId) && activeIdSet.has(l.targetId))
      .map((l) => ({ source: idToIdx.get(l.sourceId)!, target: idToIdx.get(l.targetId)! }))

    const workerNodes: WorkerNode[] = activeNodes.map((n) => ({
      id: n.id, x: n.x, y: n.y, fx: n.fx, fy: n.fy,
      nodeType: n.nodeType, size: n.size,
    }))

    const gen = ++generationRef.current
    simRef.current = { activeNodeIds, idToIdx }

    postWorker({
      type: 'init', generation: gen, nodes: workerNodes, links: activeLinks,
      physics: p, preheatTicks,
    })
  }, [postWorker])

  // Init Sigma + Graphology + Web Worker
  useEffect(() => {
    if (!graphData || !containerRef.current) return

    let sigma: import('sigma').default | null = null
    let worker: Worker | null = null
    let wheelCleanup: (() => void) | null = null

    async function init() {
      console.log('[MemoryGraph] init start, nodes:', graphData!.nodes.length, 'edges:', graphData!.edges.length)
      const GraphModule = await import('graphology')
      const Graph = GraphModule.default ?? GraphModule
      const SigmaModule = await import('sigma')
      const Sigma = SigmaModule.default ?? SigmaModule
      const { default: NodeGlowProgram } = await import('./NodeGlowProgram')
      console.log('[MemoryGraph] modules loaded, Graph:', typeof Graph, 'Sigma:', typeof Sigma)

      const graph = new Graph()
      graphRef.current = graph

      const degree = new Map<string, number>()
      for (const e of graphData!.edges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
      }

      for (const n of graphData!.nodes) {
        graph.addNode(n.id, {
          label: n.label.replace(/\.md$/, ''),
          color: getNodeColor(n.type, colorsRef.current),
          size: getNodeSize(n.type, degree.get(n.id) ?? 0),
          nodeType: n.type,
          x: (Math.random() - 0.5) * 10,
          y: (Math.random() - 0.5) * 10,
          hidden: true,
        })
      }

      for (const e of graphData!.edges) {
        if (graph.hasNode(e.source) && graph.hasNode(e.target)) {
          graph.addEdge(e.source, e.target)
        }
      }

      const LABEL_ZOOM_START = 0.35
      const LABEL_ZOOM_FULL = 0.2

      sigma = new Sigma(graph, containerRef.current!, {
        renderLabels: true,
        labelFont: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        labelSize: 10,
        labelColor: { color: '#8899aa' },
        labelRenderedSizeThreshold: 0,
        defaultDrawNodeLabel: (context, data, settings) => {
          if (!data.label) return
          const ratio = sigma!.getCamera().ratio
          if (ratio > LABEL_ZOOM_START) return
          let alpha = 1
          if (ratio > LABEL_ZOOM_FULL) {
            alpha = (LABEL_ZOOM_START - ratio) / (LABEL_ZOOM_START - LABEL_ZOOM_FULL)
          }
          const fontSize = settings.labelSize
          context.font = `${fontSize}px ${settings.labelFont}`
          context.fillStyle = data.highlighted
            ? hexToRgba('#e0e0e0', alpha)
            : hexToRgba('#8899aa', alpha)
          context.fillText(data.label, data.x + data.size + 3, data.y + fontSize / 3)
        },
        defaultEdgeColor: '#2a3545',
        minEdgeThickness: 0.8,
        defaultNodeColor: DEFAULT_COLOR,
        defaultNodeType: 'glow',
        nodeProgramClasses: { glow: NodeGlowProgram },
        defaultDrawNodeHover: () => {},
        hideEdgesOnMove: false,
        hideLabelsOnMove: false,
        enableEdgeEvents: false,
        minCameraRatio: 0.01,
        maxCameraRatio: 20,
        stagePadding: 40,
        allowInvalidContainer: true,
        nodeReducer: (node, data) => {
          const res = { ...data }
          const hovered = hoveredNodeRef.current
          const searchMatch = searchMatchRef.current
          const mode = searchModeRef.current

          if (hovered) {
            if (node === hovered || hoveredNeighborsRef.current.has(node)) {
              res.highlighted = true
            } else {
              res.color = '#1a2530'
              res.label = null
            }
          }

          if (searchMatch) {
            if (mode === 'recalculate') {
              if (!searchMatch.has(node)) res.hidden = true
            } else {
              if (!searchMatch.has(node)) { res.color = '#1a2530'; res.label = null }
            }
          }

          return res
        },
        edgeReducer: (edge, data) => {
          const res = { ...data }
          const hovered = hoveredNodeRef.current
          const searchMatch = searchMatchRef.current
          const mode = searchModeRef.current

          if (hovered) {
            const src = graph.source(edge), tgt = graph.target(edge)
            if (src === hovered || tgt === hovered) {
              res.color = '#5A7394'; res.size = 1.5
            } else {
              res.hidden = true
            }
          }

          if (searchMatch) {
            const src = graph.source(edge), tgt = graph.target(edge)
            if (mode === 'recalculate') {
              if (!searchMatch.has(src) || !searchMatch.has(tgt)) res.hidden = true
            } else {
              if (!searchMatch.has(src) || !searchMatch.has(tgt)) res.color = '#1a2530'
            }
          }

          return res
        },
      })

      sigmaRef.current = sigma

      allD3Nodes.current = graphData!.nodes.map((n) => {
        const attrs = graph.getNodeAttributes(n.id)
        return {
          id: n.id, x: attrs.x as number, y: attrs.y as number,
          fx: null as number | null, fy: null as number | null,
          nodeType: n.type, size: getNodeSize(n.type, degree.get(n.id) ?? 0),
        }
      })
      allD3Links.current = graphData!.edges.map((e) => ({ sourceId: e.source, targetId: e.target }))

      // Web Worker
      try {
        worker = new Worker(new URL('../../workers/memory-force.worker.ts', import.meta.url), { type: 'module' })
        console.log('[MemoryGraph] worker created')
      } catch (workerErr) {
        console.error('[MemoryGraph] worker creation failed:', workerErr)
        // Fallback: try without type: module
        worker = new Worker(new URL('../../workers/memory-force.worker.ts', import.meta.url))
        console.log('[MemoryGraph] worker created (fallback)')
      }
      workerRef.current = worker

      worker.onerror = (err) => console.error('[MemoryGraph] worker error:', err)

      let latestPositions: Float64Array | null = null
      let rafPending = false
      let firstTickReceived = false

      worker.onmessage = (e) => {
        const msg = e.data
        if (msg.type === 'tick') {
          if (msg.generation !== generationRef.current) return
          latestPositions = new Float64Array(msg.positions)
          if (rafPending) return
          rafPending = true
          requestAnimationFrame(() => {
            rafPending = false
            if (!graphRef.current || !latestPositions || !simRef.current) return
            const pos = latestPositions
            latestPositions = null

            graphRef.current.updateEachNodeAttributes((node, attrs) => {
              const idx = simRef.current?.idToIdx.get(node)
              if (idx !== undefined) {
                const x = pos[idx * 2], y = pos[idx * 2 + 1]
                if (!isNaN(x) && !isNaN(y)) { attrs.x = x; attrs.y = y }
              }
              return attrs
            }, { attributes: ['x', 'y'] })

            if (!firstTickReceived) {
              firstTickReceived = true
              graphRef.current.updateEachNodeAttributes((_node, attrs) => {
                attrs.hidden = false; return attrs
              }, { attributes: ['hidden'] })
              const s = sigmaRef.current
              if (s) {
                const camera = s.getCamera()
                camera.setState({ x: 0.5, y: 0.5, ratio: 4 })
                camera.animate({ x: 0.5, y: 0.5, ratio: 1.4 }, { duration: 2000, easing: 'cubicInOut' })
              }
            }
          })
        }
      }

      console.log('[MemoryGraph] sigma created, starting simulation')
      buildSimulation(null, 200)

      // Momentum zoom
      {
        const camera = sigma.getCamera()
        const MIN_RATIO = 0.01, MAX_RATIO = 20, FRICTION = 0.92, SENSITIVITY = 0.0003
        let velocity = 0, animating = false, cursorVX = 0, cursorVY = 0
        const si = sigma

        function tick() {
          if (Math.abs(velocity) < 0.0001) { velocity = 0; animating = false; return }
          const oldR = camera.ratio
          const newR = Math.min(MAX_RATIO, Math.max(MIN_RATIO, oldR * (1 + velocity)))
          const rd = newR / oldR
          const dims = si.getDimensions()
          const gm = si.viewportToFramedGraph({ x: cursorVX, y: cursorVY })
          const gc = si.viewportToFramedGraph({ x: dims.width / 2, y: dims.height / 2 })
          const state = camera.getState()
          camera.setState({
            ratio: newR,
            x: state.x + (gm.x - gc.x) * (1 - rd),
            y: state.y + (gm.y - gc.y) * (1 - rd),
          })
          velocity *= FRICTION
          requestAnimationFrame(tick)
        }

        const onWheel = (e: WheelEvent) => {
          e.preventDefault(); e.stopPropagation()
          velocity += e.deltaY * SENSITIVITY
          cursorVX = e.offsetX; cursorVY = e.offsetY
          if (!animating) { animating = true; requestAnimationFrame(tick) }
        }
        const wheelContainer = si.getContainer()
        wheelContainer.addEventListener('wheel', onWheel, { passive: false, capture: true })
        wheelCleanup = () => wheelContainer.removeEventListener('wheel', onWheel, { capture: true })
      }

      // Drag
      let draggedNode: string | null = null
      let isDragging = false
      const cntr = containerRef.current!

      sigma.on('downNode', ({ node, event }) => {
        draggedNode = node; isDragging = false; event.preventSigmaDefault()
        const r = simRef.current
        if (!r) return
        const idx = r.idToIdx.get(node)
        if (idx === undefined) return
        const attrs = graph.getNodeAttributes(node)
        postWorker({ type: 'pin', index: idx, x: attrs.x as number, y: attrs.y as number })
        cntr.style.cursor = 'grabbing'
      })

      sigma.getMouseCaptor().on('mousemovebody', (e) => {
        if (!draggedNode || !sigma) return
        isDragging = true
        const pos = sigma.viewportToGraph(e)
        graph.setNodeAttribute(draggedNode, 'x', pos.x)
        graph.setNodeAttribute(draggedNode, 'y', pos.y)
        const r = simRef.current
        if (!r) return
        const idx = r.idToIdx.get(draggedNode)
        if (idx !== undefined) postWorker({ type: 'pin', index: idx, x: pos.x, y: pos.y })
      })

      sigma.getMouseCaptor().on('mouseup', () => {
        if (draggedNode) {
          const r = simRef.current
          if (r) { const idx = r.idToIdx.get(draggedNode); if (idx !== undefined) postWorker({ type: 'unpin', index: idx }) }
          draggedNode = null; cntr.style.cursor = 'default'
        }
      })

      sigma.on('clickNode', ({ node }) => { if (!isDragging) onSelectNote(node) })

      // Hover
      let hoverTimer: ReturnType<typeof setTimeout> | null = null
      sigma.on('enterNode', ({ node }) => {
        cntr.style.cursor = 'pointer'
        if (hoverTimer) clearTimeout(hoverTimer)
        hoverTimer = setTimeout(() => {
          hoveredNodeRef.current = node
          hoveredNeighborsRef.current = new Set(graph.neighbors(node))
          sigma?.refresh()
        }, 300)
      })
      sigma.on('leaveNode', () => {
        cntr.style.cursor = draggedNode ? 'grabbing' : 'grab'
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null }
        if (hoveredNodeRef.current) {
          hoveredNodeRef.current = null; hoveredNeighborsRef.current = new Set(); sigma?.refresh()
        }
      })

      cntr.style.cursor = 'grab'
      sigma.on('downStage', () => { cntr.style.cursor = 'grabbing' })
      sigma.on('upStage', () => { cntr.style.cursor = 'grab' })
    }

    init().catch((err) => console.error('[MemoryGraph] init failed:', err))

    return () => {
      if (wheelCleanup) wheelCleanup()
      if (worker) { worker.postMessage({ type: 'stop' }); worker.terminate() }
      workerRef.current = null; simRef.current = null
      if (sigma) sigma.kill()
      sigmaRef.current = null; graphRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData, buildSimulation])

  // Update physics
  useEffect(() => { postWorker({ type: 'updatePhysics', physics }) }, [physics, postWorker])

  // Update colors
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    graph.updateEachNodeAttributes((_node, attrs) => {
      const nt = attrs.nodeType as string
      if (nt) attrs.color = getNodeColor(nt, nodeColors)
      return attrs
    }, { attributes: ['color'] })
  }, [nodeColors])

  // Search
  useEffect(() => {
    const sigma = sigmaRef.current, graph = graphRef.current
    if (!sigma || !graph || allD3Nodes.current.length === 0) return

    const camera = sigma.getCamera()
    camera.animate(camera.getState(), { duration: 0 })
    sigma.refresh()

    if (searchModeRef.current === 'recalculate') {
      buildSimulation(searchMatchPaths, searchMatchPaths ? 50 : 0)
      const s = sigma
      setTimeout(() => {
        const fit = computeFit(graph, s, searchMatchPaths ? (id) => searchMatchPaths.has(id) : undefined, 0.15)
        if (fit) s.getCamera().animate(fit, { duration: 600 })
      }, 100)
    } else if (searchMatchPaths && autoFitRef.current) {
      const s = sigma
      setTimeout(() => {
        const fit = computeFit(graph, s, (id) => searchMatchPaths.has(id), 0.15)
        if (fit) s.getCamera().animate(fit, { duration: 800 })
      }, 450)
    }
  }, [searchMatchPaths, buildSimulation])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#0a0a0a' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }} />
      {graphData && (
        <div style={{ position: 'absolute', top: 14, right: 160, fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#556', display: 'flex', gap: 12, pointerEvents: 'none' }}>
          <span>{searchMatchPaths ? searchMatchPaths.size : graphData.nodes.length} nodes</span>
          <span>{graphData.edges.length} edges</span>
        </div>
      )}
    </div>
  )
}
