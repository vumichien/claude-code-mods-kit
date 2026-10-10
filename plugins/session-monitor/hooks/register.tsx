import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Beat, State } from '../types'
import { BEAT_MS, STALE_MS, ago, alsoHere, counts, folderName, liveOthers, readBeat, titleOf } from './monitor'
import { STORE_KEY, storedSwitch, switchText, switchWord } from './toggle'

const PANE = 'session-monitor'
// The switch as this session read it (toggle.ts). Off, every hook passes its event on unchanged: no heartbeat is
// written or read and no timer runs. The mod starts off; `/session-monitor on` turns it on for every session.
const enabled = atom({ plugin: 'session-monitor', key: 'enabled' } as const, false)
const others = atom({ plugin: 'session-monitor', key: 'others' } as const, [] as Beat[])
const now = atom({ plugin: 'session-monitor', key: 'now' } as const, 0)
// Whether the list's pane is open, so that the band's button reads List or Hide.
const isOpen = atom({ plugin: 'session-monitor', key: 'isOpen' } as const, false)

// This session as its heartbeat describes it. `base`: working from a turn's start to its end, else done.
// `asking`: the tool calls now waiting for the person (a permission dialog, a question); any makes it waiting.
type Session = {
  id: string
  folder: string
  dir: string
  sessionTitle: unknown
  base: 'working' | 'done'
  asking: Set<string>
  state: State
  since: number
  timer: { cancel: () => void } | undefined
}

const stateOf = (s: Session): State => (s.asking.size > 0 ? 'waiting' : s.base)

// Every session's file sits in one folder under the home directory, one file per session, named by its id.
async function heartbeatDir($: any): Promise<string> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  return `${home.replace(/\\/g, '/')}/.cache/claude-mods/session-monitor`
}

async function writeBeat($: any, s: Session, state: State | 'ended'): Promise<void> {
  const beat: Beat = { v: 1, id: s.id, folder: s.folder, title: titleOf(s.sessionTitle, s.folder), state, since: s.since, updatedAt: await $.clock.now() }
  await $.fs.write(`${s.dir}/${s.id}.json`, JSON.stringify(beat))
}

// Reads the other sessions' files. A file untouched for 90 seconds is not even opened.
async function scan($: any, s: Session): Promise<void> {
  const at = await $.clock.now()
  const entries: { name: string; kind: string; mtimeMs: number }[] = await $.fs.list(s.dir).catch(() => [])
  const beats: Beat[] = []
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || f.name === `${s.id}.json`) continue
    if (f.mtimeMs > 0 && at - f.mtimeMs > STALE_MS) continue
    const beat = readBeat(await $.fs.read(`${s.dir}/${f.name}`).catch(() => ''))
    if (beat !== undefined) beats.push(beat)
  }
  await update($, others, () => liveOthers(beats, s.id, at))
  await update($, now, () => at)
}

async function tick($: any, s: Session): Promise<void> {
  await writeBeat($, s, s.state)
  await scan($, s)
}

// Writes the file when this session's state changes; the timer rewrites it every 15 seconds in any case.
async function refresh($: any, s: Session): Promise<void> {
  const state = stateOf(s)
  if (state === s.state) return
  s.state = state
  s.since = await $.clock.now()
  await writeBeat($, s, state)
}

// Starts the heartbeat: the first write and read now, then every 15 seconds. The timer is returned so that
// `/session-monitor off` and the session's end can stop it.
async function begin($: any, s: Session): Promise<{ cancel: () => void }> {
  s.id = await $.session.id()
  s.folder = await $.session.root()
  s.dir = await heartbeatDir($)
  s.state = stateOf(s)
  s.since = await $.clock.now()
  await tick($, s)
  return $.clock.every(BEAT_MS, () => void tick($, s).catch(() => undefined))
}

// Stops the heartbeat and marks the file ended, in one write: a mod cannot delete a file, so readers skip it.
async function finish($: any, s: Session): Promise<void> {
  s.timer?.cancel()
  s.timer = undefined
  if (s.id !== '') await writeBeat($, s, 'ended')
}

async function openList($: any): Promise<void> {
  // Panes draw only in the terminal and the desktop app; elsewhere the command's line is the answer.
  const opened = await $.ui.open({ id: PANE, title: 'Sessions', closeOnEscape: true }).catch(() => undefined)
  if (opened !== undefined) await update($, isOpen, () => true)
}

async function closeList($: any): Promise<void> {
  await $.ui.close({ id: PANE }).catch(() => undefined)
  await update($, isOpen, () => false)
}

// The engine's record of open panes, not the atom: a pane closed by an unload never told this module.
async function isListUp($: any): Promise<boolean> {
  return (await $.ui.panes().catch(() => [])).some((pane: { id: string }) => pane.id === PANE)
}

// The band's button: a press on an open list closes it, on a closed one opens it.
async function toggleList($: any): Promise<void> {
  if (await isListUp($)) await closeList($)
  else await openList($)
}

function summary(list: readonly Beat[]): string {
  const n = counts(list)
  const parts = (['waiting', 'working', 'done'] as const).filter(k => n[k] > 0).map(k => `${n[k]} ${k}`)
  return parts.length === 0 ? 'no other session open' : `${list.length} other session${list.length === 1 ? '' : 's'}: ${parts.join(' · ')}`
}

