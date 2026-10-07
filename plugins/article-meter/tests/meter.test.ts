import { describe, expect, test } from 'claude-code/testing'

import { measureDraft, newestMatch, relativeTo, samePath, splitPattern } from '../hooks/meter'

// Runs a slash command as the person would; the test host fills in origin and presentation.
const runCommand = ($: any, command: string, args = '') => $.command.run({ command, args })

// A tiny synthetic project: two drafts in docs/, the newer one measured by default.
const ROOT = 'C:/work/blog'
const DRAFT_PATH = `${ROOT}/docs/demo-draft.md`
const OLD_PATH = `${ROOT}/docs/older-draft.md`
const DRAFT = [
  '<!-- punch-list: ⟨R:one⟩ ⟨R:two⟩ TODO -->',
  '# Title',
  '## 1. Intro',
  'one two three four',
  '## 2. History',
  'five six TODO',
  '## 3. The idea',
  'a b c d e f g h i j ⟨R:speed⟩',
  '| a | table | row |',
  '![figure](x.png)',
  '```',
  'code words do not count',
  '```',
  '### A subsection heading',
  '## 4. Experiments',
  'k l',
  '## References and resources',
  'not counted at all',
].join('\n')

type World = { files: Record<string, string>; mtimes: Record<string, number> }

const world = (): World => ({
  files: { [DRAFT_PATH]: DRAFT, [OLD_PATH]: '## 1. Old\nold words\n', [`${ROOT}/docs/notes.md`]: 'notes' },
  mtimes: { [DRAFT_PATH]: 2000, [OLD_PATH]: 1000, [`${ROOT}/docs/notes.md`]: 3000 },
})

