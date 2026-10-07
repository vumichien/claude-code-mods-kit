// Pure helpers for plan-meter: read a plan file in any of the formats it knows, and say how far along it is.

import type { Count, PlanMeter, Status } from '../types'

export type Item = { text: string; status: Status }
export type Parsed = {
  title: string | null
  // The plan's own status line (frontmatter `status:`, `**Status:** …`, `Status (date): …`), as written.
  planStatus: string | null
  // Phases: rows of a table with a status column, or headings that carry a status or are named Phase/Step/….
  // `said` is false when the plan gives no status the parser knows, so a linked phase file may supply one.
  phases: (Item & { link: string | null; said: boolean })[]
  // Steps: checklist items, org-mode TODO/DONE headlines, todo.txt lines.
  steps: Item[]
  // Relative links to phase files (`phase-*.md`, `step-*.md`, …), to read their steps too.
  links: string[]
  // Which formats were found, for the pane and the README's list.
  formats: string[]
}

// Status words in English, Vietnamese and Japanese, and the usual marks. The earliest match in a text wins,
// so "Done (pending review)" is done and "Not started" is to do.
const STATUS_WORDS: [Status, RegExp][] = [
  ['todo', /\b(not (started|done|yet)|incomplete|unfinished|to-?do|to do|pending|planned|backlog|queued|open)\b|chưa( làm| xong)?|未着手|⬜|☐|\[ \]/i],
  ['dropped', /\b(cancel+ed|dropped|won'?t (do|fix)|wontfix|skipped|obsolete|abandoned|n\/a)\b|hủy|bỏ qua|中止|🚫/i],
  ['done', /\b(done|complete[d]?|finished|shipped|merged|closed|resolved|delivered|passed)\b|xong|hoàn thành|完了|✅|✔|☑|✓|\[x\]/i],
  ['active', /\b(in[-_ ]?progress|wip|doing|ongoing|active|started|running|in review|reviewing|blocked)\b|đang( làm)?|進行中|🚧|🔄|⏳|▶/i],
]

export function classify(text: string): Status | undefined {
  let best: { status: Status; at: number } | undefined
  for (const [status, pattern] of STATUS_WORDS) {
    const found = pattern.exec(text)
    if (found !== null && (best === undefined || found.index < best.at)) best = { status, at: found.index }
  }
  return best?.status
}

// `[x]` and its cousins: GitHub's x, Obsidian's / (doing), - (cancelled), > (deferred).
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX/~\-><!?])\]\s+(.*)$/
const CHECK_MARKS: Record<string, Status> = { x: 'done', X: 'done', '/': 'active', '~': 'active', '-': 'dropped' }
const ORG_HEADLINE = /^\*+\s+(TODO|NEXT|DOING|IN-PROGRESS|STARTED|WAITING|HOLD|DONE|CANCELL?ED)\s+(.*)$/
const ORG_STATUS: Record<string, Status> = { DONE: 'done', CANCELLED: 'dropped', CANCELED: 'dropped', DOING: 'active', 'IN-PROGRESS': 'active', STARTED: 'active', WAITING: 'active', HOLD: 'active' }
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
// A heading named like a phase: "Phase 2", "Step 3:", "Milestone IV", "Giai đoạn 1", "フェーズ1".
const PHASE_NAME = /^(?:\d+[.)]\s*)?(phase|step|stage|milestone|sprint|part|task|giai đoạn|bước|フェーズ)\s*[\dIVX]+\b/i
// A heading's own status: a mark anywhere, or a status set off at its end: "(done)", "[WIP]", "— done", ": in progress".
const HEADING_MARK = /[✅✔☑✓🚧🔄⏳⬜☐🚫]/u
const STATUS_ALONE = /^(done|complete[d]?|finished|in[-_ ]?progress|wip|doing|todo|to-?do|pending|blocked|skipped|cancel+ed|dropped|xong|hoàn thành|đang làm|chưa làm|完了|進行中|未着手)$/i
// Where a status sits at a heading's end, tried in this order: "(done)" or "[done]", "— done", ": done".
const HEADING_TAILS = [/\s*[([]\s*([^)\]]+?)\s*[)\]]\s*$/, /\s+[—–|-]\s+([^—–|]+?)\s*$/, /:\s+([^:]+?)\s*$/]
const MARKS = /\s*[✅✔☑✓🚧🔄⏳⬜☐🚫]+\s*/gu

