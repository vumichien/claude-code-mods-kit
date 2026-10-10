// What a session is doing: working (a turn runs), waiting (a permission dialog or a question is open), done (idle).
export type State = 'working' | 'waiting' | 'done'

// One session's heartbeat file. `ended`: the session closed. `since`: when the state began. `updatedAt`: the last
// write, so a reader can tell a live session from one that is gone.
export type Beat = { v: 1; id: string; folder: string; title: string; state: State | 'ended'; since: number; updatedAt: number }

declare module 'claude-code' {
  interface PluginState {
    // enabled: the mod's on/off switch as this session read it from the store, or as /session-monitor on|off set it.
    // others: the other sessions still open, as the last read of their files found them. now: when that read ran.
    'session-monitor': { enabled: boolean; others: Beat[]; now: number }
  }
}
