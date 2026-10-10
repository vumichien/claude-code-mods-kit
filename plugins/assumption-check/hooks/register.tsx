import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Assumption, Item } from '../types'
import { ASK, CHANGING, RETRY, TIMEOUT_MS, correctionPrompt, costLine, lastTurn, parseAssumptions } from './assume'
import { STORE_KEY, storedSwitch, switchText, switchWord } from './toggle'

const PANE = 'assumption-check'
// The switch as this session read it (toggle.ts). Off, every hook passes its event on unchanged and no turn is
// checked. The mod starts off; `/assumption-check on` turns it on for every session.
const enabled = atom({ plugin: 'assumption-check', key: 'enabled' } as const, false)
const items = atom({ plugin: 'assumption-check', key: 'items' } as const, [] as Item[])
const checking = atom({ plugin: 'assumption-check', key: 'checking' } as const, false)
const notice = atom({ plugin: 'assumption-check', key: 'notice' } as const, null as string | null)
const lastCost = atom({ plugin: 'assumption-check', key: 'lastCost' } as const, null as string | null)
const isFilled = atom({ plugin: 'assumption-check', key: 'isFilled' } as const, false)
const round = atom({ plugin: 'assumption-check', key: 'round' } as const, 0)

// This turn as the hooks saw it. `changed`: calls of the main loop that edited a file or ran a command.
// `isBusy`: a turn of the main loop runs, so nothing is submitted. `notes`: the review's notes by item, kept
// here rather than in the state so that typing does not redraw the box it types into.
type Session = { changed: number; isBusy: boolean; notes: string[] }

// The check: one Haiku call over the last turn, and one retry if the answer is not the JSON asked for. The list
// is the newest checked turn's alone, so the previous one is cleared first.
async function collect($: any, s: Session): Promise<void> {
  await update($, checking, () => true)
  await update($, notice, () => null)
  await update($, items, () => [])
  await update($, isFilled, () => false)
  s.notes = []
  try {
    const turn = lastTurn(await $.session.messages())
    const used = { input_tokens: 0, output_tokens: 0 }
    let found: Assumption[] | undefined
    let calls = 0
    let failed: string | null = null
    for (const ask of [ASK, `${ASK}\n\n${RETRY}`]) {
      calls++
      const answer = await $.model.complete({ model: 'haiku', prompt: `${turn}\n\n---\n${ask}`, maxTokens: 1500, timeoutMs: TIMEOUT_MS })
      if (!answer.isAnswered) {
        failed = answer.reason === 'aborted' ? `no answer within ${TIMEOUT_MS / 1000} s` : `the model call failed (${answer.reason})`
        break
      }
      used.input_tokens += answer.usage.input_tokens
      used.output_tokens += answer.usage.output_tokens
      found = parseAssumptions(answer.text)
      if (found !== undefined) break
    }
    await update($, lastCost, () => costLine(used, calls))
    if (found === undefined) {
      await update($, notice, () => failed ?? "could not read Haiku's answer as a list")
      return
    }
    const list = found
    await update($, items, () => list.map(a => ({ ...a, mark: null, note: '' })))
    // A new list gets new keys, so that no note box keeps the text typed into the previous list's.
    await update($, round, r => r + 1)
    await update($, isFilled, () => false)
  } finally {
    await update($, checking, () => false)
  }
}

async function openReview($: any): Promise<void> {
  // Panes draw only in the terminal and the desktop app; elsewhere the command's line is the answer.
  await $.ui.open({ id: PANE, title: 'Assumptions', focus: true, closeOnEscape: true }).catch(() => undefined)
}

async function mark($: any, n: number, value: 'right' | 'wrong'): Promise<void> {
  await update($, items, list => list.map((i, k) => (k === n ? { ...i, mark: i.mark === value ? null : value } : i)))
}

function noteOn(s: Session, n: number, text: string): void {
  s.notes[n] = text
}

// First press: the corrections go into the prompt box, after any draft there. Second press: they are submitted,
// but never while Claude works (then Enter in the box is the author's to press).
async function sendCorrections($: any, s: Session): Promise<void> {
  if (await read($, isFilled)) {
    if (s.isBusy) {
      await update($, notice, () => 'Claude is working: press Enter in the prompt box when it is done')
      return
    }
    const box = (await $.prompt.read()).text
    if (box.trim() === '') {
      await update($, notice, () => 'the prompt box is empty: nothing to send')
      return
    }
    await $.prompt.fill({ text: '', mode: 'replace' })
    await $.prompt.submit({ text: box, asUser: true })
    await update($, items, () => [])
    await update($, isFilled, () => false)
    await update($, notice, () => 'corrections sent')
    return
  }
  const prompt = correctionPrompt((await read($, items)).map((i, k) => ({ ...i, note: s.notes[k] ?? '' })))
  if (prompt === undefined) {
    await update($, notice, () => 'mark at least one assumption Wrong first')
    return
  }
  const box = (await $.prompt.read()).text
  const filled = await $.prompt.fill({ text: box.trim() === '' ? prompt : `${box.replace(/\s+$/, '')}\n\n${prompt}`, mode: 'replace' })
  await update($, isFilled, () => filled.isFilled)
  await update($, notice, () => (filled.isFilled ? 'the corrections are in the prompt box: press Enter there, or Send here' : 'the prompt box could not take them now'))
}