// A heading's status and its name without a status word at the end.
// A heading named like a phase takes any status word in its tail; another heading only a tail that is a status alone,
// so "## Phase 2: Draft (in progress)" carries a status and "## Decisions (closed 2026-09-27)" does not.
function headingStatus(words: string, named: boolean): { status: Status | undefined; name: string } {
  const mark = HEADING_MARK.exec(words)
  for (const tail of HEADING_TAILS) {
    const found = tail.exec(words)
    const said = (found?.[1] ?? '').replace(MARKS, ' ').trim()
    if (found === null || said === '') continue
    const alone = STATUS_ALONE.test(said)
    const status = alone || named ? classify(said) : undefined
    if (status === undefined) continue
    return { status: mark !== null ? classify(mark[0]) : status, name: (alone ? words.slice(0, found.index) : words).replace(MARKS, ' ').trim() }
  }
  return { status: mark !== null ? classify(mark[0]) : undefined, name: words.replace(MARKS, ' ').trim() }
}
const STATUS_HEADER = /^(status|state|progress|done\??|trạng thái|tình trạng|ステータス|状態)$/i
// Name columns, most telling first: a "Phase" column often holds only the number.
const NAME_HEADERS = [/^(name|title|task|item|what|tên|công việc|deliverable)$/i, /^(phase|step|milestone|stage|giai đoạn)$/i]
const DELIMITER = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/
const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g
// A phase file's name: `phase-01-schema.md`, `phase1.md`, `steps.md`, `part_2.md`; not `department.md`.
const PHASE_FILE = /(^|\/)(phase|step|stage|milestone|sprint|part|task)s?([-_ ]?\d[^/]*|[-_ ][^/]*)?\.md$/i

// Plain text of a cell or line: links to their text, emphasis and code marks dropped.
export function plain(text: string): string {
  return text.replace(MD_LINK, '$1').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim()
}

// A table row's cells; `\|` is a pipe inside a cell, not a border.
function cells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim())
}

// Links to phase files, without any `#section` part.
function phaseLinks(text: string): string[] {
  return [...text.matchAll(MD_LINK)].map(m => (m[2] ?? '').split('#')[0] ?? '').filter(href => href !== '' && !/^[a-z]+:/i.test(href) && PHASE_FILE.test(href))
}

