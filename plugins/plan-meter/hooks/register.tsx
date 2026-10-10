import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ClaudeTask, PlanMeter } from '../types'
import { bar, line, parsePlan, percent, summarize } from './parse'
import type { Parsed } from './parse'
import { candidates, caseless, dirname, relativeTo, resolvePath, samePath, segmentTest } from './paths'
import { STORE_KEY, storedSwitch, switchText, switchWord } from './toggle'

const PANE = 'plan-meter'
const DEFAULT_PLANS = 'plans/*/plan.md,PLAN.md,plan.md,TODO.md,TASKS.md,ROADMAP.md,todo.txt,TODO.org'
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const ZERO = { done: 0, active: 0, todo: 0, total: 0 }
const meter = atom({ plugin: 'plan-meter', key: 'meter' } as const, null)
const tasks = atom({ plugin: 'plan-meter', key: 'tasks' } as const, [] as ClaudeTask[])
// The switch as this session read it (toggle.ts). Off, every hook passes its event on unchanged: no plan is read,
// no timer runs and nothing is drawn. The mod starts off; `/plan-meter on` turns it on for every session.
const enabled = atom({ plugin: 'plan-meter', key: 'enabled' } as const, false)

type Setup = { root: string; patterns: string[]; chosen: string | undefined; watched: string[] }

// The timer, edits and /plan-meter can overlap: only the newest reading may be written.
let newestRead = 0

