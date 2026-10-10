export type Status = 'done' | 'active' | 'todo' | 'dropped'

export type Count = { done: number; active: number; todo: number; total: number }

export type PlanMeter = {
  // The plan file, relative to the project when it lies inside it.
  file: string
  title: string | null
  // The plan's own status line or frontmatter status, as written.
  planStatus: string | null
  // Phases: status-table rows, status headings, or linked phase files (dropped ones left out).
  phases: Count
  // Steps: checklist items, org-mode headlines, todo.txt lines, in the plan and its linked phase files.
  steps: Count
  // The first phase or step in progress, and the first ones still to do.
  current: string | null
  next: string[]
  // Which formats were recognised, and how many files were read (the plan plus linked phase files).
  formats: string[]
  files: number
  // Set when no plan was found or it could not be read.
  error: string | null
}

// Claude's own task list, as its TodoWrite / TaskCreate / TaskUpdate calls left it.
export type ClaudeTask = { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed' }

declare module 'claude-code' {
  interface PluginState {
    // enabled: the mod's on/off switch as this session read it from the store, or as /plan-meter on|off set it.
    'plan-meter': { meter: PlanMeter | null; tasks: ClaudeTask[]; enabled: boolean }
  }
}
