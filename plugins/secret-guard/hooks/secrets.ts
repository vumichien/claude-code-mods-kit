// Pure helpers for secret-guard: parse a .env, find and replace its values, spot a .env file name.

export type Secret = { name: string; value: string }

export const MIN_SECRET_LEN = 12
// The same rule as experiments/mine-sessions.py's ENV_FILE: `.env` as a file token, not `.venv`, not `.env.example`.
export const ENV_FILE = /(?<![\w.])\.env(?![\w.])/

export function mentionsEnvFile(text: string): boolean {
  return ENV_FILE.test(text)
}

// Where to look for a .env, nearest first: the folder itself, then each parent up to and including the root.
// Each path keeps its folder's own separator, so the path /secret-guard shows reads as one path.
export function envCandidates(start: string): string[] {
  const out: string[] = []
  const sep = start.includes('\\') ? '\\' : '/'
  let dir = start.replace(/[\\/]+$/, '')
  for (;;) {
    // An empty dir is the Unix root, which gives `/.env`.
    out.push(`${dir}${sep}.env`)
    const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
    if (cut < 0) return out
    dir = dir.slice(0, cut)
  }
}

const DOUBLE_QUOTED_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }

// A quoted value as python-dotenv reads it: double quotes take backslash escapes, single quotes are literal,
// and a comment may follow the closing quote. A quote that does not close on its line (a multiline value) is
// not supported, so it throws: the guard then refuses calls rather than protect a wrong value.
function quotedValue(value: string, lineNumber: number): string {
  const quote = value[0]
  let inner = ''
  for (let i = 1; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && quote === '"' && i + 1 < value.length) {
      const next = value[i + 1] ?? ''
      inner += DOUBLE_QUOTED_ESCAPES[next] ?? `\\${next}`
      i += 1
    } else if (ch === quote) {
      const rest = value.slice(i + 1).trim()
      if (rest !== '' && !rest.startsWith('#')) throw new Error(`unsupported .env syntax on line ${lineNumber}`)
      return inner
    } else inner += ch
  }
  throw new Error(`unsupported .env syntax on line ${lineNumber} (a quoted value that does not close)`)
}

export function parseEnv(text: string, identifiers: ReadonlySet<string>): Secret[] {
  const secrets: Secret[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) return
    const name = match[1] ?? ''
    const rest = (match[2] ?? '').trim()
    const value = rest.startsWith('"') || rest.startsWith("'") ? quotedValue(rest, index + 1) : rest.replace(/\s+#.*$/, '')
    if (identifiers.has(name) || value.length < MIN_SECRET_LEN) return
    secrets.push({ name, value })
  })
  // Longest first, so a value that contains another is replaced whole.
  return secrets.sort((a, b) => b.value.length - a.value.length)
}

// The names of the values found in any string, number, array item, object value or object key.
export function findSecrets(values: readonly unknown[], secrets: readonly Secret[]): string[] {
  const found = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const s of secrets) if (value.includes(s.value)) found.add(s.name)
    } else if (typeof value === 'number' || typeof value === 'bigint') {
      // A numeric value (a 12-digit account number) can sit in a result as a number, not as text.
      visit(String(value))
    } else if (Array.isArray(value)) value.forEach(visit)
    else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        visit(key)
        visit(inner)
      }
    }
  }
  values.forEach(visit)
  return [...found]
}

export function scrub(value: unknown, secrets: readonly Secret[]): unknown {
  if (typeof value === 'string') {
    let text = value
    for (const s of secrets) text = text.split(s.value).join(`‹hidden: ${s.name}›`)
    return text
  }
  if (Array.isArray(value)) return value.map(v => scrub(v, secrets))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets)]))
  }
  // Numbers stay numbers so the result keeps its shape; findSecrets still sees them, and the guard withholds.
  return value
}

// What secret-guard answers when its own hook failed: refuse before the tool ran, withhold after.
export function failClosed(called: boolean, kind: string): { deny: string } {
  return called
    ? { deny: 'secret-guard could not check this result, so it was withheld' }
    : { deny: `secret-guard could not check this call (${kind}), so it was not run` }
}
