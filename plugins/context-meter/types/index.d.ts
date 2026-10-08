export type CacheTtl = '5m' | '1h'

// One row of /context's breakdown that fills the window (free space and the compaction buffer are left out).
export type Category = { name: string; tokens: number; color: string }

export type ContextReading = {
  // Input tokens the last response was answered over; null before the first response of the live window.
  tokens: number | null
  // The window the breakdown measures against (the compaction window when that is smaller).
  window: number
  percent: number | null
  // The breakdown's estimated total; null without a breakdown.
  used: number | null
  // The token count at which auto-compaction runs; null when it is off.
  compactsAt: number | null
  // Where compactsAt came from when it is not Claude Code's own figure (the person's percentage override).
  compactsWhy: string | null
  categories: Category[]
}

// When the main conversation's last model response arrived, by the session's clock; null before one, or
// after a compaction, whose next request writes a new cache.
export type CacheStamp = { lastAt: number | null }

declare module 'claude-code' {
  interface PluginState {
    // notice: what the Compact button last did ("compacting…", or why it could not), until the next turn ends.
    'context-meter': { reading: ContextReading | null; cache: CacheStamp; now: number; onSubscription: boolean; notice: string | null }
  }
}
