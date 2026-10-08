export type Gate = {
  // The last test command that finished in this session.
  lastTest: { passed: boolean; at: number; command: string } | null
  // Code files Claude changed since the last passing test run, relative to the project.
  unchecked: string[]
  // How many times a task was marked done while code was unchecked.
  warnings: number
}

declare module 'claude-code' {
  interface PluginState {
    // shown: the band switched on or off with /done-gate on|off this session; null until then (the band option decides).
    'done-gate': { gate: Gate; shown: boolean | null }
  }
}
