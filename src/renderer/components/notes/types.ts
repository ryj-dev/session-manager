export interface Todo {
  id: string
  title: string
  body: string
  done: boolean
  tags: string[]
  created: string
  updated: string
}

export interface TodoSummary {
  id: string
  title: string
  done: boolean
  tags: string[]
  created: string
  updated: string
}

export interface TagCount {
  tag: string
  count: number
}

export const PROJECT_TAG_PREFIX = 'project:'

export function isProjectTag(tag: string): boolean {
  return tag.startsWith(PROJECT_TAG_PREFIX)
}

export function projectFromTag(tag: string): string {
  return tag.startsWith(PROJECT_TAG_PREFIX) ? tag.slice(PROJECT_TAG_PREFIX.length) : tag
}
