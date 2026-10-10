import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { bar, cacheTtl, cacheView, fade, legend, tokens, toReading, withOverride } from './meter'
import { STORE_KEY, storedSwitch, switchText, switchWord } from './toggle'

const reading = atom({ plugin: 'context-meter', key: 'reading' } as const, null)
const cache = atom({ plugin: 'context-meter', key: 'cache' } as const, { lastAt: null })
// The clock the cache line was last drawn at; written only when that line's text would change.
const now = atom({ plugin: 'context-meter', key: 'now' } as const, 0)
const onSubscription = atom({ plugin: 'context-meter', key: 'onSubscription' } as const, false)
const notice = atom({ plugin: 'context-meter', key: 'notice' } as const, null)
// The switch as this session read it (toggle.ts). Off, every hook passes its event on unchanged: the window is not
// measured, the cache clock does not run and nothing is drawn. The mod starts off; `/context-meter on` turns it on.
const enabled = atom({ plugin: 'context-meter', key: 'enabled' } as const, false)

type Detail = 'summary' | 'full'

async function ttlFor($: any, option: unknown) {
  return cacheTtl(typeof option === 'string' ? option : undefined, await read($, onSubscription))
}

// The breakdown /context draws, read again after each turn. `summary` estimates locally and sends nothing.
async function measure($: any, detail: Detail): Promise<void> {
  const usage = await $.session.usage({ breakdown: detail, columns: 80 })
  // Rate-limit windows come back only on a subscription: the one hint there is about the cache's lifetime.
  await update($, onSubscription, () => usage.rateLimits.length > 0)
  const pct = await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE').catch(() => undefined)
  await update($, reading, () => withOverride(toReading(usage.context), pct))
}

// How long after a compaction the band reads the window again: the engine puts the summary in place of the
// conversation only once every session.compact hook has returned, so a reading taken inside the hook (or
// as the call resolves) still counts the old messages.
const SETTLE_MS = 1000
// A compaction whose new window the band has not read yet; the turn that ran /compact reads it as it ends.
let isPending = false

// The main conversation's cache is rewritten by the compaction's next request, so its clock starts over.
async function compacted($: any, detail: Detail): Promise<void> {
  await update($, cache, () => ({ lastAt: null }))
  isPending = true
  $.clock.after(SETTLE_MS, () => void remeasure($, detail))
}

async function remeasure($: any, detail: Detail): Promise<void> {
  isPending = false
  await measure($, detail).catch(() => undefined)
}

// Moves the drawn clock on, but only when the cache line's text would change, so the band redraws once a
// second while the countdown runs and once a minute after it has run out.
async function tick($: any, option: unknown): Promise<void> {
  const [stamp, at, t, r] = [await read($, cache), await $.clock.now(), await ttlFor($, option), await read($, reading)]
  const before = cacheView(stamp.lastAt, await read($, now), t.ttl, t.why, r?.tokens ?? null).text
  if (cacheView(stamp.lastAt, at, t.ttl, t.why, r?.tokens ?? null).text !== before) await update($, now, () => at)
}

// Restarts the cache clock at `at`, the moment a request that used the cache was sent.
async function stamp($: any, at: number): Promise<void> {
  const drawnAt = await $.clock.now()
  await update($, cache, () => ({ lastAt: at }))
  await update($, now, () => drawnAt)
}

