import { describe, expect, mock, test } from 'claude-code/testing'

import { bar, cacheTtl, cacheView, clock, fade, legend, tokens, toReading, withOverride } from '../hooks/meter'

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const MINUTE = 60_000
// What a compaction leaves: at least one message.
const SUMMARY = [{ role: 'user' as const, text: 'Summary of the conversation so far.', toolUses: [] }]

// A context as /context breaks it down: fake figures, shaped like the engine's.
// tokens: null is a live window before its first response (a new or just-compacted conversation).
function context(used = 46_000, live = true) {
  const row = (name: string, tokens: number, kind = 'used', color = 'promptBorder') => ({ name, tokens, color, isDeferred: false, kind })
  return {
    tokens: live ? used : undefined,
    window: 200_000,
    percent: Math.round(used / 2_000),
    breakdown: {
      categories: [
        row('System prompt', 4_200),
        row('System tools', 17_000, 'used', 'inactive'),
        row('MCP tools', 12_000, 'used', 'permission'),
        row('Messages', used - 33_200, 'used', 'claude'),
        row('Free space', 200_000 - used, 'free'),
        row('Autocompact buffer', 13_000, 'buffer'),
      ],
      totalTokens: used,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: Math.round(used / 2_000),
      isAutoCompactEnabled: true,
      autoCompactThreshold: 167_000,
    },
  }
}

type Host = { usage: () => unknown; rateLimits: unknown[]; compact: () => unknown; toasts: string[]; compacts: number; commands: string[] }

// Every stub sits beneath the plugin and is registered before the first $ call.
async function start($: any, on: any, overrides: Partial<Host> = {}) {
  const host: Host = { usage: () => context(), rateLimits: [], compact: () => ({ messages: SUMMARY }), toasts: [], compacts: 0, commands: [], ...overrides }
  const clk = mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({ value: { startedAt: 0, context: host.usage(), rateLimits: host.rateLimits } }))
  // The engine fills a compaction's messages from the transcript; here the transcript is empty.
  on('session.messages', () => ({ value: [] }))
  on('session.compact', () => {
    host.compacts += 1
    return host.compact()
  })
  on('command.run', ($: any, e: any) => {
    host.commands.push(`/${e.command}`)
    return { text: '' }
  })
  on('ui.toast', ($: any, e: any) => {
    host.toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('ui.render', ($: any, e: any) => h($.ui.resolve(e).Box, { key: 'engine-band' }))
  await $.session.start({ cwd: 'C:/work/app', surface: 'terminal', isInteractive: true })
  await clk.settle()
  return { clk, host }
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-test' }

// One model request of a turn, as the engine sends it: the stream is drained and its result returned.
async function step($: any, agentId?: string) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-test', messageCount: 2, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // chunks are not needed here
  }
  return stream.result
}

// A turn: one request, then the turn's end.
async function turn($: any, agentId?: string) {
  await step($, agentId)
  return $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', usage: USAGE, ...(agentId ? { agentId } : {}) })
}

async function band($: any, props: Partial<typeof BAND> = {}, surface = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'context-meter', surface, component: 'AbovePrompt', props: { ...BAND, ...props } })
  const text = async (pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern }))?.text
  return { ui, text }
}

