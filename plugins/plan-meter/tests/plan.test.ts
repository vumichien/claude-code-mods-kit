import { describe, expect, mock, test } from 'claude-code/testing'

import { classify, line, parsePlan, summarize } from '../hooks/parse'
import { normalize, samePath, segmentTest } from '../hooks/paths'

const runCommand = ($: any, command: string, args = '') => $.command.run({ command, args })

// Plans written for these tests, one per format; none is a real project's plan.
const ROOT = 'C:/work/app'
const TABLE_PLAN = [
  '---',
  'title: "Ship the export feature"',
  'status: in_progress',
  '---',
  '# Ship the export feature',
  '',
  '| Phase | Name | Status |',
  '|-------|------|--------|',
  '| 1 | [Schema](./phase-01-schema.md) | ✅ Complete (review pending) |',
  '| 2 | [API](./phase-02-api.md) | Blocked — waiting on auth |',
  '| 3 | [UI](./phase-03-ui.md) | Pending |',
  '| 4 | Docs | Dropped |',
].join('\n')
const PHASE_1 = '# Phase 1: Schema\n\n- [x] tables\n- [x] migration\n'
const PHASE_2 = '# Phase 2: API\n\n- [x] routes\n- [/] auth middleware\n- [ ] rate limit\n'
const PHASE_3 = '# Phase 3: UI\n\n**Status:** not started\n\n- [ ] export button\n'

// calls: every $ call the plugin made that reads a file, writes, draws or calls the model, by event name.
type World = { files: Record<string, string>; mtimes: Record<string, number>; calls: string[] }

const world = (): World => ({
  calls: [],
  files: {
    [`${ROOT}/plans/260101-export/plan.md`]: TABLE_PLAN,
    [`${ROOT}/plans/260101-export/phase-01-schema.md`]: PHASE_1,
    [`${ROOT}/plans/260101-export/phase-02-api.md`]: PHASE_2,
    [`${ROOT}/plans/260101-export/phase-03-ui.md`]: PHASE_3,
    [`${ROOT}/plans/251201-old/plan.md`]: '# Old\n\n- [x] one\n',
    [`${ROOT}/TODO.md`]: '# Todo\n\n- [x] a\n- [ ] b\n',
  },
  mtimes: { [`${ROOT}/plans/260101-export/plan.md`]: 2000, [`${ROOT}/plans/251201-old/plan.md`]: 1000 },
})

// Every stub sits beneath the plugin and is registered before the first $ call.
// isOn: the switch as an earlier `/plan-meter on` left it in the store; false starts the mod as it ships, off.
async function start($: any, on: any, w: World, isOn = true) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, isOn ? { enabled: true } : {})
  const norm = (p: string) => p.replace(/\\/g, '/')
  for (const name of ['fs.write', 'ui.toast', 'ui.status', 'ui.log', 'model.complete']) on(name, () => {
    w.calls.push(name)
    return { value: undefined }
  })
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('fs.read', ($: any, e: any) => {
    w.calls.push('fs.read')
    const path = norm(e.path)
    if (!(path in w.files)) throw new Error(`ENOENT ${path}`)
    return { value: w.files[path] }
  })
  on('fs.exists', ($: any, e: any) => {
    w.calls.push('fs.exists')
    return { value: norm(e.path) in w.files }
  })
  // Lists files and the folders implied by the paths beneath `dir`.
  on('fs.list', ($: any, e: any) => {
    w.calls.push('fs.list')
    const dir = norm(e.path)
    const seen = new Map<string, any>()
    for (const f of Object.keys(w.files).filter(f => f.startsWith(`${dir}/`))) {
      const [name, ...rest] = f.slice(dir.length + 1).split('/')
      const kind = rest.length > 0 ? 'dir' : 'file'
      const mtimeMs = Math.max(seen.get(name!)?.mtimeMs ?? 0, w.mtimes[f] ?? 0)
      seen.set(name!, { name, kind, size: 1, mtimeMs, isLink: false })
    }
    return { value: [...seen.values()] }
  })
  on('ui.open', () => {
    w.calls.push('ui.open')
    return { value: { isOpen: true } }
  })
  on('tool.call', ($: any, e: any) =>
    e.tool === 'TaskCreate' ? { result: { task: { id: String(Object.keys(w.files).length), subject: e.subject } }, text: 'ok' } : { result: {}, text: 'ok' },
  )
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: 'no hook answered' }))
  on('ui.render', ($: any, e: any) => h($.ui.resolve(e).Box, { key: 'engine-band' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} }

async function bandText($: any, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'plan-meter', surface, component: 'AbovePrompt', props: BAND })
  return (await ui.find({ type: 'Text', text: /^plan/ }))?.text
}

