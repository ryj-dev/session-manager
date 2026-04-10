import { useState, useEffect, useRef } from 'react'
import { PanelItem, parseMarkdownMeta } from './usePanelItems'

export function useSkills(): { items: PanelItem[]; loading: boolean } {
  const [items, setItems] = useState<PanelItem[]>([])
  const [loading, setLoading] = useState(true)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true

    async function load(): Promise<void> {
      try {
        const resourcesPath = await window.api.getResourcesPath()
        const skillsDir = `${resourcesPath}/skills`
        const entries = await window.api.readDirectory(skillsDir)
        const mdFiles = entries.filter((e) => !e.isDirectory && e.name.endsWith('.md'))

        const skills: PanelItem[] = []
        for (const file of mdFiles) {
          const content = await window.api.readFile(file.path)
          if (!content) continue
          const { name, description } = parseMarkdownMeta(content)
          skills.push({
            id: file.name,
            name,
            description,
            filePath: file.path,
            content
          })
        }

        setItems(skills)
      } catch (err) {
        console.error('[useSkills] failed to load:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [])

  return { items, loading }
}