describe('helpers', () => {
  test('writes token counts the way /context does', () => {
    expect(tokens(4_200)).toBe('4.2k')
    expect(tokens(17_000)).toBe('17k')
    expect(tokens(987_000)).toBe('987k')
    expect(tokens(1_000_000)).toBe('1M')
    expect(tokens(812)).toBe('812')
  })

  test('keeps only the categories that fill the window', () => {
    const r = toReading(context())
    expect(r.categories.map(c => c.name)).toEqual(['system prompt', 'system tools', 'mcp tools', 'messages'])
    expect(r.compactsAt).toBe(167_000)
    expect(r.used).toBe(46_000)
  })

  test('the bar is exactly as wide as asked, and a small category still gets a cell', () => {
    const runs = bar(toReading(context()), 60)
    expect(runs.reduce((s, r) => s + r.cells, 0)).toBe(60)
    expect(runs.slice(0, 4).every(r => r.cells >= 1)).toBe(true)
    expect(runs[runs.length - 1]?.color).toBeNull()
  })

  test('the lifetime: the option wins, else one hour on a subscription and five minutes otherwise', () => {
    expect(cacheTtl('5m', true)).toEqual({ ttl: '5m', why: 'set in options' })
    expect(cacheTtl('auto', true)).toEqual({ ttl: '1h', why: 'assumed: subscription' })
    expect(cacheTtl(undefined, false)).toEqual({ ttl: '5m', why: 'assumed: API key' })
  })

  test('the clock counts down, then says how long ago it ran out and what that costs', () => {
    expect(clock(59 * MINUTE + 59_500)).toBe('1:00:00')
    expect(clock(4 * MINUTE + 5_000)).toBe('4:05')
    expect(cacheView(null, 0, '5m', 'x', null).state).toBe('none')
    expect(cacheView(0, 2 * MINUTE, '5m', 'assumed: API key', 90_000).text).toBe('cache ▸ 3:00 left (5m TTL, assumed: API key)')
    expect(cacheView(0, 8 * MINUTE, '5m', 'x', 90_000).text).toBe('cache ▸ expired 3 min ago: the next message writes 90k to the cache again')
  })

  test('the legend lists every category and the free part, wrapped into rows that fit', () => {
    const r = toReading(context())
    const wide = legend(r, 200)
    expect(wide).toHaveLength(1)
    expect(wide[0]?.map(i => [i.name, i.tokens, i.share].join(' '))).toEqual(['system prompt 4.2k 2%', 'system tools 17k 9%', 'mcp tools 12k 6%', 'messages 13k 6%', 'free 154k 77%'])
    const narrow = legend(r, 40)
    expect(narrow.length).toBeGreaterThan(1)
    expect(narrow.flat()).toHaveLength(5)
    for (const row of narrow) expect(row.reduce((w, i, k) => w + (k > 0 ? 3 : 0) + 4 + i.name.length + i.tokens.length + i.share.length, 0)).toBeLessThanOrEqual(40)
  })

  test('a percentage override can only bring compaction earlier, and the band says it is yours', () => {
    const r = toReading({ ...context(), window: 1_000_000, breakdown: { ...context().breakdown, rawMaxTokens: 1_000_000, autoCompactThreshold: 967_000 } })
    expect(withOverride(r, '50')).toMatchObject({ compactsAt: 500_000, compactsWhy: 'your 50% setting' })
    expect(withOverride(r, '99')).toMatchObject({ compactsAt: 967_000, compactsWhy: null })
    expect(withOverride(r, undefined)).toBe(r)
    expect(withOverride(r, 'abc')).toBe(r)
    expect(withOverride({ ...r, compactsAt: null }, '50').compactsAt).toBeNull()
  })

  test('the colour runs from green, through amber, to red', () => {
    expect(fade(1)).toBe('#16a34a')
    expect(fade(0.5)).toBe('#d97706')
    expect(fade(0)).toBe('#dc2626')
  })
})

