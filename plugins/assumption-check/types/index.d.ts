// One guess Claude made that the author did not state: what, where, and why Claude chose it.
export type Assumption = { claim: string; where: string; why: string }

// An assumption as the review holds it: the author's mark, and the note the corrections carry.
export type Item = Assumption & { mark: 'right' | 'wrong' | null; note: string }

declare module 'claude-code' {
  interface PluginState {
    // enabled: the mod's on/off switch as this session read it from the store, or as /assumption-check on|off set it.
    // items: the last checked turn's assumptions, for this session only. checking: Haiku is reading the last turn.
    // notice: what the last action did, or why the check failed. lastCost: the tokens the last check took.
    // isFilled: the corrections are in the prompt box, so the review's button now sends them. round: how many lists
    // this session has had, which keys the review's elements.
    'assumption-check': { enabled: boolean; items: Item[]; checking: boolean; notice: string | null; lastCost: string | null; isFilled: boolean; round: number }
  }
}
