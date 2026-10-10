// session-monitor's pure parts: the heartbeat file each session writes, and what a session reads from the others'.
import type { Beat, State } from '../types'

// A session rewrites its file at every change of state and every 15 seconds. A file not rewritten for 90 seconds
// belongs to a session that is gone (killed, or closed without its last write), and readers skip it.
export const BEAT_MS = 15_000
export const STALE_MS = 90_000
export const MAX_TITLE = 60

const STATES: readonly string[] = ['working', 'waiting', 'done', 'ended']
const ORDER: Record<State, number> = { waiting: 0, working: 1, done: 2 }

// Two spellings of one folder match: a Windows path is compared without regard to case or separator.
export function folderKey(path: string): string {
  const clean = path.split('\\').join('/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(clean) ? clean.toLowerCase() : clean
}

export function folderName(path: string): string {
  const clean = path.split('\\').join('/').replace(/\/+$/, '')
  return clean.slice(clean.lastIndexOf('/') + 1) || clean
}

// The title Claude Code gave the session, else the folder's name: never the text of a prompt.
export function titleOf(sessionTitle: unknown, folder: string): string {
  const given = typeof sessionTitle === 'string' ? sessionTitle.replace(/\s+/g, ' ').trim() : ''
  const text = given !== '' ? given : folderName(folder)
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text
}

// One heartbeat file's text as a Beat; anything else (half written, hand edited, another program's) is skipped.
export function readBeat(text: string): Beat | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const b = value as Record<string, unknown>
  const isBeat =
    b.v === 1 &&
    typeof b.id === 'string' &&
    typeof b.folder === 'string' &&
    typeof b.title === 'string' &&
    typeof b.state === 'string' &&
    STATES.includes(b.state) &&
    typeof b.since === 'number' &&
    typeof b.updatedAt === 'number'
  return isBeat ? (b as unknown as Beat) : undefined
}

// The other sessions still open: not this one, not ended, written within the last 90 seconds. Waiting first.
export function liveOthers(beats: readonly Beat[], selfId: string, now: number): Beat[] {
  return beats
    .filter((b): b is Beat & { state: State } => b.id !== selfId && b.state !== 'ended' && now - b.updatedAt <= STALE_MS)
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.updatedAt - a.updatedAt)
}

export function counts(others: readonly Beat[]): Record<State, number> {
  const n: Record<State, number> = { waiting: 0, working: 0, done: 0 }
  for (const b of others) if (b.state !== 'ended') n[b.state]++
  return n
}

export function alsoHere(others: readonly Beat[], folder: string): Beat[] {
  const key = folderKey(folder)
  return others.filter(b => folderKey(b.folder) === key)
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}