describe('context-meter band', () => {
  test('draws the fill, a coloured entry per category and the Compact button', async ($, on) => {
    await start($, on)
    const { ui, text } = await band($)
    expect(await text(/^context/)).toBe('context ▸ 46k of 200k · 23% · compacts at 167k ')
    for (const name of ['system prompt ', 'system tools ', 'mcp tools ', 'messages ', 'free ']) expect(await text(new RegExp(`^${name}$`))).toBe(name)
    expect(await text(/^cache/)).toBe('cache ▸ starts with the next message (5m TTL, assumed: API key)')
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
  })

  test('with CLAUDE_AUTOCOMPACT_PCT_OVERRIDE set, the header shows where compaction will really run', async ($, on) => {
    mock.env(on, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' })
    await start($, on)
    const { text } = await band($)
    expect(await text(/^context/)).toBe('context ▸ 46k of 200k · 23% · compacts at 100k (your 50% setting) ')
  })

  test('no Compact button before the first response, when there is nothing to compact', async ($, on) => {
    await start($, on, { usage: () => context(46_000, false) })
    const { ui } = await band($)
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  })

  test('a refused compaction says why in the band, not only in a toast', async ($, on) => {
    await start($, on, { compact: () => { throw new Error('Not enough messages to compact.') } })
    const { ui } = await band($)
    await ui.press({ key: 'compact' })
    const after = await band($)
    expect(await after.text(/^context-meter:/)).toContain('could not compact now')
  })

  test('a main-thread turn starts the countdown; on a subscription it assumes one hour', async ($, on) => {
    const { clk } = await start($, on, { rateLimits: [{ window: 'five_hour', percentUsed: 10 }] })
    await turn($)
    await clk.advance(20 * MINUTE)
    const { text } = await band($)
    expect(await text(/^cache/)).toBe('cache ▸ 40:00 left (1h TTL, assumed: subscription)')
  })

  test('every request of a long turn resets the timer, not only the end of the turn', async ($, on) => {
    const { clk } = await start($, on, { rateLimits: [{ window: 'five_hour', percentUsed: 10 }] })
    await step($)
    await clk.advance(50 * MINUTE)
    // A later request of the same turn, 50 minutes on (a long tool run in between).
    await step($)
    await clk.advance(20 * MINUTE)
    const { text } = await band($)
    expect(await text(/^cache/)).toBe('cache ▸ 40:00 left (1h TTL, assumed: subscription)')
  })

  test('while Claude works, the band says the cache is kept warm instead of counting down', async ($, on) => {
    await start($, on, { rateLimits: [{ window: 'five_hour', percentUsed: 10 }] })
    await step($)
    const { text } = await band($, { isWorking: true })
    expect(await text(/^cache/)).toBe('cache ▸ kept warm while Claude works: each request resets the 1h timer')
  })

  test("a subagent's turn does not touch the main conversation's clock", async ($, on) => {
    await start($, on)
    await turn($, 'agent-1')
    const { text } = await band($)
    expect(await text(/^cache/)).toContain('starts with the next message')
  })

  test('the countdown runs out and says so', { options: { cacheTtl: '5m' } }, async ($, on) => {
    const { clk } = await start($, on)
    await turn($)
    await clk.advance(7 * MINUTE)
    const { text } = await band($)
    expect(await text(/^cache/)).toBe('cache ▸ expired 2 min ago: the next message writes 46k to the cache again')
  })

  // The test engine does not fill in the transcript of a compaction a plugin starts, so the press is checked
  // to ask for one; what follows a compaction is checked through /compact below, as the session runs it.
  test('the button asks for the same compaction /compact runs', async ($, on) => {
    const { host } = await start($, on)
    const { ui } = await band($)
    await ui.press({ key: 'compact' })
    expect(host.compacts).toBe(1)
  })

  test('where the host has no between-turns compaction (the desktop app), the button runs /compact instead', async ($, on) => {
    const { host } = await start($, on)
    const { ui } = await band($, {}, 'desktop')
    await ui.press({ key: 'compact' })
    expect(host.compacts).toBe(0)
    expect(host.commands).toEqual(['/compact'])
    const after = await band($, {}, 'desktop')
    expect(await after.text(/^context-meter:/)).toBeUndefined()
    expect(host.toasts).toEqual([])
  })

  // The engine swaps the summary in only after every session.compact hook has returned, so until then the
  // window still reads as before; here that swap is the line after the compaction resolves.
  test('after /compact the band re-reads the window once the summary is in place, and the cache clock starts over', async ($, on) => {
    let used = 46_000
    const { clk } = await start($, on, { usage: () => context(used) })
    await turn($)
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    used = 20_000
    await clk.advance(1000)
    const { text } = await band($)
    expect(await text(/^context/)).toBe('context ▸ 20k of 200k · 10% · compacts at 167k ')
    expect(await text(/^cache/)).toContain('starts with the next message')
  })

  test('a /compact run inside a turn (the desktop app) is re-read when that turn ends', async ($, on) => {
    let used = 46_000
    await start($, on, { usage: () => context(used) })
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    used = 20_000
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer', usage: USAGE })
    const { text } = await band($)
    expect(await text(/^context/)).toBe('context ▸ 20k of 200k · 10% · compacts at 167k ')
  })

  test('a vetoed compaction says why in a toast and changes nothing', async ($, on) => {
    const { host } = await start($, on, { compact: () => ({ skip: 'a PreCompact hook blocked it' }) })
    const { ui } = await band($)
    await ui.press({ key: 'compact' })
    expect(host.toasts).toEqual(['context-meter: compaction skipped: a PreCompact hook blocked it'])
  })

  test('while a turn runs there is no button; a short band keeps the fill and the clock only', async ($, on) => {
    await start($, on)
    const busy = await band($, { isWorking: true })
    expect(await busy.ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()
    const short = await band($, { maxRows: 4 })
    expect(await short.text(/^system prompt /)).toBeUndefined()
    expect(await short.text(/^cache/)).toBeDefined()
  })
})
