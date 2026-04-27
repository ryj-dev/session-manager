export interface NoteEntry {
  relPath: string
  name: string
  project: string | null
  subdir: string[]
  kind: 'note' | 'todo-list'
}

export type TodoStatus = 'not-started' | 'agent-todo' | 'in-progress' | 'completed'

export const TODO_STATUSES: TodoStatus[] = ['not-started', 'agent-todo', 'in-progress', 'completed']

export interface TodoItem {
  id: string
  text: string
  status: TodoStatus
  created: string
  updated?: string
  assignee?: string | null
  assigneeLabel?: string | null
}

export interface TodoListFile {
  type: 'todo-list'
  title: string
  created: string
  updated: string
  todos: TodoItem[]
}

export interface AggregatedTodo {
  listRelPath: string
  listTitle: string
  project: string | null
  todo: TodoItem
}
