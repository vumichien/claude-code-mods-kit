import { describe, expect, mock, test } from 'claude-code/testing'

import { KEPT_ARGS, MAX_CHARS, MAX_IDEAS, addIdea, editIdea, hideIdea, preview, readShelf, removeIdea, sentIn, shelfKey } from '../hooks/shelf'

const ROOT = 'C:/work/app'
const NOW = 1_000_000
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const PANE_PROPS = { title: 'Idea shelf', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }

// What the host beneath the plugin holds: the session's folder, the prompt box, and what the plugin did there.
// calls: every $ call that writes, draws, fills or submits, by event name.
type Host = { root: string; box: string; filled: string[]; submitted: string[]; calls: string[] }

// Every stub sits beneath the plugin and is registered before the first $ call.
// stored: what the plugin's store holds as the session starts ({ enabled: true } is an earlier /idea-shelf on).
async function start($: any, on: any, stored: Record<string, unknown> = { enabled: true }, root = ROOT) {
  const host: Host = { root, box: '', filled: [], submitted: [], calls: [] }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  for (const name of ['fs.write', 'ui.toast', 'ui.status', 'ui.log', 'model.complete']) {
    on(name, () => {
      host.calls.push(name)
      return { value: undefined }
    })
  }
  on('session.root', () => ({ value: host.root }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    host.calls.push('ui.open')
    return { value: { isOpen: true } }
  })
  on('prompt.read', () => ({ value: { text: host.box, cursor: host.box.length } }))
  on('prompt.fill', ($: any, e: any) => {
    host.calls.push('prompt.fill')
    host.filled.push(e.text)
    host.box = e.text
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.submit', ($: any, e: any) => {
    host.calls.push('prompt.submit')
    host.submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: 'no hook answered' }))
  on('ui.render', ($: any, e: any) => h($.ui.resolve(e).Box, { key: 'engine-band' }))
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { host, clock }
}

const idea = ($: any, args: string) => $.command.run({ command: 'idea', args })
const shelf = ($: any, args: string) => $.command.run({ command: 'idea-shelf', args })

