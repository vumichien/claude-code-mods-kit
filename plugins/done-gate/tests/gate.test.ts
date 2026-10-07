import { describe, expect, mock, test } from 'claude-code/testing'

import { ranFiles, testOutcome, testRun } from '../hooks/gate'

const ROOT = 'C:/work/app'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} }

// What the stubbed engine answers per command: exit status by pattern; everything else succeeds.
// `wait`, when set, holds a Bash call open until the test lets it finish. `refuseUpdates` answers TaskUpdate with a failure.
type Host = { failing: RegExp | null; background: boolean; wait?: Promise<void>; refuseUpdates?: boolean; output?: string }

// Every stub sits beneath the plugin and is registered before the first $ call.
async function start($: any, on: any, host: Host = { failing: null, background: false }) {
  const clock = mock.clock(on, { now: 1_000_000 })
  let todos: unknown[] = []
  let tasks = 0
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', async ($: any, e: any) => {
    if (e.tool === 'Bash') {
      if (host.wait !== undefined) await host.wait
      const failed = host.failing !== null && host.failing.test(e.command)
      const result = { stdout: host.output ?? '', stderr: '', interrupted: false, ...(host.background ? { backgroundTaskId: 'b1' } : {}) }
      return failed ? { result, text: 'exit 1', isError: true } : { result, text: host.output ?? 'ok' }
    }
    // Like the engine, TodoWrite answers with the list before and after.
    if (e.tool === 'TodoWrite') {
      const oldTodos = todos
      todos = e.todos
      return { result: { oldTodos, newTodos: e.todos }, text: 'ok' }
    }
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++tasks), subject: e.subject } }, text: 'ok' }
    if (e.tool === 'TaskUpdate') {
      if (host.refuseUpdates) return { result: { success: false, taskId: e.taskId, updatedFields: [], error: 'no such task' }, text: 'no such task' }
      return { result: { success: true, taskId: e.taskId, updatedFields: ['status'], statusChange: { from: 'in_progress', to: e.status } }, text: 'ok' }
    }
    return { result: {}, text: 'ok' }
  })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: 'no hook answered' }))
  on('ui.render', ($: any, e: any) => h($.ui.resolve(e).Box, { key: 'engine-band' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

const edit = ($: any, file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command })
// As Claude does it: TaskCreate names the task, TaskUpdate later carries only its id.
async function complete($: any, subject = 'Add the export') {
  const created: any = await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
  return $.tool.call({ tool: 'TaskUpdate', taskId: created.result.task.id, status: 'completed' })
}

async function bandText($: any, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'done-gate', surface, component: 'AbovePrompt', props: BAND })
  return (await ui.find({ type: 'Text', text: /^done-gate/ }))?.text
}

