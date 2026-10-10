import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Idea } from '../types'
import { addIdea, count, editIdea, hideIdea, preview, readShelf, removeIdea, sentIn, shelfKey } from './shelf'
import type { Changed } from './shelf'
import { STORE_KEY, storedSwitch, switchText, switchWord } from './toggle'

const PANE = 'idea-shelf'
// The switch as this session read it (toggle.ts). Off, every hook passes its event on unchanged and /idea parks
// nothing; the ideas stay in the store. The mod starts off; `/idea-shelf on` turns it on for every session.
const enabled = atom({ plugin: 'idea-shelf', key: 'enabled' } as const, false)
const ideas = atom({ plugin: 'idea-shelf', key: 'ideas' } as const, [] as Idea[])
const notice = atom({ plugin: 'idea-shelf', key: 'notice' } as const, null as string | null)
const editing = atom({ plugin: 'idea-shelf', key: 'editing' } as const, null as string | null)

// The project's shelf and what this session knows about the prompt box. `handed`: ideas Send put in the prompt
// box, taken off the shelf once a prompt that carries them is submitted. `isBusy`: a turn of the main loop runs.
type Session = { key: string; handed: Set<string>; isBusy: boolean }

// Reads this project's shelf from the store into the session's state, which the drawings read.
async function load($: any, s: Session): Promise<void> {
  s.key = shelfKey(await $.session.root())
  const list = readShelf(await $.store.get(s.key).catch(() => undefined))
  await update($, ideas, () => list)
}

// Applies a change: the store keeps the shelf past the session, the state redraws the band and the shelf.
async function apply($: any, s: Session, changed: Changed): Promise<string> {
  if ('error' in changed) {
    await update($, notice, () => changed.error)
    return changed.error
  }
  await $.store.set(s.key, changed.ideas)
  await update($, ideas, () => changed.ideas)
  await update($, notice, () => changed.said)
  return changed.said
}

// Sends one idea. With the prompt box empty and Claude idle it goes as a prompt; otherwise it is put in the box,
// after what is already there, and the rest is left to you. Either way it leaves the shelf once it is submitted.
async function send($: any, s: Session, idea: Idea): Promise<void> {
  const box = await $.prompt.read()
  s.handed.add(idea.id)
  if (box.text.trim() === '' && !s.isBusy) {
    await $.prompt.submit({ text: idea.text })
    await apply($, s, removeIdea(await read($, ideas), idea.id))
    await update($, notice, () => 'sent as a prompt')
    return
  }
  const text = box.text.trim() === '' ? idea.text : `${box.text.replace(/\s+$/, '')}\n${idea.text}`
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  await update($, notice, () => (filled.isFilled ? 'put in the prompt box: press Enter there to send it' : 'the prompt box could not take it now'))
}

async function park($: any, s: Session, text: string): Promise<string> {
  return apply($, s, addIdea(await read($, ideas), text, await $.clock.now()))
}

async function change($: any, s: Session, id: string, text: string): Promise<void> {
  await apply($, s, editIdea(await read($, ideas), id, text))
  await update($, editing, () => null)
}

async function drop($: any, s: Session, id: string): Promise<void> {
  await apply($, s, removeIdea(await read($, ideas), id))
}

// A conversation row with every text block passed through hideIdea; the same row when nothing changed.
function withIdeaHidden<E extends { message: { content: { type: string; [field: string]: unknown }[] } }>(e: E): E {
  let isChanged = false
  const content = e.message.content.map(block => {
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    const text = hideIdea(block.text)
    if (text === block.text) return block
    isChanged = true
    return { ...block, text }
  })
  return isChanged ? { ...e, message: { ...e.message, content } } : e
}

async function openShelf($: any): Promise<void> {
  await update($, notice, () => null)
  // Panes draw only in the terminal and the desktop app; elsewhere the command's line is the answer.
  await $.ui.open({ id: PANE, title: 'Idea shelf', focus: true, closeOnEscape: true }).catch(() => undefined)
}