async function bandText($: any) {
  const ui = await $.ui.mount({ plugin: 'idea-shelf', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  return (await ui.find({ type: 'Text', text: /^ideas/ }))?.text
}

const pane = ($: any, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'idea-shelf', surface, component: 'Pane', requestId: 'idea-shelf', props: PANE_PROPS })

describe('the shelf', () => {
  test('one key per project; a Windows path ignores case and separators', () => {
    expect(shelfKey('C:\\Work\\App\\')).toBe('shelf:c:/work/app')
    expect(shelfKey('c:/work/app')).toBe('shelf:c:/work/app')
    expect(shelfKey('/home/me/App')).toBe('shelf:/home/me/App')
  })

  test('parks trimmed text; refuses empty, too long and a full shelf', () => {
    const one = addIdea([], '  try a cache  ', 5)
    expect(one).toEqual({ ideas: [{ id: '5-0', text: 'try a cache', at: 5 }], said: 'parked (1 on the shelf)' })
    expect(addIdea([], '   ', 5)).toEqual({ error: 'nothing to park: type the idea after /idea, or in the shelf' })
    expect('error' in addIdea([], 'x'.repeat(MAX_CHARS + 1), 5)).toBe(true)
    const full = Array.from({ length: MAX_IDEAS }, (_, i) => ({ id: `i${i}`, text: `idea ${i}`, at: i }))
    expect(addIdea(full, 'one more', 5)).toEqual({ error: `the shelf holds ${MAX_IDEAS} ideas; send or delete one first` })
  })

  test('edit, delete, and an edit to nothing deletes', () => {
    const list = [{ id: 'a', text: 'first', at: 1 }, { id: 'b', text: 'second', at: 2 }]
    expect(editIdea(list, 'a', ' changed ')).toEqual({ ideas: [{ id: 'a', text: 'changed', at: 1 }, list[1]], said: 'idea changed' })
    expect(removeIdea(list, 'b')).toEqual({ ideas: [list[0]], said: 'deleted (1 on the shelf)' })
    expect(editIdea(list, 'b', '  ')).toEqual({ ideas: [list[0]], said: 'deleted (1 on the shelf)' })
  })

  test('a submitted prompt takes off only the ideas Send handed it', () => {
    const list = [{ id: 'a', text: 'add retries', at: 1 }, { id: 'b', text: 'x', at: 2 }]
    expect(sentIn(list, new Set(['a']), 'please add retries to the client')).toEqual(['a'])
    expect(sentIn(list, new Set(['a']), 'something else')).toEqual([])
    expect(sentIn(list, new Set(), 'x marks it')).toEqual([])
  })

  test("the /idea row keeps a stand-in for the idea; other commands' rows and /idea alone stay as typed", () => {
    const row = (name: string, args: string) => `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`
    expect(hideIdea(row('idea', 'try the bulk endpoint\nlater'))).toBe(row('idea', KEPT_ARGS))
    expect(hideIdea(row('idea-shelf:idea', 'rename the flag'))).toBe(row('idea-shelf:idea', KEPT_ARGS))
    expect(hideIdea(row('idea', ''))).toBe(row('idea', ''))
    expect(hideIdea(row('idea', ' List '))).toBe(row('idea', ' List '))
    expect(hideIdea(row('idea-shelf', 'on'))).toBe(row('idea-shelf', 'on'))
    expect(hideIdea(row('plan', 'try the bulk endpoint'))).toBe(row('plan', 'try the bulk endpoint'))
  })

  test('reads only well-formed ideas from the store; previews the first line', () => {
    expect(readShelf(undefined)).toEqual([])
    expect(readShelf([{ id: 'a', text: 't', at: 1 }, { id: 2 }, null])).toEqual([{ id: 'a', text: 't', at: 1 }])
    expect(preview('a long idea about caching', 10)).toBe('a long id…')
    expect(preview('two\nlines', 20)).toBe('two …')
  })
})

describe('idea-shelf', () => {
  test('/idea parks an idea per project and says so without repeating it; the shelf outlives the session', async ($, on) => {
    const { host, clock } = await start($, on)
    const reply = await idea($, 'try the bulk endpoint later')
    expect(reply.text).toBe('parked (1 on the shelf)')
    expect(reply.text).not.toContain('bulk')
    await idea($, 'rename the export flag')
    expect(await bandText($)).toBe('ideas ▸ 2 ideas parked ')
    // A new session in the same folder finds both; one in another folder finds none.
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect((await shelf($, 'status')).text).toBe("on (/idea-shelf off turns it off) · 2 ideas on this project's shelf")
    host.root = 'C:/work/other'
    await $.session.start({ cwd: host.root, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(await bandText($)).toBeUndefined()
    expect((await shelf($, '')).text).toContain("0 ideas on this project's shelf")
  })

  test('/idea parks while a turn runs, and the turn goes on untouched', async ($, on) => {
    const { host } = await start($, on)
    expect(await $.turn.start({ text: 'build the export', turnId: 't1' })).toEqual({ turnId: 't1' })
    await idea($, 'check the CSV quoting')
    expect(await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })).toEqual({ text: 'done' })
    expect(host.submitted).toEqual([])
    expect(await bandText($)).toBe('ideas ▸ 1 idea parked ')
  })

  test('Send: an empty box and an idle session submit the idea; otherwise it waits in the box', async ($, on) => {
    const { host } = await start($, on)
    await idea($, 'add retries to the client')
    await idea($, 'write the changelog')
    const ui = await pane($)
    expect((await ui.find({ type: 'Text', text: /^Idea shelf/ }))?.text).toBe('Idea shelf · 2 ideas for this project')
    await ui.press({ key: `send-${NOW}-0` })
    expect(host.submitted).toEqual(['add retries to the client'])
    // A draft in the box: the idea goes after it and nothing is submitted until the author does.
    host.box = 'first, fix the build'
    await ui.press({ key: `send-${NOW}-1` })
    expect(host.filled).toEqual(['first, fix the build\nwrite the changelog'])
    expect(host.submitted).toEqual(['add retries to the client'])
    expect(await bandText($)).toBe('ideas ▸ 1 idea parked ')
    // The author submits the box: the idea it carries leaves the shelf.
    await ($ as any).prompt.submit({ text: host.box })
    expect(await bandText($)).toBeUndefined()
  })

  test('Send while Claude works fills the box and submits nothing', async ($, on) => {
    const { host } = await start($, on)
    await idea($, 'try a smaller batch')
    await $.turn.start({ text: 'run the job', turnId: 't1' })
    await (await pane($)).press({ key: `send-${NOW}-0` })
    expect(host.filled).toEqual(['try a smaller batch'])
    expect(host.submitted).toEqual([])
  })

  test('Edit and Delete in the shelf', async ($, on) => {
    await start($, on)
    await idea($, 'first idea')
    await idea($, 'second idea')
    const ui = await pane($)
    await ui.press({ key: `edit-${NOW}-0` })
    await ui.input({ key: `text-${NOW}-0`, text: 'first idea, sharper' })
    expect((await ui.find({ type: 'Text', text: /sharper/ }))?.text).toContain('first idea, sharper')
    await ui.press({ key: `delete-${NOW}-1` })
    expect((await ui.find({ type: 'Text', text: /^Idea shelf/ }))?.text).toBe('Idea shelf · 1 idea for this project')
  })

  test('the box at the top of the shelf parks an idea', async ($, on) => {
    await start($, on)
    const ui = await pane($)
    await ui.input({ key: 'new', text: 'typed in the shelf' })
    expect((await ui.find({ type: 'Text', text: /^Idea shelf/ }))?.text).toBe('Idea shelf · 1 idea for this project')
  })

  test('the mod starts off; /idea-shelf on turns it on, off again stops it', async ($, on) => {
    await start($, on, {})
    expect((await idea($, 'not parked')).text).toBe('off (/idea-shelf on turns it on)')
    expect((await shelf($, 'on')).text).toBe('on (/idea-shelf off turns it off)')
    expect((await idea($, 'parked now')).text).toBe('parked (1 on the shelf)')
    expect((await shelf($, 'off')).text).toBe('off (/idea-shelf on turns it on)')
    expect(await bandText($)).toBeUndefined()
  })

  test('off, every hook passes its event on unchanged, and nothing is written, drawn or sent', async ($, on) => {
    const { host } = await start($, on, { enabled: false, 'shelf:c:/work/app': [{ id: 'a', text: 'kept', at: 1 }] })
    expect(await $.turn.start({ text: 'go', turnId: 't1' })).toEqual({ turnId: 't1' })
    expect(await ($ as any).prompt.submit({ text: 'kept' })).toEqual({ text: 'kept' })
    expect(await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })).toEqual({ text: 'ok' })
    expect(await bandText($)).toBeUndefined()
    expect((await idea($, '')).text).toBe('off (/idea-shelf on turns it on)')
    // The prompt.submit above is the test's own call: the mod made none, and filled, opened or wrote nothing.
    expect(host.calls).toEqual(['prompt.submit'])
    expect(host.filled).toEqual([])
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the shelf draws on ${surface}`, async ($, on) => {
      await start($, on)
      await idea($, 'an idea for later')
      const ui = await pane($, surface)
      expect((await ui.find({ type: 'Text', text: /an idea for later/ }))?.text).toContain('an idea for later')
    })
  }
})
