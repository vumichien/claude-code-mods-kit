// prompt-enhancer's pure parts: when a draft may go to the model, what the model is asked, and how its answer
// and its cost are read back.

export const MAX_DRAFT = 4000
export const TIMEOUT_MS = 20_000
export const CLAUDE_MD_LINES = 40
const DESCRIPTION_CHARS = 100

// A draft holding a secret never leaves the session: secret-guard's placeholder, or a value shaped like a key.
const SECRET_SHAPES: readonly RegExp[] = [
  /‹hidden:/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/,
]

// Why a draft is not sent to the model, or undefined when it may be.
export function refusal(draft: string): string | undefined {
  if (draft.trim() === '') return 'nothing to enhance: type a draft first'
  if (draft.length > MAX_DRAFT) return `too long to enhance: ${draft.length} characters, at most ${MAX_DRAFT}`
  if (SECRET_SHAPES.some(shape => shape.test(draft))) return 'not sent: the draft holds a secret or a hidden-value marker'
  return undefined
}

export type Command = { name: string; description: string; source: string }

// The ask: the draft, the skills and commands this session has (built-in ones left out), and the top of the
// project's CLAUDE.md, so the rewrite can name what fits and what the project asks for.
export function buildPrompt(draft: string, commands: readonly Command[], claudeMd: string): string {
  const list = commands
    .filter(c => c.source !== 'builtin')
    .map(c => `/${c.name}: ${c.description.replace(/\s+/g, ' ').slice(0, DESCRIPTION_CHARS)}`)
    .join('\n')
  const head = claudeMd.split('\n').slice(0, CLAUDE_MD_LINES).join('\n')
  return `Rewrite the draft prompt below so Claude Code can act on it well. Name the skills or commands from the list that fit (at most 3), list the decisions Claude should ask about before starting, and say what done looks like. Keep the author's intent and language; do not invent requirements. Reply with the rewritten prompt only.

<commands>
${list}
</commands>

<project-instructions>
${head}
</project-instructions>

<draft>
${draft}
</draft>`
}

// The rewrite as it goes into the prompt box: trimmed, and out of a code fence if the model put it in one.
export function rewriteOf(reply: string): string {
  const text = reply.trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text)
  return (fenced ? fenced[1]! : text).trim()
}

export type Usage = { input_tokens: number; output_tokens: number }

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

// What one press cost, in the tokens the model call reports; the README converts them at list prices.
export function costLine(usage: Usage): string {
  return `${thousands(usage.input_tokens)} in · ${thousands(usage.output_tokens)} out tokens (haiku)`
}
