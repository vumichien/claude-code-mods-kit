// assumption-check's pure parts: which turns are checked, what Haiku reads and is asked, how its answer is read,
// and the prompt the author's corrections become.
import type { Assumption, Item } from '../types'

// A turn that changed something: it edited a file or ran a command. A turn that only read is not checked.
export const CHANGING: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']
export const MAX_ITEMS = 8
export const TIMEOUT_MS = 60_000
const INPUT_CHARS = 1500
const TURN_CHARS = 30_000

export const ASK =
  'List the assumptions made in the last turn that the user did not state: choices of format, library, behaviour, naming, defaults, error handling, time zone or scope. Answer with JSON only, no prose: [{"claim": "...", "where": "file or command", "why": "why it was chosen"}], at most 8, most consequential first; [] if there are none.'
export const RETRY = 'Your last answer was not valid JSON. Answer again with the JSON array only.'

type Message = { role: string; text: string; toolUses?: readonly { tool: string; input: unknown }[] }

// The last turn as text: from the author's last prompt to the end, each tool call with its input cut short.
// A long turn keeps its end, where the answer and the last edits are.
export function lastTurn(messages: readonly Message[]): string {
  let start = messages.length - 1
  while (start > 0 && !(messages[start]!.role === 'user' && messages[start]!.text !== '')) start--
  const text = messages
    .slice(Math.max(0, start))
    .map(m => {
      const uses = (m.toolUses ?? []).map(u => `[${u.tool}] ${JSON.stringify(u.input).slice(0, INPUT_CHARS)}`).join('\n')
      return `${m.role.toUpperCase()}: ${m.text}${uses ? `\n${uses}` : ''}`
    })
    .join('\n\n')
  return text.length > TURN_CHARS ? `…${text.slice(-TURN_CHARS)}` : text
}

// Haiku's answer as a list, or undefined when it is not the JSON asked for. Prose or a code fence around the
// array is tolerated; items without a claim are dropped; at most 8 are kept.
export function parseAssumptions(reply: string): Assumption[] | undefined {
  const from = reply.indexOf('[')
  const to = reply.lastIndexOf(']')
  if (from < 0 || to < from) return undefined
  let value: unknown
  try {
    value = JSON.parse(reply.slice(from, to + 1))
  } catch {
    return undefined
  }
  if (!Array.isArray(value)) return undefined
  const text = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
  return value
    .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object' && text((v as any).claim) !== '')
    .slice(0, MAX_ITEMS)
    .map(v => ({ claim: text(v.claim), where: text(v.where), why: text(v.why) }))
}

// The prompt the review becomes: the wrong ones with the author's notes, to be changed, and the right ones, to be
// kept. Undefined when nothing was marked wrong.
export function correctionPrompt(items: readonly Item[]): string | undefined {
  const wrong = items.filter(i => i.mark === 'wrong')
  if (wrong.length === 0) return undefined
  const right = items.filter(i => i.mark === 'right')
  const what = (i: Item) => `${i.claim}${i.where !== '' ? ` (${i.where})` : ''}`
  // "You assumed" keeps the claim from reading as the request itself.
  const fix = (i: Item, n: number) => `${n + 1}. You assumed: ${what(i)}. That is wrong${i.note.trim() !== '' ? `: ${i.note.trim()}` : '.'}`
  const parts = [`Some choices in your last turn were wrong. Change only these:\n${wrong.map(fix).join('\n')}`]
  if (right.length > 0) parts.push(`These were right; keep them as they are:\n${right.map((i, n) => `${n + 1}. ${what(i)}`).join('\n')}`)
  parts.push('Leave everything else unchanged.')
  return parts.join('\n\n')
}

export type Usage = { input_tokens: number; output_tokens: number }

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export function costLine(usage: Usage, calls: number): string {
  return `${thousands(usage.input_tokens)} in · ${thousands(usage.output_tokens)} out tokens (haiku${calls > 1 ? `, ${calls} calls` : ''})`
}
