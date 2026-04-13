/** Shared types for the memory system. */

export interface PhysicsParams {
  centerForce: number
  repelForce: number
  linkForce: number
  linkDistance: number
  friction: number
}

export const DEFAULT_PHYSICS: PhysicsParams = {
  centerForce: 0.5,
  repelForce: 11.5,
  linkForce: 0.5,
  linkDistance: 200,
  friction: 0.9,
}

export interface NodeColors {
  context: string
  decision: string
  project: string
  reference: string
  'session-log': string
  user: string
  feedback: string
}

export const DEFAULT_COLORS: NodeColors = {
  context: '#007F7E',
  decision: '#C48A1A',
  project: '#1e90ff',
  reference: '#9C27B0',
  'session-log': '#777777',
  user: '#e040a0',
  feedback: '#ff6b35',
}

export const COLOR_THEMES: { name: string; colors: NodeColors }[] = [
  { name: 'Default', colors: { ...DEFAULT_COLORS } },
  { name: 'Monochrome', colors: { context: '#999', decision: '#777', project: '#555', reference: '#888', 'session-log': '#666', user: '#aaa', feedback: '#888' } },
  { name: 'Ocean', colors: { context: '#4db6ac', decision: '#00bcd4', project: '#1e90ff', reference: '#7e57c2', 'session-log': '#78909c', user: '#ab47bc', feedback: '#4fc3f7' } },
  { name: 'Neon', colors: { context: '#76ff03', decision: '#00e5ff', project: '#e040fb', reference: '#ff6d00', 'session-log': '#b0bec5', user: '#f50057', feedback: '#ffab40' } },
]

export interface GraphOptions {
  searchMode: 'filter' | 'recalculate'
  autoFitOnSearch: boolean
}

export const DEFAULT_OPTIONS: GraphOptions = {
  searchMode: 'recalculate',
  autoFitOnSearch: true,
}

export interface GraphNode {
  id: string
  label: string
  type: string
  tags: string[]
}

export interface GraphEdge {
  source: string
  target: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface WorkerNode {
  id: string
  nodeType: string
  size: number
  x: number
  y: number
  fx: number | null
  fy: number | null
}

export type MainToWorker =
  | {
      type: 'init'
      generation: number
      nodes: WorkerNode[]
      links: { source: number; target: number }[]
      physics: PhysicsParams
      preheatTicks: number
    }
  | {
      type: 'update'
      generation: number
      nodes: WorkerNode[]
      links: { source: number; target: number }[]
      alpha: number
    }
  | { type: 'updatePhysics'; physics: PhysicsParams }
  | { type: 'pin'; index: number; x: number; y: number }
  | { type: 'unpin'; index: number }
  | { type: 'reheat'; alpha: number }
  | { type: 'stop' }

export type WorkerToMain =
  | { type: 'tick'; generation: number; positions: ArrayBuffer }

const TYPE_BASE_SIZE: Record<string, number> = {
  project: 4, decision: 3, context: 2, reference: 2, 'session-log': 2, user: 3, feedback: 2,
}

export function getNodeSize(type: string, degree: number): number {
  const base = TYPE_BASE_SIZE[type] ?? 2
  return base + Math.log2(degree + 1) * 0.3
}

export function getNodeColor(type: string, colors: NodeColors): string {
  return (colors as unknown as Record<string, string>)[type] ?? '#B0BAC7'
}