export function parsePlan(text: string, fileName: string): Parsed {
  const out: Parsed = { title: null, planStatus: null, phases: [], steps: [], links: [], formats: [] }
  const found = new Set<string>()
  let lines = text.split(/\r?\n/)

  // YAML frontmatter: title and status.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const kv = /^(title|status):\s*["']?(.*?)["']?\s*$/i.exec(line)
        if (kv?.[1]?.toLowerCase() === 'title') out.title = kv[2] || null
        if (kv?.[1]?.toLowerCase() === 'status') out.planStatus = kv[2] || null
      }
      found.add('frontmatter')
      lines = lines.slice(end + 1)
    }
  }

  // todo.txt: one task per line, `x ` marks it done.
  if (/(^|[\\/])([^\\/]*\.)?todo\.txt$/i.test(fileName)) {
    for (const line of lines.map(l => l.trim()).filter(Boolean)) out.steps.push({ text: line.replace(/^x\s+(\d{4}-\d\d-\d\d\s+)*/, ''), status: line.startsWith('x ') ? 'done' : 'todo' })
    out.formats.push('todo.txt')
    return out
  }

  let fence: string | undefined
  let tableStatus = -1
  let tableName = -1
  // Heading phases with no status of their own take it from the checklist beneath them.
  const headingPhases: (Item & { link: string | null; level: number; from: number; to: number; own: boolean })[] = []
  const close = (level: number) => {
    for (const h of headingPhases) if (h.to < 0 && h.level >= level) h.to = out.steps.length
  }
  for (const [i, raw] of lines.entries()) {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1]
    if (marker !== undefined) {
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && trimmed === marker) fence = undefined
      continue
    }
    if (fence !== undefined) continue

    const box = CHECKBOX.exec(line)
    if (box !== null) {
      out.steps.push({ text: plain(box[2] ?? ''), status: CHECK_MARKS[box[1] ?? ' '] ?? 'todo' })
      found.add('checklist')
      out.links.push(...phaseLinks(line))
      continue
    }

    const org = ORG_HEADLINE.exec(line)
    if (org !== null) {
      out.steps.push({ text: plain(org[2] ?? ''), status: ORG_STATUS[org[1] ?? ''] ?? 'todo' })
      found.add('org-mode')
      continue
    }

    // A table: its header row is the line above a delimiter row.
    if (trimmed.includes('|') && DELIMITER.test(trimmed) && (lines[i - 1] ?? '').includes('|')) {
      const header = cells(lines[i - 1] ?? '').map(plain)
      tableStatus = header.findIndex(h => STATUS_HEADER.test(h))
      tableName = NAME_HEADERS.map(re => header.findIndex(h => re.test(h))).find(at => at >= 0) ?? -1
      continue
    }
    if (tableStatus >= 0 && trimmed.includes('|')) {
      const row = cells(trimmed)
      const named = plain(row[tableName] ?? '')
      // A number alone names nothing: take the first other cell with words in it.
      const name = named !== '' && !/^\d+$/.test(named) ? named : plain(row.find((c, at) => at !== tableStatus && !/^\d*$/.test(plain(c))) ?? '')
      const links = phaseLinks(trimmed)
      const said = classify(plain(row[tableStatus] ?? ''))
      out.phases.push({ text: name, status: said ?? 'todo', link: links[0] ?? null, said: said !== undefined })
      out.links.push(...links)
      found.add('status table')
      continue
    }
    if (!trimmed.includes('|')) tableStatus = -1

    const heading = HEADING.exec(trimmed)
    if (heading !== null) {
      const words = plain(heading[2] ?? '')
      if (out.title === null && heading[1] === '#') out.title = words.replace(/^(plan|kế hoạch)\s*[:—-]\s*/i, '') || null
      const level = heading[1]?.length ?? 1
      close(level)
      const named = PHASE_NAME.test(words)
      const { status, name } = headingStatus(words, named)
      if (level > 1 && !/^status\b/i.test(words) && (status !== undefined || named)) {
        headingPhases.push({ text: name, status: status ?? 'todo', link: phaseLinks(trimmed)[0] ?? null, level, from: out.steps.length, to: -1, own: status !== undefined })
      }
      out.links.push(...phaseLinks(trimmed))
      continue
    }

    // A status line in the body: `**Status:** done`, `Status (2026-10-07): Draft`.
    const statusLine = /^status\b(?:\s*\([^)]*\))?\s*:\s*(.+)$/i.exec(plain(trimmed))
    if (statusLine !== null && out.planStatus === null) {
      out.planStatus = plain(statusLine[1] ?? '').slice(0, 80)
      found.add('status line')
    }
    out.links.push(...phaseLinks(trimmed))
  }

  close(1)
  // Headings count as phases only when no status table gave them, and only when at least one says how far it is
  // (itself, the checklist beneath it, or the phase file it links to).
  const known = headingPhases.map(h => (h.own ? h.status : derived(out.steps.slice(h.from, h.to))))
  if (out.phases.length === 0 && known.some((s, at) => s !== undefined || headingPhases[at]?.link !== null)) {
    out.phases = headingPhases.map((h, at) => ({ text: h.text, link: h.link, status: known[at] ?? 'todo', said: known[at] !== undefined }))
    found.add('status headings')
  }
  out.links = [...new Set(out.links)]
  out.formats = [...found]
  return out
}

