import { describe, expect, mock, test } from 'claude-code/testing'

import { correctionPrompt, costLine, lastTurn, parseAssumptions } from '../hooks/assume'

const ROOT = 'C:/work/app'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const PANE_PROPS = { title: 'Assumptions', isFocused: true, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const USAGE = { input_tokens: 1314, output_tokens: 1274, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const FOUND = JSON.stringify([
  { claim: 'Numeric dates are read day first', where: 'dates.py', why: 'common outside the US' },
  { claim: 'Datetimes carry no time zone', where: 'dates.py', why: 'simplest' },
])
const MESSAGES = [
  { role: 'user', text: 'an older prompt', toolUses: [] },
  { role: 'assistant', text: 'older answer', toolUses: [] },
  { role: 'user', text: 'Add parse_date(text) to dates.py', toolUses: [] },
  { role: 'assistant', text: 'Done.', toolUses: [{ tool: 'Write', input: { file_path: 'dates.py', content: 'def parse_date(text): ...' } }] },
]

// The session beneath the plugin. replies: what the model answers, in order. box: the prompt box.
// calls: every $ call that calls the model, reads, fills or submits the box, by event name.
type Host = { replies: string[]; asked: string[]; box: string; submitted: { text: string; asUser?: boolean }[]; calls: string[] }

// stored: what the plugin's store holds as the session starts ({ enabled: true } is an earlier /assumption-check on).
async function start($: any, on: any, stored: Record<string, unknown> = { enabled: true }) {
  const host: Host = { replies: [FOUND], asked: [], box: '', submitted: [], calls: [] }
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on, stored)
  on('session.root', () => ({ value: ROOT }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('model.complete', ($: any, e: any) => {
    host.calls.push('model.complete')
    host.asked.push(e.prompt)
    return { value: { isAnswered: true, text: host.replies.shift() ?? '[]', usage: USAGE } }
  })
  on('prompt.read', () => {
    host.calls.push('prompt.read')
    return { value: { text: host.box, cursor: host.box.length } }
  })
  on('prompt.fill', ($: any, e: any) => {
    host.calls.push('prompt.fill')
    host.box = e.text
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.submit', ($: any, e: any) => {
    host.calls.push('prompt.submit')
    host.submitted.push({ text: e.text, ...(e.origin?.asUser ? { asUser: true } : {}) })
    return { text: e.text }
  })
  for (const name of ['fs.write', 'ui.toast', 'ui.status', 'ui.log']) {
    on(name, () => {
      host.calls.push(name)
      return { value: undefined }
    })
  }
  on('ui.open', () => {
    host.calls.push('ui.open')
    return { value: { isOpen: true } }
  })
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: 'no hook answered' }))
  on('ui.render', ($: any, e: any) => h($.ui.resolve(e).Box, { key: 'engine-band' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  return { host, clock }
}

// One turn of the main loop that calls the given tools, then ends.
async function turn($: any, clock: any, tools: string[], isAborted = false) {
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (const tool of tools) {
    await $.tool.call(tool === 'Bash' ? { tool, command: 'python dates.py' } : tool === 'Read' ? { tool, file_path: 'dates.py' } : { tool, file_path: 'dates.py', content: 'x' })
  }
  const done = await $.turn.complete({ answer: 'done', durationMs: 10, isAborted, turnId: 't1', reason: 'answer' })
  await clock.settle()
  return done
}

const say = ($: any, args: string) => $.command.run({ command: 'assumption-check', args })
const bandText = async ($: any) =>
  (await (await $.ui.mount({ plugin: 'assumption-check', surface: 'terminal', component: 'AbovePrompt', props: BAND })).find({ type: 'Text', text: /^assumptions/ }))?.text
const review = ($: any) => $.ui.mount({ plugin: 'assumption-check', surface: 'terminal', component: 'Pane', requestId: 'assumption-check', props: PANE_PROPS })

describe('the check', () => {
  test("the last turn is read from the author's last prompt on, each tool call's input cut short", () => {
    const text = lastTurn([...MESSAGES.slice(0, 3), { role: 'assistant', text: '', toolUses: [{ tool: 'Write', input: { content: 'x'.repeat(5000) } }] }])
    expect(text.startsWith('USER: Add parse_date(text) to dates.py')).toBe(true)
    expect(text).not.toContain('older')
    expect(text.length).toBeLessThan(1700)
  })

  test("Haiku's answer is read through prose and fences; anything else is not a list", () => {
    expect(parseAssumptions(`Here you go:\n\`\`\`json\n${FOUND}\n\`\`\``)).toHaveLength(2)
    expect(parseAssumptions('[{"claim": "a"}, {"where": "no claim"}]')).toEqual([{ claim: 'a', where: '', why: '' }])
    expect(parseAssumptions(JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ claim: `c${i}` }))))).toHaveLength(8)
    expect(parseAssumptions('I could not find any.')).toBeUndefined()
    expect(parseAssumptions('[{"claim": ')).toBeUndefined()
  })

  test('the corrections name the wrong ones with their notes and keep the right ones', () => {
    const base = { where: 'dates.py', why: '' }
    const prompt = correctionPrompt([
      { ...base, claim: 'Day first', mark: 'wrong', note: 'our users are in the US: month first' },
      { ...base, claim: 'No time zone', mark: 'right', note: '' },
      { ...base, claim: 'Nine formats', mark: null, note: '' },
    ])
    expect(prompt).toBe(
      'Some choices in your last turn were wrong. Change only these:\n1. You assumed: Day first (dates.py). That is wrong: our users are in the US: month first\n\nThese were right; keep them as they are:\n1. No time zone (dates.py)\n\nLeave everything else unchanged.',
    )
    expect(correctionPrompt([{ ...base, claim: 'Day first', mark: 'wrong', note: ' ' }])).toContain('1. You assumed: Day first (dates.py). That is wrong.')
    expect(correctionPrompt([{ ...base, claim: 'x', mark: 'right', note: '' }])).toBeUndefined()
    expect(costLine(USAGE, 2)).toBe('1,314 in · 1,274 out tokens (haiku, 2 calls)')
  })
})

