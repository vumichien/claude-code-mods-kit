import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { TIMEOUT_MS, buildPrompt, costLine, refusal, rewriteOf } from './enhance'
import { STORE_KEY, storedSwitch, switchText, switchWord } from './toggle'

// The switch as this session read it (toggle.ts). Off, the band is not drawn and nothing reads the draft or calls
// the model. The mod starts off; `/prompt-enhancer on` turns it on for every session.
const enabled = atom({ plugin: 'prompt-enhancer', key: 'enabled' } as const, false)
const isBusy = atom({ plugin: 'prompt-enhancer', key: 'isBusy' } as const, false)
const note = atom({ plugin: 'prompt-enhancer', key: 'note' } as const, null as string | null)
const lastCost = atom({ plugin: 'prompt-enhancer', key: 'lastCost' } as const, null as string | null)

// Enhance: one Haiku call over the draft, the session's skills and commands, and the top of CLAUDE.md. The rewrite
// replaces the draft in the prompt box and is never submitted. A command cannot read the draft (running one empties
// the box first), so this is a button only.
async function enhance($: any): Promise<void> {
  if (await read($, isBusy)) return
  const draft = (await $.prompt.read()).text
  const refused = refusal(draft)
  if (refused !== undefined) {
    await update($, note, () => refused)
    return
  }
  await update($, isBusy, () => true)
  await update($, note, () => 'Haiku is rewriting the draft…')
  try {
    const commands = await $.command.list().catch(() => [])
    const root = await $.session.root()
    const claudeMd = await $.fs.read(`${root}/CLAUDE.md`).catch(() => '')
    const answer = await $.model.complete({ model: 'haiku', prompt: buildPrompt(draft, commands, typeof claudeMd === 'string' ? claudeMd : ''), maxTokens: 1200, timeoutMs: TIMEOUT_MS })
    if (!answer.isAnswered) {
      const why = answer.reason === 'aborted' ? `no answer within ${TIMEOUT_MS / 1000} s` : answer.reason === 'empty-reply' ? 'the model answered nothing' : `the model call failed (${answer.status ?? 'no response'})`
      await update($, note, () => `${why}; the draft is unchanged`)
      return
    }
    const cost = costLine(answer.usage)
    await update($, lastCost, () => cost)
    // A draft edited while Haiku worked is the author's newer word: it is kept, not overwritten.
    if ((await $.prompt.read()).text !== draft) {
      await update($, note, () => `the draft changed while Haiku worked, so it was kept; press Enhance again · ${cost}`)
      return
    }
    const filled = await $.prompt.fill({ text: rewriteOf(answer.text), mode: 'replace' })
    await update($, note, () => (filled.isFilled ? `rewritten · ${cost}. Edit it, then Send or Enter` : `the prompt box could not take the rewrite now · ${cost}`))
  } finally {
    await update($, isBusy, () => false)
  }
}

// Send: the draft as it stands goes as the author's own prompt, and the box is emptied.
async function send($: any): Promise<void> {
  const draft = (await $.prompt.read()).text
  if (draft.trim() === '') {
    await update($, note, () => 'nothing to send')
    return
  }
  await $.prompt.fill({ text: '', mode: 'replace' })
  await $.prompt.submit({ text: draft, asUser: true })
  await update($, note, () => null)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Registered even when the mod is off, so that it can be turned on.
    await $.command
      .register({ name: 'prompt-enhancer', description: 'Switch the Enhance band on or off, or show what the last rewrite cost', argumentHint: '[on|off|status]', immediate: true })
      .catch(() => undefined)
    const isOn = storedSwitch(await $.store.get(STORE_KEY).catch(() => undefined), false)
    await update($, enabled, () => isOn)
    return next(e)
  })

  on('command.run', { command: 'prompt-enhancer' }, async ($, e) => {
    const word = switchWord(e.args)
    if (word === undefined) return { text: 'use /prompt-enhancer on, /prompt-enhancer off or /prompt-enhancer status' }
    if (word === 'status') {
      if (!(await read($, enabled))) return { text: switchText('prompt-enhancer', false) }
      const cost = await read($, lastCost)
      return { text: `${switchText('prompt-enhancer', true)} · ${cost === null ? 'no rewrite yet this session' : `last rewrite: ${cost}`}` }
    }
    const isOn = word === 'on'
    await $.store.set(STORE_KEY, isOn)
    await update($, enabled, () => isOn)
    return { text: switchText('prompt-enhancer', isOn) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!(await read($, enabled)) || e.props.hasSurvey) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const busy = await read($, isBusy)
    const said = await read($, note)
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{'prompt ▸ '}</Text>
          <Button key="enhance" label={busy ? 'Enhancing…' : 'Enhance'} hotkey="e" onPress={() => enhance($)} />
          <Button key="send" label="Send" hotkey="n" onPress={() => send($)} />
          {said !== null && <Text dimColor wrap="truncate">{` ${said}`}</Text>}
        </Box>
        {below}
      </Box>
    )
  })
}