describe('helpers', () => {
  test('knows the usual test runners as commands, not as words in an argument', () => {
    for (const c of ['pytest -q', 'cd api && npm test', 'python3 -m pytest tests/', 'go test ./...', 'cargo nextest run', 'pnpm run test', 'mvn -q verify', 'claude plugin test .', 'FOO=1 uv run pytest -q', 'npx vitest run']) {
      expect(testRun(c, [])).toBe('test')
    }
    for (const c of ['npm install', 'git status', 'python app.py', 'cat latest.txt', 'echo pytest', 'printf "npm test"', 'git commit -m "add pytest"']) expect(testRun(c, [])).toBeUndefined()
    expect(testRun('./scripts/check.sh --fast', ['./scripts/check.sh'])).toBe('test')
    expect(testRun('git checkout main', ['check'])).toBeUndefined()
    expect(testRun('make lint && check', ['check'])).toBe('test')
  })

  test('an exit status that could hide a failure is masked', () => {
    for (const c of ['pytest || true', 'pytest | tee log.txt', 'npm test; true', 'pytest -q 2>&1 | tail -20', 'pytest; echo done']) expect(testRun(c, [])).toBe('masked')
    for (const c of ['cd api; pytest', 'pytest && echo ok', '(cd api && npm test)']) expect(testRun(c, [])).toBe('test')
  })

  test("reads a runner's own summary line; failure words win", () => {
    expect(testOutcome('===== 12 passed in 0.31s =====')).toBe('passed')
    expect(testOutcome('==== 1 failed, 11 passed in 0.4s ====')).toBe('failed')
    expect(testOutcome(' 18 pass\n 0 fail\nRan 18 tests')).toBe('passed')
    expect(testOutcome(' 17 pass\n 1 fail')).toBe('failed')
    expect(testOutcome('test result: ok. 4 passed; 0 failed')).toBe('passed')
    expect(testOutcome('ok  \texample.com/pkg\t0.01s')).toBe('passed')
    expect(testOutcome('done')).toBeUndefined()
  })

  test('the files a command runs: after an interpreter, or a path as the command; never a file it only reads', () => {
    expect(ranFiles('python scripts/report.py --dry-run')).toEqual(['scripts/report.py'])
    expect(ranFiles('cd x && ./build.sh fast')).toEqual(['./build.sh'])
    expect(ranFiles('python -u tools/run.py')).toEqual(['tools/run.py'])
    for (const c of ['cat src/export.py', 'git diff src/export.py', 'python -m pytest', 'python -c "print(1)"']) expect(ranFiles(c)).toEqual([])
  })
})

