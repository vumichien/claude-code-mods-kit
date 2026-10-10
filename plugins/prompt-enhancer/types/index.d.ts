// What one press cost, as the band shows it.
export type CostLine = string

declare module 'claude-code' {
  interface PluginState {
    // enabled: the mod's on/off switch as this session read it from the store, or as /prompt-enhancer on|off set it.
    // isBusy: a rewrite is on its way. note: what the last press did. lastCost: the tokens the last rewrite took.
    'prompt-enhancer': { enabled: boolean; isBusy: boolean; note: string | null; lastCost: CostLine | null }
  }
}