// What a run of steps adds up to: all done is done, any started is active, none started is to do.
function derived(steps: readonly Item[]): Status | undefined {
  const c = count(steps)
  if (c.total === 0) return undefined
  return c.done === c.total ? 'done' : c.done + c.active > 0 ? 'active' : 'todo'
}

// A linked phase file's own status: its frontmatter or status line, else what its steps say.
function fileStatus(p: Parsed): Status | undefined {
  return (p.planStatus === null ? undefined : classify(p.planStatus)) ?? derived(p.steps)
}

// The plan and its linked phase files, read together into what the band and the pane show.
// `again` marks a second link to a file already listed, so its steps are not counted twice.
export function summarize(file: string, plan: Parsed, all: readonly { link: string; parsed: Parsed; again?: boolean }[]): PlanMeter {
  const linked = all.filter(l => l.again !== true)
  const steps = [...plan.steps, ...linked.flatMap(l => l.parsed.steps)]
  // A phase that says nothing the parser knows defers to its phase file; "Pending" stays pending.
  const resolved = plan.phases.map(p => {
    if (p.said) return { text: p.text, status: p.status, known: true }
    const own = all.find(l => l.link === p.link)
    const status = own === undefined ? undefined : fileStatus(own.parsed)
    return { text: p.text, status: status ?? ('todo' as Status), known: status !== undefined }
  })
  // When no phase says how far it is, there is no phase count to show rather than a made-up 0 of N.
  let phases: Item[] = resolved.some(r => r.known) ? resolved.map(({ text, status }) => ({ text, status })) : []
  if (phases.length === 0 && linked.some(l => fileStatus(l.parsed) !== undefined)) {
    phases = linked.map(l => ({ text: l.parsed.title ?? l.link, status: fileStatus(l.parsed) ?? 'todo' }))
  }
  const active = phases.find(p => p.status === 'active') ?? steps.find(s => s.status === 'active')
  const todo = steps.filter(s => s.status === 'todo').concat(steps.length === 0 ? phases.filter(p => p.status === 'todo') : [])
  const formats = new Set([...plan.formats, ...linked.flatMap(l => l.parsed.formats)])
  if (linked.length > 0) formats.add('linked phase files')
  return {
    file,
    title: plan.title,
    planStatus: plan.planStatus,
    phases: count(phases),
    steps: count(steps),
    current: active?.text ?? null,
    next: todo.slice(0, 3).map(t => t.text),
    formats: [...formats],
    files: 1 + linked.length,
    error: null,
  }
}

// One line for the band and for /plan under `claude -p`.
export function line(m: PlanMeter): string {
  if (m.error !== null) return `plan ▸ ${m.error}`
  const pieces = [`plan ▸ ${m.title ?? m.file}`]
  if (m.phases.total > 0) pieces.push(`phases ${m.phases.done}/${m.phases.total}`)
  if (m.steps.total > 0) pieces.push(`steps ${m.steps.done}/${m.steps.total} (${percent(m.steps)}%)`)
  if (m.phases.total === 0 && m.steps.total === 0) pieces.push(m.planStatus ?? 'no checklist, status table or status headings found')
  if (m.current !== null) pieces.push(`now: ${m.current}`)
  else if (m.next[0] !== undefined) pieces.push(`next: ${m.next[0]}`)
  return pieces.join(' · ')
}

export function count(items: readonly Item[]): Count {
  const c = { done: 0, active: 0, todo: 0, total: 0 }
  for (const item of items) {
    if (item.status === 'dropped') continue
    c[item.status] += 1
    c.total += 1
  }
  return c
}

export function percent(c: Count): number {
  return c.total === 0 ? 0 : Math.round((c.done / c.total) * 100)
}

export function bar(c: Count, width: number): string {
  const filled = c.total === 0 ? 0 : Math.round((c.done / c.total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