export const register: Register = on => {
  const s: Session = { changed: 0, isBusy: false, notes: [] }

  on('session.start', async ($, e, next) => {
    // Registered even when the mod is off, so that it can be turned on.
    await $.command
      .register({ name: 'assumption-check', description: "Switch the assumption check on or off, show the last check's cost, or open the review", argumentHint: '[on|off|status|review]', immediate: true })
      .catch(() => undefined)
    const isOn = storedSwitch(await $.store.get(STORE_KEY).catch(() => undefined), false)
    await update($, enabled, () => isOn)
    return next(e)
  })

  on('command.run', { command: 'assumption-check' }, async ($, e) => {
    const isReview = (e.args ?? '').trim().toLowerCase() === 'review'
    const word = isReview ? 'status' : switchWord(e.args)
    if (word === undefined) return { text: 'use /assumption-check on, off, status or review' }
    if (word === 'status') {
      if (!(await read($, enabled))) return { text: switchText('assumption-check', false) }
      if (isReview) await openReview($)
      const n = (await read($, items)).length
      const cost = await read($, lastCost)
      return { text: `${switchText('assumption-check', true)} · ${n} to check${cost === null ? ' · no turn checked yet' : ` · last check: ${cost}`}` }
    }
    const isOn = word === 'on'
    await $.store.set(STORE_KEY, isOn)
    await update($, enabled, () => isOn)
    return { text: switchText('assumption-check', isOn) }
  })

  on('turn.start', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    s.changed = 0
    s.isBusy = true
    await update($, notice, () => null)
    return next(e)
  })

  // An observer: counts the main loop's calls that changed something; the result goes back as it came.
  on('tool.call', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const ran = await next(e)
    if (e.agentId === undefined && CHANGING.includes(String(e.tool)) && ran.deny === undefined) s.changed++
    return ran
  }).catch(($, e, next) => next(e))

  // At most one check per turn, and none for a turn that only read or was interrupted. It runs after the turn
  // has ended, so the turn never waits for it.
  on('turn.complete', async ($, e, next) => {
    if (!(await read($, enabled)) || e.agentId !== undefined) return next(e)
    const done = await next(e)
    s.isBusy = false
    const isChecked = s.changed > 0 && !e.isAborted
    s.changed = 0
    if (isChecked) $.clock.after(0, () => void collect($, s).catch(() => undefined))
    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!(await read($, enabled)) || e.props.hasSurvey) return below
    const list = await read($, items)
    const busy = await read($, checking)
    const said = await read($, notice)
    if (!busy && list.length === 0 && said === null) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const open = list.filter(i => i.mark === null).length
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor wrap="truncate">
            {busy ? 'assumptions ▸ checking the last turn… ' : list.length > 0 ? `assumptions ▸ ${open} to check ` : `assumptions ▸ ${said} `}
          </Text>
          {list.length > 0 && <Button key="review" label="Review" hotkey="a" onPress={() => openReview($)} />}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Mobile draws no text field: there the review marks and sends, without notes.
    const Input = 'Input' in ui ? ui.Input : undefined
    if (!(await read($, enabled))) return <Text dimColor>{switchText('assumption-check', false)}</Text>
    const list = await read($, items)
    const said = await read($, notice)
    const filled = await read($, isFilled)
    const r = await read($, round)
    return (
      <Box flexDirection="column">
        <Text bold>{`Assumptions in the last turn · ${list.length}`}</Text>
        {/* At the top, so that a list taller than the pane never hides it. */}
        {list.length > 0 && (
          <Box>
            <Button key="send" label={filled ? 'Send' : 'Send corrections'} onPress={() => sendCorrections($, s)} />
            {said !== null && <Text dimColor wrap="truncate">{` ${said}`}</Text>}
          </Box>
        )}
        {list.length === 0 && said !== null && <Text dimColor>{said}</Text>}
        {list.length === 0 && <Text dimColor>Nothing to check. After a turn that edits files or runs commands, the list appears here.</Text>}
        {list.map((item, n) => (
          <Box key={`item-${r}-${n}`} flexDirection="column">
            <Text {...(item.mark === 'wrong' ? { color: 'error' } : item.mark === 'right' ? { color: 'success' } : {})}>
              {`${n + 1}. ${item.claim}${item.mark !== null ? ` [${item.mark}]` : ''}`}
            </Text>
            {(item.where !== '' || item.why !== '') && <Text dimColor wrap="truncate">{`   ${[item.where, item.why].filter(Boolean).join(' · ')}`}</Text>}
            <Box>
              <Button key={`right-${r}-${n}`} label="Right" onPress={() => mark($, n, 'right')} />
              <Button key={`wrong-${r}-${n}`} label="Wrong" onPress={() => mark($, n, 'wrong')} />
              {Input !== undefined && (
                <Input
                  key={`note-${r}-${n}`}
                  label=" Note: "
                  placeholder="what it should be"
                  submitLabel="keep"
                  onInput={(value: string) => noteOn(s, n, value)}
                  onSubmit={(value: string) => noteOn(s, n, value)}
                />
              )}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
