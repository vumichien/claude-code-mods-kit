// Pure helpers for article-meter: find the draft and measure it.

import type { ArticleMeter, MarkerCount, PartCount } from '../types'

export type Goal = { part: number; share: number }

export function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(path)
}

// Forward slashes, `.` and `..` segments applied, case kept.
export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 1) out.pop()
    else if (part !== '..') out.push(part)
  }
  return out.join('/')
}

// A path the person gave, relative to the project unless absolute, normalized.
export function resolvePath(root: string, path: string): string {
  const clean = path.trim()
  return normalize(isAbsolute(clean) ? clean : `${root}/${clean}`)
}

// `docs/*-draft.md` → the folder to list and a test for the file name (`*` matches any run of characters).
export function splitPattern(root: string, pattern: string): { dir: string; name: RegExp } {
  const full = resolvePath(root, pattern)
  const cut = full.lastIndexOf('/')
  const escaped = full.slice(cut + 1).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return { dir: full.slice(0, cut), name: new RegExp(`^${escaped}$`, 'i') }
}

// The newest regular file whose name matches.
export function newestMatch(entries: { name: string; kind: string; mtimeMs: number }[], name: RegExp): string | undefined {
  return entries
    .filter(e => e.kind === 'file' && name.test(e.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name
}

// The path relative to the project when it lies inside it; both are normalized first, so the slice lines up.
export function relativeTo(root: string, path: string): string {
  const base = normalize(root)
  const full = normalize(path)
  return full.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? full.slice(base.length + 1) : full
}

// A path as Windows resolves it: either separator, any case, `.` and `..` segments applied.
export function canonicalPath(path: string): string {
  return normalize(path).toLowerCase()
}

export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b)
}

export function parseMarkers(option: unknown): string[] {
  return String(option ?? '').split(',').map(m => m.trim()).filter(Boolean)
}

// A table's delimiter row: cells of dashes (optionally with colons), separated by pipes.
const DELIMITER = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/

// The lines that belong to a Markdown table, with or without leading pipes: any line starting with a pipe, and a
// header row, its delimiter row and the body rows under it until a line without a pipe.
function tableLines(lines: readonly string[]): Set<number> {
  const out = new Set<number>()
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('|')) out.add(i)
    if (!trimmed.includes('|') || !DELIMITER.test(trimmed) || !(lines[i - 1] ?? '').includes('|')) return
    out.add(i - 1)
    for (let j = i; j < lines.length && (lines[j] ?? '').includes('|'); j++) out.add(j)
  })
  return out
}

function words(line: string): number {
  return line.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length
}

// Marker counts outside HTML comments, and words per numbered part outside fences, tables, images and headings.
export function measureDraft(text: string, markers: string[], focusPart: number): Pick<ArticleMeter, 'markers' | 'parts' | 'focusShare'> {
  const body = text.replace(/<!--[\s\S]*?-->/g, '')
  const counts: MarkerCount[] = markers.map(marker => ({ marker, count: body.split(marker).length - 1 }))
  const parts: PartCount[] = []
  const lines = body.split(/\r?\n/)
  const inTable = tableLines(lines)
  // The open fence's marker: a fence closes only on the same character, at least as long, with nothing after.
  let fence: string | undefined
  let current: PartCount | undefined
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1]
    if (marker !== undefined) {
      if (fence === undefined) {
        fence = marker
        continue
      }
      if (marker[0] === fence[0] && marker.length >= fence.length && trimmed === marker) {
        fence = undefined
        continue
      }
    }
    if (fence !== undefined) continue
    const heading = /^##\s+(\d+)\.\s/.exec(trimmed)
    if (heading !== null) {
      current = { part: Number(heading[1]), words: 0 }
      parts.push(current)
      continue
    }
    if (/^##\s/.test(trimmed)) {
      current = undefined
      continue
    }
    if (current === undefined || inTable.has(index) || trimmed.startsWith('![') || trimmed.startsWith('#')) continue
    current.words += words(trimmed)
  }
  const total = parts.reduce((sum, p) => sum + p.words, 0)
  const focus = parts.find(p => p.part === focusPart)?.words ?? 0
  return { markers: counts, parts, focusShare: total === 0 ? 0 : focus / total }
}

export function totalWords(meter: ArticleMeter): number {
  return meter.parts.reduce((sum, p) => sum + p.words, 0)
}

export function markerLine(meter: ArticleMeter): string {
  return meter.markers.map(m => `${m.marker} ${m.count}`).join(' · ')
}

export function summary(meter: ArticleMeter, goal: Goal): string {
  if (meter.error !== null) return meter.error
  const pieces = [meter.file, `${totalWords(meter)} words in ${meter.parts.length} numbered parts`]
  if (goal.part > 0) pieces.push(`part ${goal.part} ${Math.round(meter.focusShare * 100)}% (needs ${goal.share}%)`)
  if (meter.markers.length > 0) pieces.push(`left: ${markerLine(meter)}`)
  return pieces.join(' · ')
}

export function bar(share: number, width: number, line: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, share)) * width)
  const drawn = '█'.repeat(filled) + '░'.repeat(width - filled)
  const at = Math.min(width, Math.max(0, Math.round(line * width)))
  return `${drawn.slice(0, at)}│${drawn.slice(at)}`
}
