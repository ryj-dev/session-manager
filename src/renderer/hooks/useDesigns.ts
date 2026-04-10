import { useState, useEffect, useRef } from 'react'
import { DesignItem, extractBrandColor } from './usePanelItems'

export function useDesigns(): { items: DesignItem[]; loading: boolean } {
  const [items, setItems] = useState<DesignItem[]>([])
  const [loading, setLoading] = useState(true)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true

    async function load(): Promise<void> {
      try {
        const resourcesPath = await window.api.getResourcesPath()
        const designDir = `${resourcesPath}/design`
        const entries = await window.api.readDirectory(designDir)
        const dirs = entries.filter((e) => e.isDirectory)

        const designs: DesignItem[] = []
        for (const dir of dirs) {
          const designMdPath = `${dir.path}/DESIGN.md`
          const content = await window.api.readFile(designMdPath)
          if (!content) continue

          designs.push({
            id: dir.name,
            name: dir.name.replace(/\./g, ' ').replace(/(^|\s)\w/g, (c) => c.toUpperCase()),
            description: '',
            filePath: designMdPath,
            content,
            brandColor: extractBrandColor(content),
            previewHtmlPath: `${dir.path}/preview.html`,
            previewDarkHtmlPath: `${dir.path}/preview-dark.html`
          })
        }

        setItems(designs)
      } catch (err) {
        console.error('[useDesigns] failed to load:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [])

  return { items, loading }
}
