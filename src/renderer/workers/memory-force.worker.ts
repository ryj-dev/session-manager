/**
 * D3-force simulation in a Web Worker.
 * Ported from tc-sql-atlas force.worker.ts — simplified (no anchor nodes).
 */

import * as d3force from 'd3-force'
import type { MainToWorker } from '../lib/memory-types'

interface D3Node {
  id: string
  x: number
  y: number
  fx: number | null
  fy: number | null
  nodeType: string
  size: number
}

let sim: d3force.Simulation<D3Node, d3force.SimulationLinkDatum<D3Node>> | null = null
let nodes: D3Node[] = []
let generation = 0

let charge: d3force.ForceManyBody<D3Node> | null = null
let linkForce: d3force.ForceLink<D3Node, { source: number; target: number }> | null = null
let collide: d3force.ForceCollide<D3Node> | null = null
let forceX: d3force.ForceX<D3Node> | null = null
let forceY: d3force.ForceY<D3Node> | null = null

function sendPositions(): void {
  const buf = new Float64Array(nodes.length * 2)
  for (let i = 0; i < nodes.length; i++) {
    buf[i * 2] = nodes[i].x
    buf[i * 2 + 1] = nodes[i].y
  }
  postMessage(
    { type: 'tick', generation, positions: buf.buffer },
    { transfer: [buf.buffer] }
  )
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data

  switch (msg.type) {
    case 'init': {
      if (sim) sim.stop()

      generation = msg.generation
      const p = msg.physics

      nodes = msg.nodes.map((n) => ({ ...n }))

      charge = d3force.forceManyBody<D3Node>().strength(-(p.repelForce * 100)).theta(1.5)
      collide = d3force.forceCollide<D3Node>((n) => n.size / 2 + 1).strength(1).iterations(1)
      linkForce = d3force
        .forceLink<D3Node, { source: number; target: number }>(msg.links)
        .strength(p.linkForce)
        .distance(p.linkDistance)
        .iterations(1)
      forceX = d3force.forceX<D3Node>(0).strength(p.centerForce)
      forceY = d3force.forceY<D3Node>(0).strength(p.centerForce)

      sim = d3force
        .forceSimulation(nodes)
        .force('charge', charge)
        .force('link', linkForce)
        .force('collide', collide)
        .force('x', forceX)
        .force('y', forceY)
        .alphaDecay(msg.preheatTicks > 0 ? 0.006 : 0.02)
        .velocityDecay(p.friction)
        .stop()

      if (msg.preheatTicks > 0) {
        for (let i = 0; i < msg.preheatTicks; i++) sim.tick()
        sendPositions()
      }

      sim
        .alphaDecay(0.02)
        .alpha(msg.preheatTicks > 0 ? 0.3 : 1)
        .velocityDecay(p.friction)
        .on('tick', sendPositions)
        .restart()
      break
    }

    case 'update': {
      if (!sim || !linkForce || !collide) return
      generation = msg.generation

      const oldById = new Map<string, D3Node>()
      for (const n of nodes) oldById.set(n.id, n)

      nodes = msg.nodes.map((n) => {
        const old = oldById.get(n.id)
        if (old) {
          old.size = n.size
          old.nodeType = n.nodeType
          return old
        }
        return { ...n }
      })

      sim.nodes(nodes)
      linkForce.links(msg.links)
      sim.alpha(msg.alpha).restart()
      break
    }

    case 'updatePhysics': {
      if (!sim || !charge || !linkForce || !forceX || !forceY) return
      const p = msg.physics
      charge.strength(-(p.repelForce * 100)).theta(1.5)
      linkForce.strength(p.linkForce).distance(p.linkDistance)
      forceX.strength(p.centerForce)
      forceY.strength(p.centerForce)
      sim.velocityDecay(p.friction)
      sim.alpha(1).restart()
      break
    }

    case 'pin': {
      if (!sim || !nodes[msg.index]) return
      nodes[msg.index].fx = msg.x
      nodes[msg.index].fy = msg.y
      sim.alphaTarget(0.2).restart()
      break
    }

    case 'unpin': {
      if (!sim || !nodes[msg.index]) return
      nodes[msg.index].fx = null
      nodes[msg.index].fy = null
      sim.alphaTarget(0).restart()
      break
    }

    case 'reheat': {
      if (!sim) return
      sim.alpha(msg.alpha).restart()
      break
    }

    case 'stop': {
      if (sim) sim.stop()
      sim = null
      break
    }
  }
}