// Starts the meter: reads the window now and runs the cache clock once a second. The timer is returned so that
// turning the mod off can stop it.
async function begin($: any, detail: Detail, ttlOption: unknown): Promise<{ cancel: () => void }> {
  await measure($, detail).catch(() => undefined)
  return $.clock.every(1000, () => void tick($, ttlOption).catch(() => undefined))
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

// The band's button: the same compaction /compact runs. It is refused while a turn runs or with too few
// messages, and a hook may veto it. The outcome shows in the band as well as a toast, which some surfaces hide.
// An SDK host (the desktop app's Code tab, the IDE extensions) has no between-turns compaction yet: there
// /compact runs as a command inside a turn, so the button runs that command, as if it were typed, and the
// session.compact hook below re-reads the window when it lands.
async function compactNow($: any, detail: Detail, surface: string): Promise<void> {
  await update($, notice, () => 'compacting… (the model is writing the summary)')
  let said: string | null = null
  const viaCommand = async () => {
    try {
      await $.command.run({ command: 'compact', args: '' })
    } catch (err) {
      said = `could not compact now: ${reason(err)}`
    }
  }
  if (surface !== 'terminal') {
    await viaCommand()
  } else {
    try {
      const result = await $.session.compact()
      if (result.skip !== undefined) said = `compaction skipped: ${result.skip}`
      else await compacted($, detail)
    } catch (err) {
      if (/headless/i.test(reason(err))) await viaCommand()
      else said = `could not compact now: ${reason(err)}`
    }
  }
  await update($, notice, () => said)
  if (said !== null) $.ui.toast(`context-meter: ${said}`)
}

export const register: Register = (on, options) => {
  const detail: Detail = options.breakdown === 'full' ? 'full' : 'summary'
  // session.start can fire again in one load (an enable, a worker respawn); one ticking clock is enough.
  let ticking: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // `immediate`: the switch works while Claude is still working. The command is registered even when the mod is
    // off, so that it can be turned on.
    await $.command
      .register({ name: 'context-meter', description: 'Show what fills the context window and when the cache expires (/context-meter on or off switches the mod)', argumentHint: '[on|off|status]', immediate: true })
      .catch(() => undefined)
    const isOn = storedSwitch(await $.store.get(STORE_KEY).catch(() => undefined), false)
    await update($, enabled, () => isOn)
    ticking?.cancel()
    ticking = isOn ? await begin($, detail, options.cacheTtl) : undefined
    return started
  })

  on('command.run', { command: 'context-meter' }, async ($, e) => {
    const word = switchWord(e.args)
    if (word === undefined) return { text: 'use /context-meter on, /context-meter off or /context-meter status' }
    if (word === 'status') {
      if (!(await read($, enabled))) return { text: switchText('context-meter', false) }
      const r = await read($, reading)
      const used = r === null || r.used === null ? '' : ` · context ${tokens(r.used)} of ${tokens(r.window)}${r.percent !== null ? ` (${r.percent}%)` : ''}`
      return { text: `${switchText('context-meter', true)}${used}` }
    }
    const isOn = word === 'on'
    await $.store.set(STORE_KEY, isOn)
    await update($, enabled, () => isOn)
    ticking?.cancel()
    ticking = isOn ? await begin($, detail, options.cacheTtl) : undefined
    return { text: switchText('context-meter', isOn) }
  })

  on('session.measure', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const measured = await next(e)
    await measure($, detail).catch(() => undefined)
    return measured
  })

  // Every request of the main conversation reads or writes its cache, and each one that hits it resets the
  // cache's timer. So the clock restarts at each model request (each step of a turn, not only the turn's end),
  // from the moment it was sent; a request that brought back no usage (failed, interrupted) did not count.
  // A subagent's requests have caches of their own.
  on('turn.step', async function* ($, e, next) {
    if (!(await read($, enabled))) return yield* next(e)
    const sentAt = await $.clock.now()
    const response = yield* next(e)
    if (e.agentId === undefined && response.usage !== null) await stamp($, sentAt).catch(() => undefined)
    return response
  })

  on('turn.complete', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const done = await next(e)
    if (e.agentId === undefined) {
      await update($, notice, () => null).catch(() => undefined)
      if (isPending) await remeasure($, detail)
    }
    return done
  })

  // /compact and auto-compaction; the band's own button calls compact() and sees its answer there instead.
  on('session.compact', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const result = await next(e)
    // An observer: the compaction's result goes back as it came, whatever happens to the band.
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) await compacted($, detail).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!(await read($, enabled)) || options.band === 'off') return below
    const r = await read($, reading)
    if (e.props.hasSurvey || r === null || r.window <= 0) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const t = await ttlFor($, options.cacheTtl)
    // While a turn runs, each of its requests resets the timer, so the countdown only means something between
    // turns: then it runs from the last request.
    const idle = cacheView((await read($, cache)).lastAt, await read($, now), t.ttl, t.why, r.tokens)
    const view = e.props.isWorking
      ? { state: 'warm' as const, left: 1, text: `cache ▸ kept warm while Claude works: each request resets the ${t.ttl} timer` }
      : idle
    const width = Math.max(10, Math.min(60, e.props.bodyColumns - 2))
    const head = [
      `context ▸ ${r.used !== null ? tokens(r.used) : '?'} of ${tokens(r.window)}`,
      r.percent !== null ? `${r.percent}%` : null,
      r.compactsAt === null
        ? 'auto-compact off'
        : `compacts at ${tokens(r.compactsAt)}${r.compactsWhy !== null ? ` (${r.compactsWhy})` : ''}`,
    ].filter(Boolean).join(' · ')
    const columns = Math.max(20, e.props.bodyColumns - 2)
    const rows = legend(r, columns)
    // The whole band when there is room, else the two rows that matter: the fill and the cache clock.
    const isFull = e.props.maxRows >= 6 + rows.length
    const said = await read($, notice)
    // Nothing to compact before the live window's first response (a new or just-compacted conversation),
    // and a compaction is refused while a turn runs: the button shows only when one can work.
    const canCompact = !e.props.isWorking && r.tokens !== null && said?.startsWith('compacting') !== true
    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between" width={columns}>
          <Text wrap="truncate">{`${head} `}</Text>
          {canCompact && <Button key="compact" label="Compact" hotkey="c" onPress={() => compactNow($, detail, e.surface)} />}
        </Box>
        {isFull && (
          <Box>
            {bar(r, width).map((run, i) => (
              <Text key={`run-${i}`} color={run.color ?? undefined} dimColor={run.color === null}>
                {(run.color === null ? '░' : '█').repeat(run.cells)}
              </Text>
            ))}
          </Box>
        )}
        {isFull &&
          rows.map((row, i) => (
            <Box key={`legend-${i}`}>
              {row.map((item, k) => (
                <Box key={item.name}>
                  <Text color={item.color ?? undefined} dimColor={item.color === null}>{`${k > 0 ? '   ' : ''}■ `}</Text>
                  <Text>{`${item.name} `}</Text>
                  <Text bold>{item.tokens}</Text>
                  <Text dimColor>{` ${item.share}`}</Text>
                </Box>
              ))}
            </Box>
          ))}
        <Text wrap="truncate" color={view.state === 'warm' ? fade(view.left) : view.state === 'expired' ? 'error' : undefined} dimColor={view.state === 'none'}>
          {view.text}
        </Text>
        {said !== null && <Text color={said.startsWith('compacting') ? 'warning' : 'error'} wrap="truncate">{`context-meter: ${said}`}</Text>}
        {below}
      </Box>
    )
  })
}