export const register: Register = on => {
  const s: Session = { id: '', folder: '', dir: '', sessionTitle: undefined, base: 'done', asking: new Set(), state: 'done', since: 0, timer: undefined }

  on('session.start', async ($, e, next) => {
    // Registered even when the mod is off, so that it can be turned on.
    await $.command
      .register({ name: 'session-monitor', description: 'Switch the session monitor on or off, show its status, or list the other open sessions', argumentHint: '[on|off|status|list]', immediate: true })
      .catch(() => undefined)
    // A reload runs session.start again: the old timer stops before a new one starts.
    s.timer?.cancel()
    s.timer = undefined
    const isOn = storedSwitch(await $.store.get(STORE_KEY).catch(() => undefined), false)
    await update($, enabled, () => isOn)
    // A reload keeps a pane that was up: the band's button starts from the engine's record.
    const isUp = await isListUp($)
    await update($, isOpen, () => isUp)
    if (isOn) s.timer = await begin($, s)
    return next(e)
  })

  on('command.run', { command: 'session-monitor' }, async ($, e) => {
    const isList = (e.args ?? '').trim().toLowerCase() === 'list'
    const word = isList ? 'status' : switchWord(e.args)
    if (word === undefined) return { text: 'use /session-monitor on, off, status or list' }
    if (word === 'status') {
      if (!(await read($, enabled))) return { text: switchText('session-monitor', false) }
      await scan($, s)
      if (isList) await openList($)
      return { text: `${switchText('session-monitor', true)} · ${summary(await read($, others))}` }
    }
    const isOn = word === 'on'
    await $.store.set(STORE_KEY, isOn)
    await update($, enabled, () => isOn)
    if (isOn && s.timer === undefined) s.timer = await begin($, s)
    if (!isOn) {
      await finish($, s)
      await update($, others, () => [])
    }
    return { text: switchText('session-monitor', isOn) }
  })

  // The title Claude Code gives the session rides on these two settings-hook events, when it has one.
  on('classic.SessionStart', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    if (typeof e.session_title === 'string' && e.session_title !== '') s.sessionTitle = e.session_title
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    if (typeof e.session_title === 'string' && e.session_title !== '') s.sessionTitle = e.session_title
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    s.base = 'working'
    await refresh($, s).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!(await read($, enabled)) || e.agentId !== undefined) return next(e)
    s.base = 'done'
    // A question left open by a turn that ended does not keep the session waiting.
    s.asking.clear()
    await refresh($, s).catch(() => undefined)
    return next(e)
  })

  // An ask verdict opens a permission dialog (in auto mode the classifier answers it instead, so it is brief).
  // An observer: the verdict goes back as it came.
  on('tool.check', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      s.asking.add(e.tool_use_id)
      await refresh($, s).catch(() => undefined)
    }
    return verdict
  }).catch(($, e, next) => next(e))

  // The call's own run ends the wait its check opened. A question Claude asks waits for the whole run.
  on('tool.call', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const id = e.tool_use_id
    if (e.tool === 'AskUserQuestion' && id !== undefined) {
      s.asking.add(id)
      await refresh($, s).catch(() => undefined)
    }
    const ran = await next(e)
    if (id !== undefined && s.asking.delete(id)) await refresh($, s).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  // One quick write: the end event has a short budget.
  on('session.end', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    await finish($, s).catch(() => undefined)
    return next(e)
  })

  // A close by the person (Escape, the engine's own close mark or key) turns the band's button back
  // to List; this module's own closes set it themselves. An observer: the close goes on as it came.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    await update($, isOpen, () => false)
    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!(await read($, enabled))) return below
    const list = await read($, others)
    if (e.props.hasSurvey || list.length === 0) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const n = counts(list)
    const rest = (['working', 'done'] as const).filter(k => n[k] > 0).map(k => `${n[k]} ${k}`)
    const here = alsoHere(list, s.folder).slice(0, 3)
    const shown = await read($, isOpen)
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{'other sessions ▸ '}</Text>
          {n.waiting > 0 && <Text color="warning" bold>{`${n.waiting} waiting${rest.length > 0 ? ' · ' : ' '}`}</Text>}
          {rest.length > 0 && <Text dimColor>{`${rest.join(' · ')} `}</Text>}
          <Button key="list" label={shown ? 'Hide' : 'List'} hotkey="s" onPress={() => toggleList($)} />
        </Box>
        {here.map(b => (
          <Text key={`here-${b.id}`} wrap="truncate" {...(b.state === 'waiting' ? { color: 'warning' } : { dimColor: true })}>
            {`also here ▸ "${b.title}" · ${b.state}`}
          </Text>
        ))}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // A desktop draws the dismiss Button as its own close mark at the pane's edge; the terminal as a button.
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => closeList($)} />
    if (!(await read($, enabled))) {
      return (
        <Box>
          <Text dimColor>{`${switchText('session-monitor', false)} `}</Text>
          {close}
        </Box>
      )
    }
    const list = await read($, others)
    const at = await read($, now)
    const here = new Set(alsoHere(list, s.folder).map(b => b.id))
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold wrap="truncate">{`Sessions · ${summary(list)} `}</Text>
          {close}
        </Box>
        {list.map(b => (
          <Text key={`row-${b.id}`} wrap="truncate" {...(b.state === 'waiting' ? { color: 'warning' } : {})}>
            {`${folderName(b.folder)} · "${b.title}" · ${b.state} ${ago(at - b.since)}${here.has(b.id) ? ' · this folder' : ''}`}
          </Text>
        ))}
      </Box>
    )
  })
}
