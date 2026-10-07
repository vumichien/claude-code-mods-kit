import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ArticleMeter } from '../types'
import { bar, markerLine, measureDraft, newestMatch, parseMarkers, relativeTo, resolvePath, samePath, splitPattern, summary, totalWords } from './meter'
import type { Goal } from './meter'

const PANE = 'article-meter'
const meter = atom({ plugin: 'article-meter', key: 'meter' } as const, null)

type Setup = { root: string; pattern: string; chosen: string | undefined; markers: string[]; goal: Goal }

// The draft to measure: the one /article named this session, else the newest file matching the `draft` option.
async function findDraft($: any, setup: Setup): Promise<string | undefined> {
  if (setup.chosen !== undefined) return setup.chosen
  if (!setup.pattern.includes('*')) return resolvePath(setup.root, setup.pattern)
  const { dir, name } = splitPattern(setup.root, setup.pattern)
  const found = newestMatch(await $.fs.list(dir).catch(() => []), name)
  return found === undefined ? undefined : `${dir}/${found}`
}

async function measure($: any, setup: Setup): Promise<ArticleMeter> {
  const base = { file: setup.chosen ?? setup.pattern, markers: [], parts: [], focusShare: 0 }
  const path = await findDraft($, setup)
  if (path === undefined) return { ...base, error: `no draft matches ${setup.pattern}; name one with /article <path>` }
  const file = relativeTo(setup.root, path)
  try {
    return { ...base, file, ...measureDraft(await $.fs.read(path), setup.markers, setup.goal.part), error: null }
  } catch (err) {
    return { ...base, file, error: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export const register: Register = (on, options) => {
  const goal: Goal = { part: Number(options.focusPart ?? 3), share: Number(options.focusShare ?? 50) }
  const setup: Setup = {
    root: '',
    pattern: String(options.draft ?? 'docs/*-draft.md').trim() || 'docs/*-draft.md',
    chosen: undefined,
    markers: parseMarkers(options.markers ?? '⟨,TODO'),
    goal,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'article', description: "Show the draft's words per part and the work left (/article <path> picks a file)" })
    setup.root = await $.session.root()
    const found = await measure($, setup)
    await update($, meter, () => found)
    return next(e)
  })

  on('command.run', { command: 'article' }, async ($, e) => {
    if (e.args.trim() !== '') setup.chosen = resolvePath(setup.root, e.args)
    const found = await measure($, setup)
    await update($, meter, () => found)
    // Panes draw only in the terminal and the desktop app; under claude -p the line below is the answer.
    await $.ui.open({ id: PANE, title: 'Draft', focus: true, closeOnEscape: true }).catch(() => undefined)
    return { text: summary(found, goal) }
  })

  // An observer, not a guard: left without .catch on purpose, so a failure here never stops a tool.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const path = (e as { file_path?: unknown }).file_path
    if (ran.deny !== undefined || typeof path !== 'string') return ran
    // MultiEdit is not a tool in every build, so the name is compared as a string.
    if (!['Edit', 'Write', 'MultiEdit'].includes(String(e.tool))) return ran
    const last = await read($, meter)
    // A tool may name the file relative to the project; resolved, it always holds a `/`.
    const full = resolvePath(setup.root, path)
    // The draft in use: the one /article named (it may not exist yet), else the last one measured.
    const target = setup.chosen ?? (last !== null && last.error === null ? resolvePath(setup.root, last.file) : undefined)
    const isCurrent = target !== undefined && samePath(target, full)
    // A new file matching the pattern may now be the newest draft.
    const { dir, name } = splitPattern(setup.root, setup.pattern)
    const cut = full.lastIndexOf('/')
    const isCandidate = setup.chosen === undefined && samePath(full.slice(0, cut), dir) && name.test(full.slice(cut + 1))
    if (isCurrent || isCandidate) {
      const found = await measure($, setup)
      await update($, meter, () => found)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await read($, meter)
    if (now === null) return <Text dimColor>No draft measured yet.</Text>
    if (now.error !== null) return <Text color="error">{now.error}</Text>
    const width = Math.max(10, Math.min(40, e.props.bodyColumns - 22))
    const isShort = now.focusShare * 100 < goal.share
    const isLeft = now.markers.some(m => m.count > 0)
    return (
      <Box flexDirection="column">
        <Text bold>{now.file}</Text>
        <Text>{`Words: ${totalWords(now)} in ${now.parts.length} numbered parts`}</Text>
        {now.markers.length > 0 && <Text color={isLeft ? 'warning' : 'success'}>{`Left: ${markerLine(now)}`}</Text>}
        {goal.part > 0 && (
          <Text color={isShort ? 'warning' : 'success'}>
            {`Part ${goal.part} ${bar(now.focusShare, width, goal.share / 100)} ${Math.round(now.focusShare * 100)}% (line at ${goal.share}%)`}
          </Text>
        )}
        {now.parts.length > 0 && <Text dimColor>{now.parts.map(p => `part ${p.part}: ${p.words}`).join(' · ')}</Text>}
      </Box>
    )
  })
}
