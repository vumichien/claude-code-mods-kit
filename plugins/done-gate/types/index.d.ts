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
    // enabled: the mod's on/off switch as this session read it from the store, or as /done-gate on|off set it.
    'done-gate': { gate: Gate; enabled: boolean }
  }
}