const parsed = (text: string, name = 'plan.md') => summarize(name, parsePlan(text, name), [])

describe('formats', () => {
  test('status words and marks in three languages; the earliest one wins', () => {
    expect(classify('Done (pending review)')).toBe('done')
    expect(classify('Not started')).toBe('todo')
    expect(classify('in_progress')).toBe('active')
    expect(classify('🚧 building')).toBe('active')
    expect(classify('Đang làm')).toBe('active')
    expect(classify('Xong')).toBe('done')
    expect(classify('完了')).toBe('done')
    expect(classify('進行中')).toBe('active')
    expect(classify("Won't do")).toBe('dropped')
    expect(classify('Overview')).toBeUndefined()
  })

  test('checklists: GitHub and Obsidian marks, numbered items, fenced code skipped', () => {
    const m = parsed(['# Ship', '- [x] a', '* [X] b', '+ [/] c', '1. [ ] d', '2) [-] e', '```', '- [ ] in a code block', '```'].join('\n'))
    expect(m.steps).toEqual({ done: 2, active: 1, todo: 1, total: 4 })
    expect(m.current).toBe('c')
    expect(m.formats).toEqual(['checklist'])
  })

  test('a status table: the name column over a number, its status words, dropped rows left out', () => {
    const m = summarize('plan.md', parsePlan(TABLE_PLAN, 'plan.md'), [])
    expect(m.title).toBe('Ship the export feature')
    expect(m.planStatus).toBe('in_progress')
    expect(m.phases).toEqual({ done: 1, active: 1, todo: 1, total: 3 })
    expect(m.current).toBe('API')
    expect(m.formats).toEqual(['frontmatter', 'status table'])
  })

  test('linked phase files add their steps, and a table without a status column takes each file\'s status', () => {
    const plan = parsePlan('# Plan\n\n| # | Phase | File |\n|---|---|---|\n| 1 | Schema | [p1](phase-01-schema.md) |\n| 2 | API | [p2](phase-02-api.md) |\n', 'plan.md')
    expect(plan.links).toEqual(['phase-01-schema.md', 'phase-02-api.md'])
    const m = summarize('plan.md', plan, [
      { link: 'phase-01-schema.md', parsed: parsePlan(PHASE_1, 'phase-01-schema.md') },
      { link: 'phase-02-api.md', parsed: parsePlan(PHASE_2, 'phase-02-api.md') },
    ])
    expect(m.phases).toEqual({ done: 1, active: 1, todo: 0, total: 2 })
    expect(m.steps).toEqual({ done: 3, active: 1, todo: 1, total: 5 })
    expect(m.formats).toContain('linked phase files')
    expect(m.files).toBe(3)
  })

  test('headings: a mark, a status at the end, or the checklist beneath; other headings are not phases', () => {
    const m = parsed(
      [
        '# Plan: Launch',
        '## Phase 1: Setup ✅',
        '## Phase 2: Build (in progress)',
        '## Phase 3: Ship',
        '- [x] tag',
        '- [ ] publish',
        '## Decisions (closed 2026-09-27)',
        '## Open questions',
      ].join('\n'),
    )
    expect(m.title).toBe('Launch')
    expect(m.phases).toEqual({ done: 1, active: 2, todo: 0, total: 3 })
    expect(m.current).toBe('Phase 2: Build')
    expect(m.formats).toEqual(['checklist', 'status headings'])
  })

  test('headings named Phase with nothing that says how far they are give no phase count', () => {
    const m = parsed('# Plan\n\nStatus (2026-10-07): Draft, phase 3 next.\n\n### Step 0 — Smoke test\n### Step 1 — Run\n')
    expect(m.phases.total).toBe(0)
    expect(line(m)).toBe('plan ▸ Plan · Draft, phase 3 next.')
  })

  test('a bold status line is the plan\'s status', () => {
    expect(parsed('# P\n\n**Status:** Waiting for review\n').planStatus).toBe('Waiting for review')
  })

  test('org-mode headlines', () => {
    const m = parsed('* DONE Write spec\n* NEXT Build it\n** DOING Tests\n* CANCELLED Old idea\n', 'TODO.org')
    expect(m.steps).toEqual({ done: 1, active: 1, todo: 1, total: 3 })
    expect(m.formats).toEqual(['org-mode'])
  })

  test('todo.txt: an x and a date mark a line done', () => {
    const m = parsed('x 2026-10-01 2026-09-30 call the bank\n(A) write the report +work\nbuy milk\n', 'todo.txt')
    expect(m.steps).toEqual({ done: 1, active: 0, todo: 2, total: 3 })
    expect(m.next).toEqual(['(A) write the report +work', 'buy milk'])
  })

  test('a row that says Pending stays pending, whatever its phase file says', () => {
    const plan = parsePlan('# P\n\n| Name | Status |\n|---|---|\n| [Schema](phase-01-schema.md) | Pending |\n', 'plan.md')
    const m = summarize('plan.md', plan, [{ link: 'phase-01-schema.md', parsed: parsePlan('- [x] a\n', 'phase-01-schema.md') }])
    expect(m.phases).toEqual({ done: 0, active: 0, todo: 1, total: 1 })
  })

  test('a blank status, or a link with a #section, defers to the phase file', () => {
    const plan = parsePlan('# P\n\n| Name | Status |\n|---|---|\n| [Schema](phase-01-schema.md#overview) | |\n', 'plan.md')
    expect(plan.links).toEqual(['phase-01-schema.md'])
    const m = summarize('plan.md', plan, [{ link: 'phase-01-schema.md', parsed: parsePlan('- [x] a\n', 'phase-01-schema.md') }])
    expect(m.phases).toEqual({ done: 1, active: 0, todo: 0, total: 1 })
  })

  test('links in headings are followed; other documents are not phase files', () => {
    const plan = parsePlan('# P\n\n## [Phase 1: Schema](phase-01-schema.md)\n\nSee [Operations](department.md) and [the parts list](partners.md).\n', 'plan.md')
    expect(plan.links).toEqual(['phase-01-schema.md'])
    const m = summarize('plan.md', plan, [{ link: 'phase-01-schema.md', parsed: parsePlan('**Status:** done\n', 'phase-01-schema.md') }])
    expect(m.phases).toEqual({ done: 1, active: 0, todo: 0, total: 1 })
  })

  test('an escaped pipe stays inside its cell', () => {
    const m = parsed('# P\n\n| Name | Status |\n|---|---|\n| API \\| Tests | Done |\n')
    expect(m.phases).toEqual({ done: 1, active: 0, todo: 0, total: 1 })
  })

  test('two links to one file count its steps once', () => {
    const phase = parsePlan(PHASE_1, 'phase-01-schema.md')
    const plan = parsePlan('# P\n\n[a](phase-01-schema.md) and [b](./phase-01-schema.md)\n', 'plan.md')
    const m = summarize('plan.md', plan, [
      { link: 'phase-01-schema.md', parsed: phase },
      { link: './phase-01-schema.md', parsed: phase, again: true },
    ])
    expect(m.steps.total).toBe(2)
  })

  test('paths: a network share keeps its prefix; Unix paths keep their case', () => {
    expect(normalize('\\\\server\\share\\plans\\..\\PLAN.md')).toBe('//server/share/PLAN.md')
    expect(samePath('/srv/app/PLAN.md', '/srv/app/plan.md')).toBe(false)
    expect(samePath('C:\\Work\\PLAN.md', 'c:/work/plan.md')).toBe(true)
    expect(segmentTest('PLAN.md', false).test('plan.md')).toBe(false)
    expect(segmentTest('*-draft.md').test('A-DRAFT.md')).toBe(true)
  })

  test('a file with nothing to count says so', () => {
    expect(line(parsed('# Notes\n\nJust prose.\n'))).toBe('plan ▸ Notes · no checklist, status table or status headings found')
  })
})