describe('assumption-check', () => {
  test('a turn that wrote a file is checked once, after it ended; the band counts what to check', async ($, on) => {
    const { host, clock } = await start($, on)
    expect(await turn($, clock, ['Write', 'Bash'])).toEqual({ text: 'done' })
    expect(host.calls.filter(c => c === 'model.complete')).toHaveLength(1)
    expect(host.asked[0]).toContain('[Write]')
    expect(await bandText($)).toBe('assumptions ▸ 2 to check ')
    expect((await say($, 'status')).text).toBe('on (/assumption-check off turns it off) · 2 to check · last check: 1,314 in · 1,274 out tokens (haiku)')
  })

  test('a turn that only read, or was interrupted, is not checked', async ($, on) => {
    const { host, clock } = await start($, on)
    await turn($, clock, ['Read'])
    await turn($, clock, ['Write'], true)
    expect(host.calls).not.toContain('model.complete')
    expect(await bandText($)).toBeUndefined()
  })

  test('an answer that is not JSON gets one retry; two such answers leave a note', async ($, on) => {
    const { host, clock } = await start($, on)
    host.replies = ['Sure! Here are some thoughts.', FOUND]
    await turn($, clock, ['Edit'])
    expect(host.calls.filter(c => c === 'model.complete')).toHaveLength(2)
    expect(await bandText($)).toBe('assumptions ▸ 2 to check ')
    host.replies = ['no', 'still no']
    await turn($, clock, ['Edit'])
    expect(host.calls.filter(c => c === 'model.complete')).toHaveLength(4)
    expect(await bandText($)).toBe("assumptions ▸ could not read Haiku's answer as a list ")
  })

  test('Wrong with a note, then Send corrections: the prompt goes into the box; Send submits it once Claude is idle', async ($, on) => {
    const { host, clock } = await start($, on)
    await turn($, clock, ['Write'])
    const ui = await review($)
    await ui.press({ key: 'wrong-1-0' })
    await ui.input({ key: 'note-1-0', text: 'month first' })
    await ui.press({ key: 'right-1-1' })
    await ui.press({ key: 'send' })
    expect(host.box).toContain('1. You assumed: Numeric dates are read day first (dates.py). That is wrong: month first')
    expect(host.submitted).toEqual([])
    // While a turn runs, Send only says so.
    await $.turn.start({ text: 'other work', turnId: 't2' })
    await ui.press({ key: 'send' })
    expect(host.submitted).toEqual([])
    expect((await ui.find({ type: 'Text', text: /Claude is working/ }))?.text).toBeDefined()
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    await ui.press({ key: 'send' })
    expect(host.submitted).toHaveLength(1)
    expect(host.submitted[0]!.asUser).toBe(true)
    expect(host.submitted[0]!.text).toContain('keep them as they are:\n1. Datetimes carry no time zone')
  })

  test("a new list gets new note boxes, so no note from the previous list stays on screen", async ($, on) => {
    const { host, clock } = await start($, on)
    await turn($, clock, ['Write'])
    const ui = await review($)
    expect(await ui.find({ key: 'note-1-0' })).toBeDefined()
    host.replies = [FOUND]
    await turn($, clock, ['Edit'])
    expect(await ui.find({ key: 'note-1-0' })).toBeUndefined()
    expect(await ui.find({ key: 'note-2-0' })).toBeDefined()
  })

  test('Send corrections with nothing marked wrong says so and fills nothing', async ($, on) => {
    const { host, clock } = await start($, on)
    await turn($, clock, ['Write'])
    const ui = await review($)
    await ui.press({ key: 'send' })
    expect(host.calls).not.toContain('prompt.fill')
    expect((await ui.find({ type: 'Text', text: /mark at least one/ }))?.text?.trim()).toBe('mark at least one assumption Wrong first')
  })

  test('the mod starts off; /assumption-check on turns it on, off again stops the checks', async ($, on) => {
    const { host, clock } = await start($, on, {})
    expect((await say($, 'on')).text).toBe('on (/assumption-check off turns it off)')
    await turn($, clock, ['Write'])
    expect(host.calls.filter(c => c === 'model.complete')).toHaveLength(1)
    expect((await say($, 'off')).text).toBe('off (/assumption-check on turns it on)')
    await turn($, clock, ['Write'])
    expect(host.calls.filter(c => c === 'model.complete')).toHaveLength(1)
    expect(await bandText($)).toBeUndefined()
  })

  test('off, every hook passes its event on unchanged, and nothing is read, drawn or sent to the model', async ($, on) => {
    const { host, clock } = await start($, on, { enabled: false })
    expect(await $.turn.start({ text: 'go', turnId: 't1' })).toEqual({ turnId: 't1' })
    expect(await $.tool.call({ tool: 'Write', file_path: 'dates.py', content: 'x' })).toEqual({ result: {}, text: 'ok' })
    expect(await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })).toEqual({ text: 'done' })
    await clock.advance(60_000)
    expect(await bandText($)).toBeUndefined()
    expect(host.calls).toEqual([])
  })
})
