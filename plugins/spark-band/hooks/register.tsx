import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { describe, parseProbe, PROBE } from './reading'

const reading = atom({ plugin: 'spark-band', key: 'reading' } as const, null)
const NO_HOST = 'no host set: run `claude plugin configure spark-band` and give the ssh alias of the machine to watch'

// The startup read, the timer and /spark can overlap: only the newest probe may write its outcome.
let newestProbe = 0

// One ssh login with read-only commands; on failure keep the last good numbers and say why.
async function refresh($: any, host: string): Promise<void> {
  const probe = ++newestProbe
  const at = await $.clock.now()
  try {
    const ran = await $.process.run(
      ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, PROBE],
      { timeoutMs: 15000 },
    )
    if (ran.exitCode !== 0) throw new Error(`ssh exit ${ran.exitCode}`)
    const fresh = parseProbe(ran.stdout, at)
    if (probe === newestProbe) await update($, reading, () => fresh)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (probe !== newestProbe) return
    await update($, reading, last =>
      last === null ? { totalGb: 0, freeGb: 0, load1: 0, hasGpu: false, gpuGb: null, at: 0, error } : { ...last, error },
    )
  }
}

// True when a folder path contains `onlyIn` (either separator, any case); an empty `onlyIn` matches every folder.
function isWatched(onlyIn: string, paths: string[]): boolean {
  const want = onlyIn.replace(/\\/g, '/').toLowerCase()
  return want === '' || paths.some(p => p.replace(/\\/g, '/').toLowerCase().includes(want))
}

export const register: Register = (on, options) => {
  const host = String(options.host ?? '').trim()
  const onlyIn = String(options.onlyIn ?? '').trim()
  const intervalMs = Math.max(60, Number(options.intervalSeconds ?? 120)) * 1000
  const lowGb = Number(options.lowGb ?? 4)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spark', description: `Read ${host || 'the watched host'}'s memory and load now`, immediate: true })
    if (host !== '' && isWatched(onlyIn, [await $.session.root(), e.cwd])) {
      void refresh($, host)
      $.clock.every(intervalMs, () => void refresh($, host))
    }
    return next(e)
  })

  on('command.run', { command: 'spark' }, async $ => {
    if (host === '') return { text: NO_HOST }
    await refresh($, host)
    return { text: describe(await read($, reading), await $.clock.now(), host) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const now = await read($, reading)
    if (e.props.hasSurvey || now === null) return below
    const { Box, Text } = $.ui.resolve(e)
    const clock = await $.clock.now()
    const isStale = now.at === 0 || clock - now.at > 3 * intervalMs
    const isLow = now.at !== 0 && now.freeGb < lowGb
    const line = describe(now, clock, host).slice(0, Math.max(10, e.props.bodyColumns))
    return (
      <Box flexDirection="column">
        <Text wrap="truncate" color={now.error !== null || isLow ? 'warning' : undefined} dimColor={isStale && !isLow}>
          {line}
        </Text>
        {below}
      </Box>
    )
  })
}