describe('plan-meter', () => {
  test('finds the newest plans/*/plan.md, reads its phase files, and draws the band', async ($, on) => {
    await start($, on, world())
    expect(await bandText($)).toBe('plan ▸ Ship the export feature · phases 1/3 · steps 3/6 (50%) · now: API')
  })

  test('/plan-meter replies with the same line, and /plan-meter <path> switches file', async ($, on) => {
    await start($, on, world())
    expect((await runCommand($, 'plan-meter')).text).toContain('phases 1/3')
    expect((await runCommand($, 'plan-meter', 'TODO.md')).text).toBe('on · plan ▸ Todo · steps 1/2 (50%) · next: b')
    expect(await bandText($)).toBe('plan ▸ Todo · steps 1/2 (50%) · next: b')
  })

  test('the plan option names other files, tried in order', { options: { plan: 'ROADMAP.md, TODO.md' } }, async ($, on) => {
    await start($, on, world())
    expect(await bandText($)).toBe('plan ▸ Todo · steps 1/2 (50%) · next: b')
  })

  test('an Edit of a linked phase file updates the band', async ($, on) => {
    const w = world()
    await start($, on, w)
    w.files[`${ROOT}/plans/260101-export/phase-02-api.md`] = PHASE_2.replace('[/]', '[x]').replace('[ ]', '[x]')
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}\\plans\\260101-export\\phase-02-api.md`, old_string: '[ ]', new_string: '[x]' })
    expect(await bandText($)).toBe('plan ▸ Ship the export feature · phases 1/3 · steps 5/6 (83%) · now: API')
  })

  test('an edit made outside Claude shows up on the next re-read', async ($, on) => {
    const w = world()
    const clock = await start($, on, w)
    w.files[`${ROOT}/plans/260101-export/plan.md`] = TABLE_PLAN.replace('Blocked — waiting on auth', 'Done')
    expect(await bandText($)).toContain('phases 1/3')
    await clock.advance(15_000)
    expect(await bandText($)).toBe('plan ▸ Ship the export feature · phases 2/3 · steps 3/6 (50%) · now: auth middleware')
  })

  test("Claude's task list from TodoWrite, then TaskCreate and TaskUpdate", async ($, on) => {
    await start($, on, world())
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'a', status: 'completed', activeForm: 'A' }, { content: 'b', status: 'in_progress', activeForm: 'B' }] })
    expect(await bandText($)).toContain("· Claude's tasks 1/2")
    const created: any = await $.tool.call({ tool: 'TaskCreate', subject: 'c', description: 'c' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: created.result.task.id, status: 'completed' })
    expect(await bandText($)).toContain("· Claude's tasks 2/3")
    await $.tool.call({ tool: 'TaskUpdate', taskId: created.result.task.id, status: 'deleted' })
    expect(await bandText($)).toContain("· Claude's tasks 1/2")
  })

  test('the mod starts off; /plan-meter on turns it on, for the next session too; /plan-meter off stops it', async ($, on) => {
    const w = world()
    const clock = await start($, on, w, false)
    expect(await bandText($)).toBeUndefined()
    expect((await runCommand($, 'plan-meter')).text).toBe('off (/plan-meter on turns it on)')
    expect((await runCommand($, 'plan-meter', 'status')).text).toBe('off (/plan-meter on turns it on)')
    expect((await runCommand($, 'plan-meter', 'on')).text).toBe('on (/plan-meter off turns it off)')
    expect(await bandText($)).toContain('phases 1/3')
    // The switch is kept in the store: a new session starts on.
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(await bandText($)).toContain('phases 1/3')
    expect((await runCommand($, 'plan-meter', 'off')).text).toBe('off (/plan-meter on turns it on)')
    expect(await bandText($)).toBeUndefined()
    // Off, the re-read timer is stopped: nothing is read any more.
    w.calls.length = 0
    await clock.advance(60_000)
    expect(w.calls).toEqual([])
  })

  test('off, every hook passes its event on unchanged, and nothing is read, written or drawn', async ($, on) => {
    const w = world()
    const clock = await start($, on, w, false)
    const edit = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/plans/260101-export/plan.md`, old_string: '[ ]', new_string: '[x]' })
    expect(edit).toEqual({ result: {}, text: 'ok' })
    const todos = await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'a', status: 'completed', activeForm: 'A' }] })
    expect(todos).toEqual({ result: {}, text: 'ok' })
    expect(await bandText($)).toBeUndefined()
    await clock.advance(60_000)
    expect((await runCommand($, 'plan-meter')).text).toBe('off (/plan-meter on turns it on)')
    expect(w.calls).toEqual([])
  })

  test('band off: the mod is on but draws no band, and /plan-meter still answers', { options: { band: 'off' } }, async ($, on) => {
    await start($, on, world())
    expect(await bandText($)).toBeUndefined()
    expect((await runCommand($, 'plan-meter')).text).toContain('phases 1/3')
  })

  test('no plan and no task list: no band at all', async ($, on) => {
    await start($, on, { files: {}, mtimes: {}, calls: [] })
    expect(await bandText($)).toBeUndefined()
    expect((await runCommand($, 'plan-meter')).text).toContain('no plan found')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the pane draws on ${surface}`, async ($, on) => {
      await start($, on, world())
      await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'wire the button', status: 'in_progress', activeForm: 'Wiring' }] })
      await runCommand($, 'plan-meter')
      const ui = await $.ui.mount({
        plugin: 'plan-meter',
        surface,
        component: 'Pane',
        requestId: 'plan-meter',
        props: { title: 'Plan', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
      })
      expect((await ui.find({ type: 'Text', text: /^Phases/ }))?.text).toContain('1/3 (33%)')
      expect((await ui.find({ type: 'Text', text: /^Now/ }))?.text).toBe('Now: API')
      expect((await ui.find({ type: 'Text', text: /^Next/ }))?.text).toBe('Next: rate limit · export button')
      expect((await ui.find({ type: 'Text', text: /wire the button/ }))?.text).toBe('▶ wire the button')
    })
  }
})
