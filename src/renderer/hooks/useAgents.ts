import { useState, useEffect, useRef } from 'react'
import { PanelItem, parseMarkdownMeta } from './usePanelItems'

export function useAgents(): { items: PanelItem[]; loading: boolean } {
  const [items, setItems] = useState<PanelItem[]>([])
  const [loading, setLoading] = useState(true)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true

    async function load(): Promise<void> {
      try {
        const resourcesPath = await window.api.getResourcesPath()
        const agentsDir = `${resourcesPath}/agents`
        const entries = await window.api.readDirectory(agentsDir)
        const mdFiles = entries.filter((e) => !e.isDirectory && e.name.endsWith('.md'))

        const agents: PanelItem[] = []
        for (const file of mdFiles) {
          const content = await window.api.readFile(file.path)
          if (!content) continue
          const { name, description } = parseMarkdownMeta(content)

          // Parse tools from YAML frontmatter (e.g. "tools: Read, Write, Edit, Bash")
          let allowedTools: string[] | undefined
          const toolsMatch = content.match(/^tools:\s*(.+)$/m)
          if (toolsMatch) {
            allowedTools = toolsMatch[1].split(',').map((t) => t.trim()).filter(Boolean)
          }

          agents.push({
            id: file.name,
            name,
            description,
            filePath: file.path,
            content,
            allowedTools
          })
        }

        setItems(agents)
      } catch (err) {
        console.error('[useAgents] failed to load:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [])

  return { items, loading }
}
