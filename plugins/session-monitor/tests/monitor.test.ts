import { describe, expect, mock, test } from 'claude-code/testing'

import { STALE_MS, ago, alsoHere, counts, folderKey, liveOthers, readBeat, titleOf } from '../hooks/monitor'

const ROOT = 'C:/work/app'
const HOME = 'C:\\Users\\me'
const DIR = 'C:/Users/me/.cache/claude-mods/session-monitor'
const NOW = 1_000_000
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const PANE_PROPS = { title: 'Sessions', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} }

// The heartbeat folder beneath the plugin: each file's text and when it was last written. calls: every $ call
// that writes, reads, lists or draws, by event name. inCall: the session's own state while a tool call runs.
type Host = { files: Record<string, string>; mtimes: Record<string, number>; calls: string[]; verdict: string; inCall: string[] }

// The engine hands a Windows path over with backslashes; the host keeps forward slashes.
const norm = (p: string) => p.split('\\').join('/')

const beat = (id: string, folder: string, state: string, updatedAt: number, title = `task ${id}`) =>
  JSON.stringify({ v: 1, id, folder, title, state, since: updatedAt - 30_000, updatedAt })

// stored: what the plugin's store holds as the session starts ({ enabled: true } is an earlier /session-monitor on).
async function start($: any, on: any, stored: Record<string, unknown> = { enabled: true }) {
  const host: Host = { files: {}, mtimes: {}, calls: [], verdict: 'allow', inCall: [] }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  mock.env(on, { USERPROFILE: HOME })
  on('fs.write', ($: any, e: any) => {
    host.calls.push('fs.write')
    host.files[norm(e.path)] = e.text
    host.mtimes[norm(e.path)] = clock.now()
    return { value: undefined }
  })
  on('fs.read', ($: any, e: any) => {
    host.calls.push('fs.read')
    if (!(norm(e.path) in host.files)) throw new Error(`ENOENT ${e.path}`)
    return { value: host.files[norm(e.path)] }
  })
  on('fs.list', ($: any, e: any) => {
    host.calls.push('fs.list')
    const dir = norm(e.path)
    const names = Object.keys(host.files).filter(f => f.startsWith(`${dir}/`))
    return { value: names.map(f => ({ name: f.slice(dir.length + 1), kind: 'file', size: 1, mtimeMs: host.mtimes[f] ?? 0, isLink: false })) }
  })
  for (const name of ['ui.toast', 'ui.status', 'ui.log', 'model.complete']) {
    on(name, () => {
      host.calls.push(name)
      return { value: undefined }
    })
  }
  on('ui.open', () => {
    host.calls.push('ui.open')
    return { value: { isOpen: true } }
  })
  on('session.id', () => ({ value: 'self' }))
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('tool.check', () => ({ decision: host.verdict }))
  // The engine's own run of a tool, which records the session's state as it runs.
  on('tool.call', async ($: any, e: any) => {
    host.inCall.push(JSON.parse(host.files[`${DIR}/self.json`] ?? '{}').state)
    return { result: {}, text: 'ok' }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('session.end', () => ({ sessionId: 'self' }))
  on('classic.UserPromptSubmit', () => ({}))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: 'no hook answered' }))
  on('ui.render', ($: any, e: any) => h($.ui.resolve(e).Box, { key: 'engine-band' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { host, clock }
}

const own = (host: Host) => JSON.parse(host.files[`${DIR}/self.json`]!)
const say = ($: any, args: string) => $.command.run({ command: 'session-monitor', args })

async function band($: any) {
  const ui = await $.ui.mount({ plugin: 'session-monitor', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  return {
    head: (await ui.find({ type: 'Text', text: /^other sessions/ }))?.text,
    waiting: (await ui.find({ type: 'Text', text: /waiting/ }))?.text,
    rest: (await ui.find({ type: 'Text', text: /(working|done) $/ }))?.text,
    here: (await ui.find({ type: 'Text', text: /^also here/ }))?.text,
  }
}

describe('the heartbeat', () => {
  test('one folder key for two spellings of a Windows path', () => {
    expect(folderKey('C:\\Work\\App\\')).toBe('c:/work/app')
    expect(folderKey('/home/me/App')).toBe('/home/me/App')
  })

  test("the title is the session's, else the folder's name, never longer than 60 characters", () => {
    expect(titleOf('Fix the  export\nbug', ROOT)).toBe('Fix the export bug')
    expect(titleOf(undefined, 'C:\\work\\app')).toBe('app')
    expect(titleOf('x'.repeat(80), ROOT)).toHaveLength(60)
  })

  test('reads only well-formed files; skips this session, ended ones and stale ones; waiting first', () => {
    expect(readBeat('{"v":1')).toBeUndefined()
    expect(readBeat('{"v":1,"id":"a","folder":"f","title":"t","state":"lost","since":1,"updatedAt":1}')).toBeUndefined()
    const list = ['self', 'a', 'b', 'c', 'd'].map((id, i) =>
      readBeat(beat(id, ROOT, ['working', 'done', 'ended', 'working', 'waiting'][i]!, id === 'c' ? NOW - STALE_MS - 1 : NOW - i)),
    )
    const live = liveOthers(list.filter(b => b !== undefined), 'self', NOW)
    expect(live.map(b => b.id)).toEqual(['d', 'a'])
    expect(counts(live)).toEqual({ waiting: 1, working: 0, done: 1 })
    expect(alsoHere(live, 'c:\\work\\APP').map(b => b.id)).toEqual(['d', 'a'])
    expect([ago(4_000), ago(125_000), ago(7_300_000)]).toEqual(['4s', '2m', '2h'])
  })
})

describe('session-monitor', () => {
  test('writes its own file at once and every 15 seconds', async ($, on) => {
    const { host, clock } = await start($, on)
    expect(own(host)).toEqual({ v: 1, id: 'self', folder: ROOT, title: 'app', state: 'done', since: NOW, updatedAt: NOW })
    await clock.advance(15_000)
    expect(own(host).updatedAt).toBe(NOW + 15_000)
  })

  test('the band counts the other open sessions, waiting first; also here names those in this folder', async ($, on) => {
    const { host, clock } = await start($, on)
    host.files[`${DIR}/b.json`] = beat('b', 'c:\\work\\app', 'working', NOW)
    host.files[`${DIR}/c.json`] = beat('c', 'C:/other', 'waiting', NOW)
    host.files[`${DIR}/d.json`] = beat('d', ROOT, 'ended', NOW)
    host.files[`${DIR}/e.json`] = beat('e', ROOT, 'done', NOW - STALE_MS - 1)
    for (const f of Object.keys(host.files)) host.mtimes[f] = NOW
    host.mtimes[`${DIR}/e.json`] = NOW - STALE_MS - 1
    await clock.advance(15_000)
    expect(await band($)).toEqual({ head: 'other sessions ▸ ', waiting: '1 waiting · ', rest: '1 working ', here: 'also here ▸ "task b" · working' })
    expect((await say($, 'status')).text).toBe('on (/session-monitor off turns it off) · 2 other sessions: 1 waiting · 1 working')
    // A session that stops writing drops out after 90 seconds.
    host.files[`${DIR}/b.json`] = beat('b', ROOT, 'working', NOW)
    host.files[`${DIR}/c.json`] = beat('c', 'C:/other', 'waiting', NOW + 15_000)
    host.mtimes[`${DIR}/c.json`] = NOW + 15_000
    await clock.advance(STALE_MS)
    expect((await say($, 'status')).text).toContain('1 other session: 1 waiting')
  })

  test('working from a turn start to its end; waiting while a dialog or a question is open', async ($, on) => {
    const { host } = await start($, on)
    await $.turn.start({ text: 'touch a file', turnId: 't1' })
    expect(own(host).state).toBe('working')
    // A question Claude asks: waiting while it is open, working again once it is answered.
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
    expect(host.inCall).toEqual(['waiting'])
    expect(own(host).state).toBe('working')
    // A check that asks the person opens a dialog: waiting. (Its own call's end closes it, checked live.)
    host.verdict = 'ask'
    expect(await $.tool.check({ tool: 'Bash', input: { command: 'touch probe.txt' }, tool_use_id: 'u1' } as any)).toEqual({ decision: 'ask' })
    expect(own(host).state).toBe('waiting')
    // Another call ending does not close that dialog; the end of the turn does.
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(own(host).state).toBe('waiting')
    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(own(host).state).toBe('done')
  })

  test("the session's title from Claude Code replaces the folder's name", async ($, on) => {
    const { host, clock } = await start($, on)
    await $.classic.UserPromptSubmit({ prompt: 'secret plan text', session_title: 'Export fix' })
    await clock.advance(15_000)
    expect(own(host).title).toBe('Export fix')
    expect(host.files[`${DIR}/self.json`]).not.toContain('secret plan text')
  })

  test('the end marks the file ended in one write and stops the timer', async ($, on) => {
    const { host, clock } = await start($, on)
    await $.session.end({ reason: 'prompt_input_exit' } as any)
    expect(own(host).state).toBe('ended')
    const writes = host.calls.filter(c => c === 'fs.write').length
    await clock.advance(60_000)
    expect(host.calls.filter(c => c === 'fs.write').length).toBe(writes)
  })

  test('/session-monitor list opens the list of sessions', async ($, on) => {
    const { host, clock } = await start($, on)
    host.files[`${DIR}/b.json`] = beat('b', ROOT, 'waiting', NOW)
    host.mtimes[`${DIR}/b.json`] = NOW
    await clock.advance(15_000)
    await say($, 'list')
    expect(host.calls).toContain('ui.open')
    const ui = await $.ui.mount({ plugin: 'session-monitor', surface: 'terminal', component: 'Pane', requestId: 'session-monitor', props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: /^app ·/ }))?.text).toBe('app · "task b" · waiting 45s · this folder')
  })

  test('the mod starts off; on starts the heartbeat, off marks the file ended and stops it', async ($, on) => {
    const { host, clock } = await start($, on, {})
    expect(host.calls).toEqual([])
    expect((await say($, 'on')).text).toBe('on (/session-monitor off turns it off)')
    expect(own(host).state).toBe('done')
    expect((await say($, 'off')).text).toBe('off (/session-monitor on turns it on)')
    expect(own(host).state).toBe('ended')
    const writes = host.calls.length
    await clock.advance(60_000)
    expect(host.calls.length).toBe(writes)
  })

  test('off, every hook passes its event on unchanged, and nothing is written, read or drawn', async ($, on) => {
    const { host, clock } = await start($, on, { enabled: false })
    host.verdict = 'ask'
    expect(await $.turn.start({ text: 'go', turnId: 't1' })).toEqual({ turnId: 't1' })
    expect(await $.tool.call({ tool: 'Bash', command: 'touch x' })).toEqual({ result: {}, text: 'ok' })
    expect(await $.tool.check({ tool: 'Bash', input: { command: 'touch x' } })).toEqual({ decision: 'ask' })
    expect(await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })).toEqual({ text: 'ok' })
    await $.classic.UserPromptSubmit({ prompt: 'x', session_title: 'Title' })
    expect(await $.session.end({ reason: 'other' } as any)).toEqual({ sessionId: 'self' })
    await clock.advance(60_000)
    expect((await band($)).head).toBeUndefined()
    expect(host.calls).toEqual([])
  })
})
