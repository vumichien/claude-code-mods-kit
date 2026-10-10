import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Gate } from '../types'
import { describe, isIgnored, list, ranFiles, sameFile, shortPath, testOutcome, testRun, warning } from './gate'
import { STORE_KEY, storedSwitch, switchText, switchWord } from './toggle'

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const SHELL_TOOLS = ['Bash', 'PowerShell']
const DEFAULT_IGNORE = '.md,.mdx,.markdown,.txt,.rst,.adoc,.org'
const gate = atom({ plugin: 'done-gate', key: 'gate' } as const, { lastTest: null, unchecked: [], warnings: 0 } as Gate)
// The switch as this session read it (toggle.ts). Off, every hook passes its event on unchanged: edits and test
// runs are not tracked, Claude gets no note and nothing is drawn. The mod starts off; `/done-gate on` turns it on.
const enabled = atom({ plugin: 'done-gate', key: 'enabled' } as const, false)

// Task names by id, from TaskCreate: a TaskUpdate call carries only the id. Each edit gets the next number, so a
// test run clears only the edits made before it started, not one made while it ran.
type Setup = { root: string; extra: string[]; ignore: string[]; subjects: Map<string, string>; edits: number; editedAt: Map<string, number> }

// The tasks a TodoWrite call newly marked completed, or the one a TaskUpdate completed.
function completedTasks(tool: string, input: Record<string, any>, result: any, subjects: Map<string, string>): string[] {
  if (tool === 'TaskUpdate') {
    // A refused update changed nothing; when the tool says which status it moved to, that wins.
    if (result?.success === false || (result?.statusChange?.to ?? input.status) !== 'completed') return []
    return [String(input.subject ?? subjects.get(String(input.taskId)) ?? `task ${input.taskId}`)]
  }
  if (tool !== 'TodoWrite') return []
  const before = new Set<string>((result?.oldTodos ?? []).filter((t: any) => t?.status === 'completed').map((t: any) => String(t.content)))
  const after: any[] = result?.newTodos ?? input.todos ?? []
  return after.filter(t => t?.status === 'completed' && !before.has(String(t.content))).map(t => String(t.content))
}

// Files changed and test runs seen; answers with a note for Claude when a task is marked done too early.
async function observe($: any, setup: Setup, e: Record<string, any>, ran: any, startedAt: number): Promise<string | undefined> {
  const tool = String(e.tool)
  const path = e.file_path ?? e.notebook_path
  if (EDIT_TOOLS.includes(tool) && typeof path === 'string') {
    if (ran.isError === true || isIgnored(path, setup.ignore)) return undefined
    const file = shortPath(setup.root, path)
    setup.editedAt.set(file, ++setup.edits)
    await update($, gate, g => (g.unchecked.includes(file) ? g : { ...g, unchecked: [...g.unchecked, file] }))
    return undefined
  }
  if (SHELL_TOOLS.includes(tool) && typeof e.command === 'string') {
    // A command sent to the background has not finished: its outcome is unknown.
    if (ran.result?.backgroundTaskId !== undefined) return undefined
    const passed = ran.isError !== true && ran.result?.interrupted !== true
    const command = e.command
    const at = await $.clock.now()
    const masked = testRun(command, setup.extra)
    // A masked run (`pytest | tail -20`) is judged by the runner's summary in what came back, when there is one.
    const said = masked === 'masked' ? testOutcome(`${ran.text ?? ''}\n${ran.result?.stdout ?? ''}`) : undefined
    const kind = masked === 'masked' ? (said === 'failed' ? 'failed' : said === 'passed' && passed ? 'test' : 'masked') : masked
    const before = (f: string) => (setup.editedAt.get(f) ?? 0) <= startedAt
    if (kind === 'failed' || (kind !== undefined && kind !== 'masked' && !passed)) {
      await update($, gate, g => ({ ...g, lastTest: { passed: false, at, command: command.slice(0, 120) } }))
    } else if (kind === 'test') {
      await update($, gate, g => ({ ...g, lastTest: { passed: true, at, command: command.slice(0, 120) }, unchecked: g.unchecked.filter(f => !before(f)) }))
    } else if (kind === undefined && passed) {
      // Running a changed script checks that it runs, if not that it is right. Reading it (cat, git diff) checks nothing.
      const scripts = ranFiles(command)
      await update($, gate, g => ({ ...g, unchecked: g.unchecked.filter(f => !(before(f) && scripts.some(s => sameFile(setup.root, s, f)))) }))
    }
    // A masked run with no runner summary to read (`pytest || true` printing nothing useful) says nothing either way.
    return undefined
  }
  if (tool === 'TaskCreate' && ran.result?.task?.id !== undefined) setup.subjects.set(String(ran.result.task.id), String(e.subject ?? ran.result.task.subject ?? ''))
  const done = completedTasks(tool, e, ran.result, setup.subjects)
  const now = await read($, gate)
  if (done.length === 0 || now.unchecked.length === 0) return undefined
  await update($, gate, g => ({ ...g, warnings: g.warnings + 1 }))
  return warning(now, done[0] ?? 'a task')
}

