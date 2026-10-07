import { describe, expect, mock, test } from 'claude-code/testing'

// Runs a slash command as the person would; the test host fills in args, origin and presentation.
const runCommand = ($: any, command: string) => $.command.run({ command })

// Synthetic probe output (not a real reading): 121 GB total, 9 free; load 1.50; two GPU processes.
const SYNTHETIC = '121 9\n1.50\n50000\n30000\n'
const SPARK = { options: { host: 'spark' } }
const SYNTHETIC_LOW = '121 2\n0.40\n100000\n'
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

type ProbeOut = { exitCode: number; stdout: string }
type Host = { probe: () => ProbeOut | Promise<ProbeOut>; runs: string[][] }

// Every stub sits beneath the plugin and is registered before the first $ call.
async function start($: any, on: any, host: Host, root = 'C:\\work\\llm-project') {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.root', () => ({ value: root }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('process.run', async ($: any, e: any) => {
    host.runs.push([...e.argv])
    const out = await host.probe()
    return { value: { ...out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: 'no hook answered' }))
  // Stands for the engine's own band: an empty Box the mod draws beside.
  on('ui.render', ($: any, e: any) => h($.ui.resolve(e).Box, { key: 'engine-band' }))
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

async function bandText($: any, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ plugin: 'spark-band', surface, component: 'AbovePrompt', props: BAND })
  return ui.find({ type: 'Text', text: /^spark/ })
}

describe('spark-band', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws the band from a synthetic reading (${surface})`, SPARK, async ($, on) => {
      const host: Host = { probe: () => ({ exitCode: 0, stdout: SYNTHETIC }), runs: [] }
      await start($, on, host)
      const found = await bandText($, surface)
      expect(found?.text).toBe('spark ▸ 9 of 121 GB free · GPU processes 78 GB · load 1.5 · 0 s ago')
      expect(found?.props.color).toBeUndefined()
      expect(host.runs[0]?.slice(0, 6)).toEqual(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'spark'])
    })
  }

  test('warns under the low-memory line (synthetic)', SPARK, async ($, on) => {
    await start($, on, { probe: () => ({ exitCode: 0, stdout: SYNTHETIC_LOW }), runs: [] })
    const found = await bandText($, 'terminal')
    expect(found?.text).toContain('2 of 121 GB free')
    expect(found?.props.color).toBe('warning')
  })

  test('reads again every interval and dims a stale reading after ssh starts failing', SPARK, async ($, on) => {
    let isUp = true
    const host: Host = { probe: () => (isUp ? { exitCode: 0, stdout: SYNTHETIC } : { exitCode: 255, stdout: '' }), runs: [] }
    const clock = await start($, on, host)
    await clock.advance(120_000)
    expect(host.runs.length).toBe(2)
    isUp = false
    await clock.advance(4 * 120_000)
    const found = await bandText($, 'terminal')
    expect(found?.text).toContain('9 of 121 GB free')
    expect(found?.text).toContain('spark unreachable now')
    expect(found?.props.dimColor).toBe(true)
  })

  test('says unreachable when ssh fails before any reading', SPARK, async ($, on) => {
    await start($, on, { probe: () => ({ exitCode: 255, stdout: '' }), runs: [] })
    const found = await bandText($, 'terminal')
    expect(found?.text).toBe('spark unreachable (ssh exit 255)')
  })

  test('/spark reads now and replies with one line', SPARK, async ($, on) => {
    const host: Host = { probe: () => ({ exitCode: 0, stdout: SYNTHETIC }), runs: [] }
    await start($, on, host)
    const reply = await runCommand($, 'spark')
    expect(reply.text).toBe('spark ▸ 9 of 121 GB free · GPU processes 78 GB · load 1.5 · 0 s ago')
    expect(host.runs.length).toBe(2)
  })

  test('outside the onlyIn folders it reads nothing until /spark', { options: { host: 'spark', onlyIn: 'gpu-work' } }, async ($, on) => {
    const host: Host = { probe: () => ({ exitCode: 0, stdout: SYNTHETIC }), runs: [] }
    const clock = await start($, on, host, 'C:\\Users\\someone\\other-project')
    await clock.advance(10 * 120_000)
    expect(host.runs.length).toBe(0)
    await runCommand($, 'spark')
    expect(host.runs.length).toBe(1)
  })

  test('a GPU row that is not a number reads as unknown, not 0 (synthetic)', SPARK, async ($, on) => {
    await start($, on, { probe: () => ({ exitCode: 0, stdout: '121 9\n1.50\n50000\n[N/A]\n' }), runs: [] })
    const found = await bandText($, 'terminal')
    expect(found?.text).toContain('GPU processes ? GB')
  })

  test('an older probe that finishes last does not overwrite a newer reading', SPARK, async ($, on) => {
    let release: (out: ProbeOut) => void = () => {}
    let calls = 0
    const host: Host = {
      probe: () => {
        calls += 1
        // The startup probe hangs until released; /spark's probe answers at once.
        return calls === 1 ? new Promise<ProbeOut>(resolve => { release = resolve }) : { exitCode: 0, stdout: SYNTHETIC }
      },
      runs: [],
    }
    const clock = await start($, on, host)
    await runCommand($, 'spark')
    release({ exitCode: 255, stdout: '' })
    await clock.settle()
    const found = await bandText($, 'terminal')
    expect(found?.text).toBe('spark ▸ 9 of 121 GB free · GPU processes 78 GB · load 1.5 · 0 s ago')
  })

  test('with no host set it reads nothing and /spark says how to set one', async ($, on) => {
    const host: Host = { probe: () => ({ exitCode: 0, stdout: SYNTHETIC }), runs: [] }
    const clock = await start($, on, host)
    await clock.advance(10 * 120_000)
    const reply = await runCommand($, 'spark')
    expect(host.runs.length).toBe(0)
    expect(reply.text).toContain('claude plugin configure spark-band')
  })

  test('a host without nvidia-smi gets a line with no GPU part (synthetic)', SPARK, async ($, on) => {
    await start($, on, { probe: () => ({ exitCode: 0, stdout: '64 40\n0.20\nno-gpu\n' }), runs: [] })
    const found = await bandText($, 'terminal')
    expect(found?.text).toBe('spark ▸ 40 of 64 GB free · load 0.2 · 0 s ago')
  })
})