describe('done-gate', () => {
  test('a task marked done after a code edit with no test run: a note for Claude, nothing refused', async ($, on) => {
    await start($, on)
    await edit($, `${ROOT}\\src\\export.py`)
    const ran: any = await complete($)
    expect(ran.deny).toBeUndefined()
    expect(ran.result.success).toBe(true)
    expect(ran.context?.[0]).toBe(
      'done-gate: "Add the export" was marked done, but 1 code file was changed and no test has run in this session: src/export.py. ' +
        'Before you report this task as finished, run the tests that cover these files, or tell the user plainly that they were not tested and why.',
    )
    expect(await bandText($)).toBe('done-gate ▸ no test run yet · 1 file changed since · warned 1×')
  })

  test('a passing test run clears the changed files, so the next done is quiet', async ($, on) => {
    const clock = await start($, on)
    await edit($, 'src/export.py')
    await bash($, 'pytest -q')
    await clock.advance(120_000)
    const ran: any = await complete($)
    expect(ran.context).toBeUndefined()
    expect(await bandText($)).toBe('done-gate ▸ tests ✔ passed 2 min ago')
  })

  test('a failing test run keeps the files and says the run failed', async ($, on) => {
    await start($, on, { failing: /pytest/, background: false })
    await edit($, 'src/export.py')
    await bash($, 'pytest -q')
    const ran: any = await complete($)
    expect(ran.context?.[0]).toContain('changed and the last test run failed: src/export.py')
    expect(await bandText($)).toBe('done-gate ▸ tests ✘ failed 0 s ago · 1 file changed since · warned 1×')
  })

  test('a test sent to the background is not counted as a result', async ($, on) => {
    await start($, on, { failing: null, background: true })
    await edit($, 'src/export.py')
    await bash($, 'pytest -q')
    expect(await bandText($)).toBe('done-gate ▸ no test run yet · 1 file changed since')
  })

  test('docs edits need no test run', async ($, on) => {
    await start($, on)
    await edit($, 'README.md')
    await $.tool.call({ tool: 'Write', file_path: 'docs/notes.txt', content: 'x' })
    expect((await complete($) as any).context).toBeUndefined()
    expect(await bandText($)).toBeUndefined()
  })

  test('running a changed script by name clears that file only', async ($, on) => {
    await start($, on)
    await edit($, 'scripts/report.py')
    await edit($, 'src/export.py')
    await bash($, 'python scripts/report.py --dry-run')
    expect((await complete($) as any).context?.[0]).toContain('1 code file was changed and no test has run in this session: src/export.py.')
  })

  test('reading a changed file, or running another file with the same name, checks nothing', async ($, on) => {
    await start($, on)
    await edit($, 'src/export.py')
    await bash($, 'cat src/export.py')
    await bash($, 'git diff src/export.py')
    await bash($, 'python other/export.py')
    expect(await bandText($)).toBe('done-gate ▸ no test run yet · 1 file changed since')
  })

  test("a piped run is judged by the runner's summary in its output", async ($, on) => {
    const host: Host = { failing: null, background: false, output: '===== 5 passed in 0.12s =====' }
    await start($, on, host)
    await edit($, 'src/export.py')
    await bash($, 'pytest -q 2>&1 | tail -5')
    expect(await bandText($)).toBe('done-gate ▸ tests ✔ passed 0 s ago')
    await edit($, 'src/export.py')
    host.output = '==== 1 failed, 4 passed in 0.2s ===='
    await bash($, 'pytest -q 2>&1 | tail -5')
    expect(await bandText($)).toBe('done-gate ▸ tests ✘ failed 0 s ago · 1 file changed since')
  })

  test('a passing run that could hide a failure, with no summary to read, clears nothing', async ($, on) => {
    await start($, on)
    await edit($, 'src/export.py')
    await bash($, 'pytest || true')
    expect(await bandText($)).toBe('done-gate ▸ no test run yet · 1 file changed since')
  })

  test('an edit made while the tests ran stays unchecked', async ($, on) => {
    let finish!: () => void
    const host: Host = { failing: null, background: false, wait: new Promise<void>(r => (finish = r)) }
    await start($, on, host)
    await edit($, 'src/a.py')
    const running = bash($, 'pytest')
    await edit($, 'src/b.py')
    finish()
    await running
    const reply = await ($ as any).command.run({ command: 'done-gate', args: '' })
    expect(reply.text).toContain('changed since: src/b.py')
    expect(reply.text).not.toContain('src/a.py')
  })

  test('a TaskUpdate the tool refused marks nothing done', async ($, on) => {
    await start($, on, { failing: null, background: false, refuseUpdates: true })
    await edit($, 'src/export.py')
    expect((await complete($) as any).context).toBeUndefined()
  })

  test('TodoWrite: only items newly marked completed count', async ($, on) => {
    await start($, on)
    const old = { content: 'Old item', status: 'completed', activeForm: 'x' } as const
    const first: any = await $.tool.call({ tool: 'TodoWrite', todos: [old, { content: 'Add the export', status: 'in_progress', activeForm: 'y' }] })
    expect(first.context).toBeUndefined()
    await edit($, 'src/export.py')
    const todos = [old, { content: 'Add the export', status: 'completed', activeForm: 'y' } as const]
    const ran: any = await $.tool.call({ tool: 'TodoWrite', todos })
    expect(ran.context?.[0]).toContain('"Add the export" was marked done')
    const again: any = await $.tool.call({ tool: 'TodoWrite', todos })
    expect(again.context).toBeUndefined()
  })

  test('your own test command counts', { options: { testCommands: './scripts/check.sh' } }, async ($, on) => {
    await start($, on)
    await edit($, 'src/export.py')
    await bash($, './scripts/check.sh')
    expect(await bandText($)).toBe('done-gate ▸ tests ✔ passed 0 s ago')
  })

  test('/done-gate lists the changed files and the last test command', async ($, on) => {
    await start($, on, { failing: /pytest/, background: false })
    await bash($, 'pytest tests/test_api.py')
    await edit($, 'src/a.py')
    await edit($, 'src/b.ts')
    const reply = await ($ as any).command.run({ command: 'done-gate', args: '' })
    expect(reply.text).toBe('done-gate ▸ tests ✘ failed 0 s ago · 2 files changed since\nlast test command: pytest tests/test_api.py\nchanged since: src/a.py, src/b.ts')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the band draws on ${surface}`, async ($, on) => {
      await start($, on)
      await edit($, 'src/a.py')
      expect(await bandText($, surface)).toBe('done-gate ▸ no test run yet · 1 file changed since')
    })
  }
})
