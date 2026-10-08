// Pure helpers for context-meter: token labels, the category bar, the cache clock and its colour.

import type { CacheTtl, Category, ContextReading } from '../types'

const MINUTE = 60_000
export const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * MINUTE, '1h': 60 * MINUTE }

// 4.2k, 17k, 1M: the way /context writes token counts.
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${n >= 10_000 ? Math.round(n / 1_000) : trim(n / 1_000)}k`
  return String(Math.round(n))
}

function trim(x: number): string {
  return x.toFixed(1).replace(/\.0$/, '')
}

// The breakdown as the band draws it: the categories that fill the window, in /context's order and colours.
export function toReading(context: any): ContextReading {
  const b = context?.breakdown
  const categories: Category[] = (b?.categories ?? [])
    .filter((c: any) => c.kind === 'used' && c.tokens > 0)
    .map((c: any) => ({ name: String(c.name).toLowerCase(), tokens: c.tokens, color: c.color }))
  return {
    tokens: context?.tokens ?? null,
    window: b?.rawMaxTokens ?? context?.window ?? 0,
    percent: b?.percentage ?? context?.percent ?? null,
    used: b?.totalTokens ?? context?.tokens ?? null,
    compactsAt: b?.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null,
    compactsWhy: null,
    categories,
  }
}

// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (1-100) moves auto-compaction to that share of the auto-compact window; it
// can only lower the threshold. The breakdown's threshold need not include it (on 2.1.294 a 1M session set to
// 50 still reports 967k), so the band takes the lower of the two, marked as the person's setting when it is
// the override. Where the breakdown already includes it, its own lower figure wins and nothing is marked.
export function withOverride(reading: ContextReading, pct: string | undefined): ContextReading {
  const n = Number(pct)
  if (reading.compactsAt === null || !Number.isInteger(n) || n < 1 || n > 100) return reading
  const at = Math.floor((reading.window * n) / 100)
  return at < reading.compactsAt ? { ...reading, compactsAt: at, compactsWhy: `your ${n}% setting` } : reading
}

// One bar `width` cells wide: a run of cells per category, in proportion to the window, then the free part.
// A category too small for a cell still gets one, so nothing that fills the window disappears from the bar.
export function bar(reading: ContextReading, width: number): { cells: number; color: string | null }[] {
  if (reading.window <= 0 || width <= 0) return []
  const runs = reading.categories.map(c => ({ cells: Math.max(1, Math.round((c.tokens / reading.window) * width)), color: c.color }))
  let used = runs.reduce((sum, r) => sum + r.cells, 0)
  // Rounding up the small ones can overrun; take the excess back from the largest runs.
  while (used > width) {
    const largest = runs.reduce((a, b) => (b.cells > a.cells ? b : a))
    if (largest.cells <= 1) break
    largest.cells -= 1
    used -= 1
  }
  return used < width ? [...runs, { cells: width - used, color: null }] : runs
}

export type LegendItem = { name: string; tokens: string; share: string; color: string | null }

// One entry per category plus the free part, laid out in rows no wider than `columns` cells, so every one shows.
export function legend(reading: ContextReading, columns: number): LegendItem[][] {
  const share = (n: number) => {
    const p = (n / Math.max(1, reading.window)) * 100
    return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
  }
  const items: LegendItem[] = reading.categories.map(c => ({ name: c.name, tokens: tokens(c.tokens), share: share(c.tokens), color: c.color }))
  if (reading.used !== null && reading.window > reading.used) {
    const free = reading.window - reading.used
    items.push({ name: 'free', tokens: tokens(free), share: share(free), color: null })
  }
  // An entry draws as "■ name 4.2k 1%", entries three cells apart.
  const width = (i: LegendItem) => 2 + i.name.length + 1 + i.tokens.length + 1 + i.share.length
  const rows: LegendItem[][] = []
  let row: LegendItem[] = []
  let used = 0
  for (const item of items) {
    const gap = row.length > 0 ? 3 : 0
    if (row.length > 0 && used + gap + width(item) > columns) {
      rows.push(row)
      row = []
      used = 0
    }
    used += (row.length > 0 ? 3 : 0) + width(item)
    row.push(item)
  }
  if (row.length > 0) rows.push(row)
  return rows
}

// The cache's lifetime: the option when it names one; otherwise one hour on a subscription (Claude Code's
// default there, within the plan's included usage) and five minutes with an API key or a cloud provider.
export function cacheTtl(option: string | undefined, onSubscription: boolean): { ttl: CacheTtl; why: string } {
  if (option === '5m' || option === '1h') return { ttl: option, why: 'set in options' }
  return onSubscription ? { ttl: '1h', why: 'assumed: subscription' } : { ttl: '5m', why: 'assumed: API key' }
}

export type CacheView = { state: 'none' | 'warm' | 'expired'; text: string; left: number }

// What the cache line says, `now` milliseconds into the session's clock.
export function cacheView(lastAt: number | null, now: number, ttl: CacheTtl, why: string, contextTokens: number | null): CacheView {
  const life = TTL_MS[ttl]
  if (lastAt === null) return { state: 'none', text: `cache ▸ starts with the next message (${ttl} TTL, ${why})`, left: 1 }
  const remaining = lastAt + life - now
  if (remaining > 0) return { state: 'warm', text: `cache ▸ ${clock(remaining)} left (${ttl} TTL, ${why})`, left: remaining / life }
  const resend = contextTokens !== null ? `: the next message writes ${tokens(contextTokens)} to the cache again` : ''
  return { state: 'expired', text: `cache ▸ expired ${ago(-remaining)} ago${resend}`, left: 0 }
}

// 52:07, or 4:05 under an hour's last ten minutes; never a fraction of a second.
export function clock(ms: number): string {
  const s = Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function ago(ms: number): string {
  const m = Math.floor(ms / MINUTE)
  return m < 1 ? `${Math.floor(ms / 1000)} s` : m < 120 ? `${m} min` : `${Math.floor(m / 60)} h`
}

// Green with the whole lifetime left, through amber, to red as it runs out: `left` is the share remaining.
export function fade(left: number): string {
  const red = [220, 38, 38]
  const amber = [217, 119, 6]
  const green = [22, 163, 74]
  const x = Math.min(1, Math.max(0, left))
  // Two straight runs: red to amber over the last half, amber to green over the first.
  const [from, to, t] = x <= 0.5 ? [red, amber, x / 0.5] : [amber, green, (x - 0.5) / 0.5]
  return `#${from.map((v, k) => Math.round(v + ((to[k] ?? v) - v) * t).toString(16).padStart(2, '0')).join('')}`
}