export const register: Register = (on, options) => {
  const setup: Setup = { root: '', extra: list(options.testCommands), ignore: list(options.ignore ?? DEFAULT_IGNORE), subjects: new Map(), edits: 0, editedAt: new Map() }

  on('session.start', async ($, e, next) => {
    // The command is registered even when the mod is off, so that it can be turned on.
    await $.command.register({
      name: 'done-gate',
      description: 'Show the last test run and the code files changed since (/done-gate on or off switches the mod)',
      argumentHint: '[on|off|status]',
    })
    const isOn = storedSwitch(await $.store.get(STORE_KEY).catch(() => undefined), false)
    await update($, enabled, () => isOn)
    if (isOn) setup.root = await $.session.root()
    return next(e)
  })

  on('command.run', { command: 'done-gate' }, async ($, e) => {
    const word = switchWord(e.args)
    if (word === 'on' || word === 'off') {
      const isOn = word === 'on'
      await $.store.set(STORE_KEY, isOn)
      await update($, enabled, () => isOn)
      if (isOn) setup.root = await $.session.root()
      return { text: switchText('done-gate', isOn) }
    }
    if (!(await read($, enabled))) return { text: switchText('done-gate', false) }
    const now = await read($, gate)
    const head = describe(now, await $.clock.now()) ?? 'done-gate ▸ no code changed and no test run yet'
    const tail = now.unchecked.length > 0 ? `\nchanged since: ${now.unchecked.join(', ')}` : ''
    const last = now.lastTest === null ? '' : `\nlast test command: ${now.lastTest.command}`
    return { text: `on · ${head}${last}${tail}` }
  })

  // An observer, not a guard: it only ever adds a note and never refuses a call; whatever goes wrong here,
  // the tool's own answer is returned as it came.
  on('tool.call', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const startedAt = setup.edits
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    try {
      const note = await observe($, setup, e as unknown as Record<string, any>, ran, startedAt)
      if (note === undefined) return ran
      $.ui.toast(note.slice(0, 160))
      return { ...ran, context: [...(ran.context ?? []), note] }
    } catch {
      return ran
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!(await read($, enabled)) || options.band === 'off') return below
    const text = describe(await read($, gate), await $.clock.now())
    if (e.props.hasSurvey || text === undefined) return below
    const { Box, Text } = $.ui.resolve(e)
    const now = await read($, gate)
    const color = now.lastTest?.passed === false ? 'error' : now.unchecked.length > 0 ? 'warning' : 'success'
    return (
      <Box flexDirection="column">
        <Text wrap="truncate" color={color}>
          {text.slice(0, Math.max(10, e.props.bodyColumns))}
        </Text>
        {below}
      </Box>
    )
  })
}
