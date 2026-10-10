import { describe, expect, mock, test } from 'claude-code/testing'

import { MAX_DRAFT, buildPrompt, costLine, refusal, rewriteOf } from '../hooks/enhance'

const ROOT = 'C:/work/app'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const DRAFT = 'add a settings page where users change their email and password'
const REWRITE = 'Build a settings page for email and password changes.\n\nAsk first: verification of the new email?'
const USAGE = { input_tokens: 8498, output_tokens: 1408, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const COMMANDS = [
  { name: 'help', description: 'Show help', source: 'builtin' },
  { name: 'ak:cook', description: 'Implement a feature step by step', source: 'user' },
]
// secret-guard's placeholder, built from its characters so that no tool reads this file as holding one.
const MARKER = `${String.fromCharCode(0x2039)}hidden: SOME_KEY${String.fromCharCode(0x203a)}`

// The prompt box and the model beneath the plugin. reply: what the model answers, or a failure. typed: what the
// author types into the box while the model works. asked: the prompts the model was sent. calls: every $ call
// that reads the box, fills or submits it, or calls the model, by event name.
type Host = {
  box: string
  reply: { isAnswered: true; text: string; usage: typeof USAGE } | { isAnswered: false; reason: string; status?: number | null }
  typed: string | null
  asked: string[]
  submitted: { text: string; asUser?: boolean }[]
  calls: string[]
}

// stored: what the plugin's store holds as the session starts ({ enabled: true } is an earlier /prompt-enhancer on).
async function start($: any, on: any, stored: Record<string, unknown> = { enabled: true }) {
  const host: Host = { box: '', reply: { isAnswered: true, text: REWRITE, usage: USAGE }, typed: null, asked: [], submitted: [], calls: [] }
  mock.clock(on, { now: 1_000 })
  mock.store(on, stored)
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('command.list', () => {
    host.calls.push('command.list')
    return { value: COMMANDS }
  })
  on('fs.read', ($: any, e: any) => {
    host.calls.push('fs.read')
    const lines = Array.from({ length: 50 }, (_, i) => `rule ${i + 1}`)
    return { value: e.path.split('\\').join('/') === `${ROOT}/CLAUDE.md` ? lines.join('\n') : '' }
  })
  on('model.complete', ($: any, e: any) => {
    host.calls.push('model.complete')
    host.asked.push(e.prompt)
    if (host.typed !== null) host.box = host.typed
    return { value: host.reply }
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
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: 'no hook answered' }))
  on('ui.render', ($: any, e: any) => h($.ui.resolve(e).Box, { key: 'engine-band' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  return host
}

const say = ($: any, args: string) => $.command.run({ command: 'prompt-enhancer', args })
const band = ($: any): Promise<any> => $.ui.mount({ plugin: 'prompt-enhancer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
const noteOf = async (ui: any) => (await ui.find({ type: 'Text', text: /^ / }))?.text?.trim()

describe('the draft and the ask', () => {
  test('an empty draft, a long one, or one holding a secret is not sent', () => {
    expect(refusal('  ')).toBe('nothing to enhance: type a draft first')
    expect(refusal('x'.repeat(MAX_DRAFT + 1))).toBe(`too long to enhance: ${MAX_DRAFT + 1} characters, at most ${MAX_DRAFT}`)
    expect(refusal(`use the key ${MARKER} here`)).toContain('secret')
    expect(refusal(`call it with AKIA${'ABCDEFGHIJKLMNOP'}`)).toContain('secret')
    expect(refusal(DRAFT)).toBeUndefined()
  })

  test("the ask holds the draft, the session's own skills and commands, and the first 40 lines of CLAUDE.md", () => {
    const md = Array.from({ length: 50 }, (_, i) => `rule ${i + 1}`).join('\n')
    const ask = buildPrompt(DRAFT, COMMANDS, md)
    expect(ask).toContain(`<draft>\n${DRAFT}\n</draft>`)
    expect(ask).toContain('/ak:cook: Implement a feature step by step')
    expect(ask).not.toContain('/help')
    expect(ask).toContain('rule 40\n</project-instructions>')
    expect(ask).not.toContain('rule 41')
  })

  test('the rewrite comes out of a code fence; the cost is shown in tokens', () => {
    expect(rewriteOf('```markdown\nDo the thing.\n```')).toBe('Do the thing.')
    expect(rewriteOf('  Do it.  ')).toBe('Do it.')
    expect(costLine(USAGE)).toBe('8,498 in · 1,408 out tokens (haiku)')
  })
})

describe('prompt-enhancer', () => {
  test('Enhance replaces the draft with the rewrite and submits nothing; the band shows the tokens', async ($, on) => {
    const host = await start($, on)
    host.box = DRAFT
    const ui = await band($)
    await ui.press({ key: 'enhance' })
    expect(host.box).toBe(REWRITE)
    expect(host.submitted).toEqual([])
    expect(host.asked[0]).toContain(DRAFT)
    expect(await noteOf(ui)).toBe('rewritten · 8,498 in · 1,408 out tokens (haiku). Edit it, then Send or Enter')
    expect((await say($, 'status')).text).toBe('on (/prompt-enhancer off turns it off) · last rewrite: 8,498 in · 1,408 out tokens (haiku)')
  })

  test('Send submits the draft as the author typed it and empties the box', async ($, on) => {
    const host = await start($, on)
    host.box = REWRITE
    await (await band($)).press({ key: 'send' })
    expect(host.submitted).toEqual([{ text: REWRITE, asUser: true }])
    expect(host.box).toBe('')
  })

  test('an empty draft or one with a secret: no model call, and the band says why', async ($, on) => {
    const host = await start($, on)
    const ui = await band($)
    await ui.press({ key: 'enhance' })
    expect(await noteOf(ui)).toBe('nothing to enhance: type a draft first')
    host.box = `deploy with ${MARKER}`
    await ui.press({ key: 'enhance' })
    expect(await noteOf(ui)).toBe('not sent: the draft holds a secret or a hidden-value marker')
    expect(host.calls).not.toContain('model.complete')
  })

  test('no answer in time: the draft stays and the band says so', async ($, on) => {
    const host = await start($, on)
    host.box = DRAFT
    host.reply = { isAnswered: false, reason: 'aborted' }
    const ui = await band($)
    await ui.press({ key: 'enhance' })
    expect(host.box).toBe(DRAFT)
    expect(await noteOf(ui)).toBe('no answer within 20 s; the draft is unchanged')
  })

  test('a draft edited while Haiku works is kept', async ($, on) => {
    const host = await start($, on)
    host.box = DRAFT
    host.typed = `${DRAFT}, and dark mode`
    const ui = await band($)
    await ui.press({ key: 'enhance' })
    expect(host.box).toBe(`${DRAFT}, and dark mode`)
    expect(await noteOf(ui)).toContain('the draft changed while Haiku worked')
  })

  test('the mod starts off; /prompt-enhancer on turns it on, off again hides the band', async ($, on) => {
    await start($, on, {})
    expect(await band($).then(ui => ui.find({ key: 'enhance' }))).toBeUndefined()
    expect((await say($, 'on')).text).toBe('on (/prompt-enhancer off turns it off)')
    expect(await band($).then(ui => ui.find({ key: 'enhance' }))).toBeDefined()
    expect((await say($, 'status')).text).toBe('on (/prompt-enhancer off turns it off) · no rewrite yet this session')
    expect((await say($, 'off')).text).toBe('off (/prompt-enhancer on turns it on)')
    expect(await band($).then(ui => ui.find({ key: 'enhance' }))).toBeUndefined()
  })

  test('off, the band passes through and nothing reads the draft or calls the model', async ($, on) => {
    const host = await start($, on, { enabled: false })
    host.box = DRAFT
    const ui = await band($)
    expect(await ui.find({ key: 'enhance' })).toBeUndefined()
    expect(await ui.find({ key: 'engine-band' })).toBeDefined()
    expect((await say($, '')).text).toBe('off (/prompt-enhancer on turns it on)')
    expect(host.calls).toEqual([])
  })
})