export const register: Register = on => {
  const s: Session = { key: '', handed: new Set(), isBusy: false }

  on('session.start', async ($, e, next) => {
    // Registered even when the mod is off, so that it can be turned on. `immediate`: /idea parks an idea while
    // Claude is working, without waiting for the turn to end and without interrupting it.
    await $.command
      .register({ name: 'idea', description: 'Park an idea for later without interrupting Claude (/idea alone opens the shelf)', argumentHint: '[<idea>|list]', immediate: true })
      .catch(() => undefined)
    await $.command
      .register({ name: 'idea-shelf', description: "Switch the idea shelf on or off, or show how many ideas this project's shelf holds", argumentHint: '[on|off|status]', immediate: true })
      .catch(() => undefined)
    const isOn = storedSwitch(await $.store.get(STORE_KEY).catch(() => undefined), false)
    await update($, enabled, () => isOn)
    if (isOn) await load($, s)
    return next(e)
  })

  on('command.run', { command: 'idea-shelf' }, async ($, e) => {
    const word = switchWord(e.args)
    if (word === undefined) return { text: 'use /idea-shelf on, /idea-shelf off or /idea-shelf status' }
    if (word === 'status') {
      if (!(await read($, enabled))) return { text: switchText('idea-shelf', false) }
      return { text: `${switchText('idea-shelf', true)} · ${count((await read($, ideas)).length)} on this project's shelf` }
    }
    const isOn = word === 'on'
    await $.store.set(STORE_KEY, isOn)
    await update($, enabled, () => isOn)
    if (isOn) await load($, s)
    return { text: switchText('idea-shelf', isOn) }
  })

  // The command's line is part of the conversation, so it says what happened and never repeats the idea.
  on('command.run', { command: 'idea' }, async ($, e) => {
    if (!(await read($, enabled))) return { text: switchText('idea-shelf', false) }
    const text = e.args.trim()
    if (text === '' || text.toLowerCase() === 'list') {
      await openShelf($)
      return { text: `${count((await read($, ideas)).length)} on this project's shelf` }
    }
    return { text: await park($, s, text) }
  })

  // The /idea row in the conversation would carry the idea to the model; it keeps a stand-in instead (shelf.ts).
  // The row is rewritten before it is stored, so neither the model nor the transcript file reads the idea there.
  // If the hook fails, the stand-in still goes in: a failure never lets the idea through.
  on('session.append', { door: 'command' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    return next(withIdeaHidden(e))
  }).catch(($, e, next) => (next.called ? next(e) : next(withIdeaHidden(e))))

  on('turn.start', async ($, e, next) => {
    if (await read($, enabled)) s.isBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) s.isBusy = false
    return next(e)
  })

  // An idea Send put in the prompt box leaves the shelf when the prompt that carries it is submitted.
  on('prompt.submit', async ($, e, next) => {
    if (!(await read($, enabled)) || s.handed.size === 0) return next(e)
    const sent = sentIn(await read($, ideas), s.handed, e.text)
    for (const id of sent) {
      s.handed.delete(id)
      await apply($, s, removeIdea(await read($, ideas), id))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!(await read($, enabled))) return below
    const list = await read($, ideas)
    if (e.props.hasSurvey || list.length === 0) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor wrap="truncate">{`ideas ▸ ${count(list.length)} parked `}</Text>
          <Button key="shelf" label="Shelf" hotkey="i" onPress={() => openShelf($)} />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Mobile draws no text field: there the shelf lists, sends and deletes, and /idea parks.
    const Input = 'Input' in ui ? ui.Input : undefined
    if (!(await read($, enabled))) return <Text dimColor>{switchText('idea-shelf', false)}</Text>
    const list = await read($, ideas)
    const said = await read($, notice)
    const open = await read($, editing)
    const width = Math.max(10, e.props.bodyColumns - 26)
    return (
      <Box flexDirection="column">
        <Text bold>{`Idea shelf · ${count(list.length)} for this project`}</Text>
        {Input !== undefined && (
          <Input key="new" label="New idea: " placeholder="type it, Enter parks it" submitLabel="park" autoFocus onSubmit={(value: string) => void park($, s, value)} />
        )}
        {said !== null && <Text dimColor>{said}</Text>}
        {list.length === 0 && <Text dimColor>Nothing parked yet. /idea text parks one from the prompt, even while Claude works.</Text>}
        {list.map(idea =>
          open === idea.id && Input !== undefined ? (
            <Input key={`text-${idea.id}`} label="Edit: " value={idea.text} submitLabel="save" onSubmit={(value: string) => void change($, s, idea.id, value)} />
          ) : (
            <Box key={`row-${idea.id}`}>
              <Text wrap="truncate">{`${preview(idea.text, width)} `}</Text>
              <Button key={`send-${idea.id}`} label="Send" onPress={() => send($, s, idea)} />
              <Button key={`edit-${idea.id}`} label="Edit" onPress={() => update($, editing, () => idea.id)} />
              <Button key={`delete-${idea.id}`} label="Delete" onPress={() => drop($, s, idea.id)} />
            </Box>
          ),
        )}
      </Box>
    )
  })
}
