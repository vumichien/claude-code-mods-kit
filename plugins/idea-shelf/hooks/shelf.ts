// The idea shelf's pure parts: one list of ideas per project, kept in the plugin's store, with limits on how
// many ideas and how long each may be.
import type { Idea } from '../types'

export const MAX_IDEAS = 200
export const MAX_CHARS = 2000

// The store is one per plugin, shared by every folder, so a project's shelf lives under a key made from the
// project's root folder. A Windows path is compared without regard to case or separator.
export function shelfKey(root: string): string {
  const path = root.split('\\').join('/').replace(/\/+$/, '')
  return `shelf:${/^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path}`
}

// What the store holds, as a list of ideas; anything else (nothing yet, a hand-edited file) is an empty shelf.
export function readShelf(value: unknown): Idea[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (i): i is Idea => i !== null && typeof i === 'object' && typeof i.id === 'string' && typeof i.text === 'string' && typeof i.at === 'number',
  )
}

// A shelf after a change, or why the change was refused.
export type Changed = { ideas: Idea[]; said: string } | { error: string }

export function addIdea(ideas: readonly Idea[], text: string, at: number): Changed {
  const clean = text.trim()
  if (clean === '') return { error: 'nothing to park: type the idea after /idea, or in the shelf' }
  if (clean.length > MAX_CHARS) return { error: `too long to park: ${clean.length} characters, at most ${MAX_CHARS}` }
  if (ideas.length >= MAX_IDEAS) return { error: `the shelf holds ${MAX_IDEAS} ideas; send or delete one first` }
  // Unique within the shelf even when two ideas are parked in the same millisecond.
  let n = ideas.length
  while (ideas.some(i => i.id === `${at}-${n}`)) n++
  const list = [...ideas, { id: `${at}-${n}`, text: clean, at }]
  return { ideas: list, said: `parked (${list.length} on the shelf)` }
}

export function editIdea(ideas: readonly Idea[], id: string, text: string): Changed {
  const clean = text.trim()
  if (clean === '') return removeIdea(ideas, id)
  if (clean.length > MAX_CHARS) return { error: `too long: ${clean.length} characters, at most ${MAX_CHARS}` }
  if (!ideas.some(i => i.id === id)) return { error: 'that idea is no longer on the shelf' }
  return { ideas: ideas.map(i => (i.id === id ? { ...i, text: clean } : i)), said: 'idea changed' }
}

export function removeIdea(ideas: readonly Idea[], id: string): Changed {
  const list = ideas.filter(i => i.id !== id)
  return { ideas: list, said: list.length === ideas.length ? 'that idea is no longer on the shelf' : `deleted (${list.length} on the shelf)` }
}

// The ideas a submitted prompt carried: those Send put in the prompt box whose whole text is in the prompt.
export function sentIn(ideas: readonly Idea[], handed: ReadonlySet<string>, prompt: string): string[] {
  return ideas.filter(i => handed.has(i.id) && prompt.includes(i.text)).map(i => i.id)
}

// The first line of an idea, cut to fit a row.
export function preview(text: string, width: number): string {
  const first = text.split('\n')[0] ?? ''
  const room = Math.max(8, width)
  const line = first.length > room ? `${first.slice(0, room - 1)}…` : first
  return text.includes('\n') && line === first ? `${line} …` : line
}

export const count = (n: number) => `${n} idea${n === 1 ? '' : 's'}`

// The row a slash command leaves in the conversation names the command and what was typed after it, and the
// model reads that row. For /idea that is the idea itself, so the shelf puts a stand-in there: the model reads
// that an idea was parked, never which. /idea alone and /idea list carry no idea and stay as typed.
export const KEPT_ARGS = '(an idea, kept on the shelf)'
const IDEA_ROW = /<command-name>\/(?:[\w-]+:)?idea<\/command-name>/
const ARGS = /<command-args>([\s\S]*?)<\/command-args>/

export function hideIdea(text: string): string {
  if (!IDEA_ROW.test(text)) return text
  return text.replace(ARGS, (whole, args: string) => {
    const typed = args.trim().toLowerCase()
    return typed === '' || typed === 'list' ? whole : `<command-args>${KEPT_ARGS}</command-args>`
  })
}
