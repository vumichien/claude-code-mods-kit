// One idea on a project's shelf: its text as typed, and when it was parked.
export type Idea = { id: string; text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    // enabled: the mod's on/off switch as this session read it from the store, or as /idea-shelf on|off set it.
    // ideas: this project's shelf, as the store holds it. notice: what the last action did, shown in the shelf.
    // editing: the idea whose text is open for editing in the shelf, by id.
    'idea-shelf': { enabled: boolean; ideas: Idea[]; notice: string | null; editing: string | null }
  }
}