// Every stub sits beneath the plugin and is registered before the first $ call.
async function start($: any, on: any, w: World) {
  const norm = (p: string) => p.replace(/\\/g, '/')
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('fs.read', ($: any, e: any) => {
    const path = norm(e.path)
    if (!(path in w.files)) throw new Error(`ENOENT ${path}`)
    return { value: w.files[path] }
  })
  on('fs.list', ($: any, e: any) => {
    const dir = norm(e.path ?? ROOT)
    const names = Object.keys(w.files).filter(f => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/'))
    return { value: names.map(f => ({ name: f.slice(dir.length + 1), kind: 'file', size: w.files[f]!.length, mtimeMs: w.mtimes[f] ?? 0, isLink: false })) }
  })
  on('ui.open', () => ({ value: { isOpen: true } }))
  on('tool.call', () => ({ result: { filePath: DRAFT_PATH, oldString: 'a', newString: 'b' }, text: 'ok' }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: 'no hook answered' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

const PANE = {
  title: 'Draft',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

const mountPane = ($: any, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'article-meter', surface, component: 'Pane', props: PANE, requestId: 'article-meter' })

describe('helpers', () => {
  test('a longer fence holds a shorter one shown as text', () => {
    const m = measureDraft(['## 3. Idea', 'one two', '````markdown', '```', '## 4. Not a part', 'inside', '```', '````', 'three'].join('\n'), [], 3)
    expect(m.parts).toEqual([{ part: 3, words: 3 }])
  })

  test('paths match through separators, case and dot segments', () => {
    expect(samePath('C:\\WORK\\blog\\docs\\..\\docs\\.\\demo-draft.md', 'c:/work/blog/docs/demo-draft.md')).toBe(true)
    expect(samePath('C:/work/blog/docs/other.md', 'C:/work/blog/docs/demo-draft.md')).toBe(false)
  })

  test('a path with dot segments is shown relative to the project', () => {
    expect(relativeTo(ROOT, 'C:/work/./blog/docs/../docs/demo-draft.md')).toBe('docs/demo-draft.md')
  })

  test('a table without leading pipes is not counted', () => {
    const m = measureDraft(['## 3. Idea', 'one two', 'Name | Value', '--- | ---', 'alpha | beta', '', 'three'].join('\n'), [], 3)
    expect(m.parts).toEqual([{ part: 3, words: 3 }])
  })

  test('a pattern picks the newest matching file', () => {
    const { dir, name } = splitPattern(ROOT, 'docs/*-draft.md')
    expect(dir).toBe('C:/work/blog/docs')
    const entries = [
      { name: 'a-draft.md', kind: 'file', mtimeMs: 1 },
      { name: 'b-draft.md', kind: 'file', mtimeMs: 5 },
      { name: 'notes.md', kind: 'file', mtimeMs: 9 },
      { name: 'c-draft.md', kind: 'dir', mtimeMs: 9 },
    ]
    expect(newestMatch(entries, name)).toBe('b-draft.md')
  })

  test('counts markers, and words per part outside comments, fences, tables and images', () => {
    const m = measureDraft(DRAFT, ['⟨', 'TODO'], 3)
    expect(m.markers).toEqual([{ marker: '⟨', count: 1 }, { marker: 'TODO', count: 1 }])
    expect(m.parts).toEqual([
      { part: 1, words: 4 },
      { part: 2, words: 3 },
      { part: 3, words: 11 },
      { part: 4, words: 2 },
    ])
    expect(m.focusShare).toBe(11 / 20)
  })
})

describe('article-meter', () => {
  test('/article measures the newest draft and replies with one line', async ($, on) => {
    await start($, on, world())
    const reply = await runCommand($, 'article')
    expect(reply.text).toBe('docs/demo-draft.md · 20 words in 4 numbered parts · part 3 55% (needs 50%) · left: ⟨ 1 · TODO 1')
  })

  test('/article <path> measures that file for the rest of the session', async ($, on) => {
    await start($, on, world())
    const reply = await runCommand($, 'article', 'docs/older-draft.md')
    expect(reply.text).toBe('docs/older-draft.md · 2 words in 1 numbered parts · part 3 0% (needs 50%) · left: ⟨ 0 · TODO 0')
    expect((await runCommand($, 'article')).text).toContain('docs/older-draft.md')
  })

  test('options change the markers and the focus part', { options: { markers: 'RUN THIS YOURSELF', focusPart: 0 } }, async ($, on) => {
    await start($, on, world())
    const reply = await runCommand($, 'article')
    expect(reply.text).toBe('docs/demo-draft.md · 20 words in 4 numbered parts · left: RUN THIS YOURSELF 0')
  })

  test('with no draft it says how to name one', async ($, on) => {
    await start($, on, { files: {}, mtimes: {} })
    const reply = await runCommand($, 'article')
    expect(reply.text).toBe('no draft matches docs/*-draft.md; name one with /article <path>')
  })

  test('recomputes after an Edit of the draft', async ($, on) => {
    const w = world()
    await start($, on, w)
    w.files[DRAFT_PATH] = DRAFT.replace('⟨R:speed⟩', '42 ms')
    await $.tool.call({ tool: 'Edit', file_path: DRAFT_PATH.replace(/\//g, '\\'), old_string: '⟨R:speed⟩', new_string: '42 ms' })
    const ui = await mountPane($)
    expect((await ui.find({ type: 'Text', text: /^Left/ }))?.text).toBe('Left: ⟨ 0 · TODO 1')
  })

  test('a newly written draft becomes the one measured', async ($, on) => {
    const w = world()
    await start($, on, w)
    w.files[`${ROOT}/docs/newer-draft.md`] = '## 1. New\nfresh\n'
    w.mtimes[`${ROOT}/docs/newer-draft.md`] = 5000
    await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/newer-draft.md`, content: '## 1. New\nfresh\n' })
    const ui = await mountPane($)
    expect((await ui.find({ type: 'Text', text: /\.md$/ }))?.text).toBe('docs/newer-draft.md')
  })

  test('an Edit that names the draft relative to the project recomputes', async ($, on) => {
    const w = world()
    await start($, on, w)
    w.files[DRAFT_PATH] = DRAFT.replace('⟨R:speed⟩', '42 ms')
    await $.tool.call({ tool: 'Edit', file_path: 'docs/demo-draft.md', old_string: '⟨R:speed⟩', new_string: '42 ms' })
    const ui = await mountPane($)
    expect((await ui.find({ type: 'Text', text: /^Left/ }))?.text).toBe('Left: ⟨ 0 · TODO 1')
  })

  test('a draft named before it exists is measured once Claude writes it', async ($, on) => {
    const w = world()
    await start($, on, w)
    expect((await runCommand($, 'article', 'docs/new.md')).text).toContain('could not read docs/new.md')
    w.files[`${ROOT}/docs/new.md`] = '## 1. New\nfresh words here\n'
    await $.tool.call({ tool: 'Write', file_path: 'docs/new.md', content: '## 1. New\nfresh words here\n' })
    const ui = await mountPane($)
    expect((await ui.find({ type: 'Text', text: /^Words/ }))?.text).toBe('Words: 3 in 1 numbered parts')
  })

  test('an Edit of a bare file name elsewhere does not re-read', async ($, on) => {
    const w = world()
    await start($, on, w)
    w.files[DRAFT_PATH] = DRAFT.replace('⟨R:speed⟩', '42 ms')
    await $.tool.call({ tool: 'Edit', file_path: 'notes.md', old_string: 'a', new_string: 'b' })
    const ui = await mountPane($)
    expect((await ui.find({ type: 'Text', text: /^Left/ }))?.text).toBe('Left: ⟨ 1 · TODO 1')
  })

  test('an Edit elsewhere does not re-read', async ($, on) => {
    const w = world()
    await start($, on, w)
    w.files[DRAFT_PATH] = DRAFT.replace('⟨R:speed⟩', '42 ms')
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/notes.txt`, old_string: 'a', new_string: 'b' })
    const ui = await mountPane($)
    expect((await ui.find({ type: 'Text', text: /^Left/ }))?.text).toBe('Left: ⟨ 1 · TODO 1')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the pane draws on ${surface}`, async ($, on) => {
      await start($, on, world())
      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Text', text: /^Words/ }))?.text).toBe('Words: 20 in 4 numbered parts')
      expect((await ui.find({ type: 'Text', text: /^Part 3/ }))?.text).toContain('55% (line at 50%)')
      expect((await ui.find({ type: 'Text', text: /^part 1/ }))?.text).toBe('part 1: 4 · part 2: 3 · part 3: 11 · part 4: 2')
    })
  }
})