// Expands a pattern one segment at a time (`*` in any segment); the most recently changed match wins.
async function newest($: any, root: string, pattern: string): Promise<string | undefined> {
  const parts = resolvePath(root, pattern).split('/')
  const first = parts.findIndex(p => p.includes('*'))
  if (first < 0) {
    const path = parts.join('/')
    return (await $.fs.exists(path)) ? path : undefined
  }
  let found: { path: string; mtimeMs: number }[] = [{ path: parts.slice(0, first).join('/'), mtimeMs: 0 }]
  for (let i = first; i < parts.length; i++) {
    const test = segmentTest(parts[i] ?? '', caseless(root))
    const kind = i === parts.length - 1 ? 'file' : 'dir'
    const next: typeof found = []
    for (const dir of found) {
      const entries: { name: string; kind: string; mtimeMs: number }[] = await $.fs.list(dir.path || '/').catch(() => [])
      for (const entry of entries) if (entry.kind === kind && test.test(entry.name)) next.push({ path: `${dir.path}/${entry.name}`, mtimeMs: entry.mtimeMs })
    }
    found = next
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path
}

// Finds the plan, reads it and the phase files it links to, and sums them up, with the files to watch.
async function measure($: any, setup: Setup): Promise<{ meter: PlanMeter; watched: string[] }> {
  const empty = { file: '', title: null, planStatus: null, phases: ZERO, steps: ZERO, current: null, next: [], formats: [], files: 0 }
  let path = setup.chosen
  for (const pattern of path === undefined ? setup.patterns : []) {
    path = await newest($, setup.root, pattern)
    if (path !== undefined) break
  }
  if (path === undefined) return { meter: { ...empty, error: `no plan found (${setup.patterns.join(', ')}); name one with /plan-meter <path>` }, watched: [] }
  const file = relativeTo(setup.root, path)
  try {
    const plan = parsePlan(await $.fs.read(path), path)
    const linked: { link: string; path: string; parsed: Parsed; again?: boolean }[] = []
    for (const link of plan.links.slice(0, 30)) {
      const target = resolvePath(dirname(path), link)
      // Two spellings of one file (`a.md`, `./a.md`) are read and counted once.
      const seen = linked.find(l => samePath(l.path, target))
      if (seen !== undefined) {
        linked.push({ ...seen, link, again: true })
        continue
      }
      // A link to a file that isn't there is skipped, not an error.
      const text: string | undefined = await $.fs.read(target).catch(() => undefined)
      if (text !== undefined) linked.push({ link, path: target, parsed: parsePlan(text, target) })
    }
    return { meter: summarize(file, plan, linked), watched: [path, ...linked.filter(l => !l.again).map(l => l.path)] }
  } catch (err) {
    return { meter: { ...empty, file, error: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}` }, watched: [path] }
  }
}

// The timer, edits and /plan-meter can overlap: only the newest reading is kept, checked again as it is written.
async function refresh($: any, setup: Setup): Promise<PlanMeter> {
  const reading = ++newestRead
  const found = await measure($, setup)
  if (reading === newestRead) setup.watched = found.watched
  await update($, meter, now => (reading === newestRead ? found.meter : now))
  return found.meter
}

// Starts the meter: reads the plan now, then again every `everyMs` to catch edits made outside Claude Code, such
// as the plan open in your editor. The timer is returned so that turning the mod off can stop it.
async function begin($: any, setup: Setup, everyMs: number): Promise<{ cancel: () => void }> {
  setup.root = await $.session.root()
  await refresh($, setup)
  return $.clock.every(everyMs, () => void refresh($, setup))
}

// Claude's task list after one of its task tools ran: TodoWrite replaces it, TaskCreate adds, TaskUpdate changes.
async function trackTasks($: any, tool: string, input: Record<string, any>, result: any): Promise<void> {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const list: ClaudeTask[] = input.todos.map((t: any, i: number) => ({ id: `todo-${i}`, subject: String(t?.content ?? ''), status: t?.status }))
    await update($, tasks, () => list)
  } else if (tool === 'TaskCreate' && typeof result?.task?.id === 'string') {
    const task: ClaudeTask = { id: result.task.id, subject: String(input.subject ?? result.task.subject ?? ''), status: 'pending' }
    await update($, tasks, list => [...list.filter(t => t.id !== task.id), task])
  } else if (tool === 'TaskUpdate' && typeof input.taskId === 'string' && result?.success !== false) {
    // A refused update changed nothing; when the tool says which status it moved to, that wins.
    const id = input.taskId
    const status = result?.statusChange?.to ?? input.status
    await update($, tasks, list =>
      status === 'deleted'
        ? list.filter(t => t.id !== id)
        : list.map(t => (t.id !== id ? t : { ...t, ...(status ? { status } : {}), ...(input.subject ? { subject: input.subject } : {}) })),
    )
  }
}

export const register: Register = (on, options) => {
  const setup: Setup = { root: '', patterns: candidates(options.plan ?? DEFAULT_PLANS), chosen: undefined, watched: [] }
  if (setup.patterns.length === 0) setup.patterns = candidates(DEFAULT_PLANS)
  const everyMs = Math.max(5, Number(options.refreshSeconds ?? 15)) * 1000
  // The re-read timer, while the mod is on. session.start can fire again in one load (a reload): one timer is enough.
  let ticking: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    // Not /plan: Claude Code has a built-in of that name, and a refused name must not stop the meter starting.
    // The command is registered even when the mod is off, so that it can be turned on.
    await $.command
      .register({
        name: 'plan-meter',
        description: "Show the plan's progress (/plan-meter on or off switches the mod; /plan-meter <path> picks a file)",
        argumentHint: '[on|off|status|<path>]',
      })
      .catch(() => undefined)
    const isOn = storedSwitch(await $.store.get(STORE_KEY).catch(() => undefined), false)
    await update($, enabled, () => isOn)
    ticking?.cancel()
    ticking = isOn ? await begin($, setup, everyMs) : undefined
    return next(e)
  })

  on('command.run', { command: 'plan-meter' }, async ($, e) => {
    const word = switchWord(e.args)
    if (word === 'on' || word === 'off') {
      const isOn = word === 'on'
      await $.store.set(STORE_KEY, isOn)
      await update($, enabled, () => isOn)
      ticking?.cancel()
      ticking = isOn ? await begin($, setup, everyMs) : undefined
      return { text: switchText('plan-meter', isOn) }
    }
    if (!(await read($, enabled))) return { text: switchText('plan-meter', false) }
    if (word === undefined) setup.chosen = resolvePath(setup.root, e.args)
    const found = await refresh($, setup)
    // Panes draw only in the terminal and the desktop app; under claude -p the line below is the answer.
    await $.ui.open({ id: PANE, title: 'Plan', focus: true, closeOnEscape: true }).catch(() => undefined)
    const list = await read($, tasks)
    const done = list.filter(t => t.status === 'completed').length
    return { text: `on · ${list.length > 0 ? `${line(found)} · Claude's tasks ${done}/${list.length}` : line(found)}` }
  })

  // An observer, not a guard: whatever goes wrong here, the tool's own answer is returned as it came.
  on('tool.call', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    try {
      const tool = String(e.tool)
      const input = e as unknown as Record<string, any>
      await trackTasks($, tool, input, ran.result)
      const path = input.file_path ?? input.notebook_path
      if (EDIT_TOOLS.includes(tool) && typeof path === 'string') {
        const full = resolvePath(setup.root, path)
        const isPlanLike = /(^|\/)(plan|todo|tasks|roadmap)\.(md|txt|org)$|\/phase-[^/]*\.md$/i.test(full)
        if (setup.watched.some(w => samePath(w, full)) || (setup.chosen === undefined && isPlanLike)) await refresh($, setup)
      }
    } catch {
      // The band stays as it was; the next edit or re-read tries again.
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!(await read($, enabled)) || options.band === 'off') return below
    const now = await read($, meter)
    const list = await read($, tasks)
    // A project with no plan and no task list gets no band at all.
    const hasPlan = now !== null && now.error === null
    if (e.props.hasSurvey || (!hasPlan && list.length === 0)) return below
    const { Box, Text } = $.ui.resolve(e)
    const done = list.filter(t => t.status === 'completed').length
    const parts = [hasPlan && now !== null ? line(now) : 'plan ▸ none', ...(list.length > 0 ? [`Claude's tasks ${done}/${list.length}`] : [])]
    return (
      <Box flexDirection="column">
        <Text wrap="truncate" dimColor={!hasPlan}>
          {parts.join(' · ').slice(0, Math.max(10, e.props.bodyColumns))}
        </Text>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // A pane left open when the mod was turned off.
    if (!(await read($, enabled))) return <Text dimColor>{switchText('plan-meter', false)}</Text>
    const now = await read($, meter)
    const list = await read($, tasks)
    const width = Math.max(10, Math.min(30, e.props.bodyColumns - 30))
    return (
      <Box flexDirection="column">
        {now === null && <Text dimColor>No plan read yet.</Text>}
        {now !== null && now.error !== null && <Text color="warning">{now.error}</Text>}
        {now !== null && now.error === null && <Text bold>{now.title ?? now.file}</Text>}
        {now !== null && now.error === null && now.planStatus !== null && <Text>{`Status: ${now.planStatus}`}</Text>}
        {now !== null && now.phases.total > 0 && (
          <Text color={now.phases.done === now.phases.total ? 'success' : undefined}>{`Phases ${bar(now.phases, width)} ${now.phases.done}/${now.phases.total} (${percent(now.phases)}%)`}</Text>
        )}
        {now !== null && now.steps.total > 0 && (
          <Text color={now.steps.done === now.steps.total ? 'success' : undefined}>{`Steps  ${bar(now.steps, width)} ${now.steps.done}/${now.steps.total} (${percent(now.steps)}%)`}</Text>
        )}
        {now !== null && now.current !== null && <Text color="warning">{`Now: ${now.current}`}</Text>}
        {now !== null && now.next.length > 0 && <Text>{`Next: ${now.next.join(' · ')}`}</Text>}
        {list.length > 0 && <Text bold>{`Claude's tasks ${list.filter(t => t.status === 'completed').length}/${list.length}`}</Text>}
        {list.slice(0, 8).map(t => (
          <Text key={t.id} dimColor={t.status === 'completed'}>{`${t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '▶' : '·'} ${t.subject}`}</Text>
        ))}
        {now !== null && now.error === null && <Text dimColor>{`${now.file} · ${now.files} file(s) · ${now.formats.join(', ') || 'no format recognised'}`}</Text>}
      </Box>
    )
  })
}
