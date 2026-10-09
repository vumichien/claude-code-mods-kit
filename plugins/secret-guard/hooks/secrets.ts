// Pure helpers for secret-guard: which key names hold secrets, parse an env file, and the Vault that finds
// secret values in any text (the env files' own, and ones that only look like secrets) and hides them.

export type Secret = { name: string; value: string }

// Shorter values are never hidden, so `PW=1` or `TOKEN_TTL=60` does not mask every 1 or 60 in a result.
export const MIN_SECRET_LEN = 8

// A key holds a secret when one part of its name (split at `_`, `-`, `.` and camelCase) is one of these words,
// or ends with one (APIKEY, DBPASS). Whole parts, so PWD's cousins TOKENIZER, MAX_TOKENS, PASSPORT, KEYBOARD
// are not secrets.
const SECRET_WORDS = ['PASS', 'PASSWD', 'PASSWORD', 'PW', 'PWD', 'SECRET', 'SECRETS', 'TOKEN', 'KEY', 'DSN', 'CREDENTIAL', 'CREDENTIALS', 'PRIVATE']
const SECRET_ENDINGS = ['PASS', 'PASSWD', 'PASSWORD', 'PWD', 'SECRET', 'TOKEN', 'KEY']
// The shell's own working-directory variables: paths, in every env listing.
const SHELL_NAMES = new Set(['PWD', 'OLDPWD'])

export type KeyRule = { extra: ReadonlySet<string>; identifiers: ReadonlySet<string> }

// Comma-separated option text to an upper-case set.
export function nameSet(option: unknown): Set<string> {
  return new Set(String(option ?? '').split(',').map(k => k.trim().toUpperCase()).filter(Boolean))
}

export function keyParts(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
}

export function isSecretKey(name: string, rule: KeyRule): boolean {
  const upper = name.toUpperCase()
  if (rule.identifiers.has(upper) || SHELL_NAMES.has(upper)) return false
  if (rule.extra.has(upper)) return true
  return keyParts(name).some(part => SECRET_WORDS.includes(part) || SECRET_ENDINGS.some(word => part.endsWith(word)))
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

// The secret values of an env file: keys whose name holds a secret, values long enough to hide.
export function parseEnv(text: string, rule: KeyRule): Secret[] {
  const secrets: Secret[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) return
    const name = match[1] ?? ''
    const rest = (match[2] ?? '').trim()
    const value = rest.startsWith('"') || rest.startsWith("'") ? quotedValue(rest, index + 1) : rest.replace(/\s+#.*$/, '')
    if (!isSecretKey(name, rule) || value.length < MIN_SECRET_LEN) return
    secrets.push({ name, value })
  })
  return byLength(secrets)
}

// Longest first, so a value that contains another is replaced whole.
function byLength(secrets: Secret[]): Secret[] {
  return secrets.sort((a, b) => b.value.length - a.value.length)
}

// Several env files merged, nearest first: a value found in two files keeps the nearest file's name.
export function mergeSecrets(lists: readonly (readonly Secret[])[]): Secret[] {
  const byValue = new Map<string, Secret>()
  for (const list of lists) for (const s of list) if (!byValue.has(s.value)) byValue.set(s.value, s)
  return byLength([...byValue.values()])
}

export const marker = (label: string) => `‹hidden: ${label}›`
// A marker as it reaches a tool's input; the label is a key name or a kind such as jwt.
export const MARKER = /‹hidden: ([^›\n]{1,100})›/g

// Values that name or point at a secret rather than hold one: `$VAR`, `${{ secrets.X }}`, `<your key>`, a type.
const NOT_A_VALUE = new Set(['true', 'false', 'null', 'none', 'nil', 'undefined', 'string', 'number', 'boolean', 'unknown', 'object'])
// `bare`: the value stood unquoted in the text, where code names a variable rather than a literal.
export function isSecretLiteral(value: string, bare = false): boolean {
  if (value.length < MIN_SECRET_LEN || NOT_A_VALUE.has(value.toLowerCase())) return false
  if (/^[$%<‹@]|^\{\{|^#\{/.test(value)) return false
  // A path to a key file is not the key: ~/.ssh/id_rsa, ./certs/app.pem, C:\keys\app.p12.
  if (/^(~|\.{1,2})[\\/]|^[A-Za-z]:[\\/]/.test(value)) return false
  if (/\$\{|\$\(|process\.env|os\.environ|getenv|ENV\[/.test(value)) return false
  // An unquoted attribute in code, not a literal: `tok.pad_token = tok.eos_token`. Generated values hold digits.
  if (bare && /^[A-Za-z_]+(\.[A-Za-z_]+)+$/.test(value)) return false
  // A mask someone already put there: ********, xxxxxxxx, ........, or a kept prefix and a masked rest (sk_****).
  return !/^([*xX.•])\1*$/.test(value) && !/[*•]{4,}$/.test(value)
}

// A detected value is hidden everywhere else in the session only when it looks generated (long, letters and
// digits), so `sortKey: "createdAt"` does not hide every createdAt that follows.
function looksGenerated(value: string): boolean {
  return value.length >= 12 && /[0-9]/.test(value) && /[A-Za-z]/.test(value)
}

// KEY=VALUE, KEY: VALUE, "KEY": "VALUE", --key=VALUE. An unquoted value after `:` must end its line (YAML),
// so `apiKey: string;` or `token: config.token,` in code is left alone; after `=` it must end at a space or
// a shell separator, so `password=pw,` (a keyword argument) is too.
const KEYED = /(?<![\w.$])(["']?)([A-Za-z_][\w.-]*)\1([ \t]*(?::|=(?![=>~]))[ \t]*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s'"`,;(){}[\]<>=]+)/g
const PRIVATE_KEY = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY\2-----|$)/g
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g
// scheme://user:password@host: only the password goes.
const DSN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@'"]*):([^\s@/'"]+)@/gi
const AWS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/
// A 40-character secret access key on the same line as an access key id (a credentials CSV, a log line).
const AWS_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g

// Holds every value secret-guard knows (the env files', and ones it found in results) in memory only, and
// hides them. `found` collects the names of what was hidden.
export class Vault {
  private named: Secret[]
  private readonly byLabel = new Map<string, Set<string>>()

  constructor(fileSecrets: readonly Secret[], private readonly rule: KeyRule) {
    this.named = [...fileSecrets]
    for (const s of fileSecrets) this.note(s.name, s.value)
  }

  // The env files' secrets plus the generated-looking values found since.
  get size(): number {
    return this.named.length
  }

  // The values a marker can stand for, for putting them back into a file that already holds one.
  values(label: string): string[] {
    return [...(this.byLabel.get(label) ?? [])]
  }

  private note(label: string, value: string): void {
    const set = this.byLabel.get(label) ?? new Set<string>()
    set.add(value)
    this.byLabel.set(label, set)
  }

  private remember(label: string, value: string, everywhere: boolean): void {
    this.note(label, value)
    if (everywhere && !this.named.some(s => s.value === value)) this.named = byLength([...this.named, { name: label, value }])
  }

  // A value already hidden (the text is scrubbed twice: the tool's text and its record) is left as it is.
  private hide(label: string, value: string, found: Set<string>, everywhere: boolean): string {
    if (value.includes('‹hidden: ')) return value
    found.add(label)
    this.remember(label, value, everywhere)
    return marker(label)
  }

  private exact(text: string, found: Set<string>): string {
    for (const s of this.named) {
      if (!text.includes(s.value)) continue
      found.add(s.name)
      text = text.split(s.value).join(marker(s.name))
    }
    return text
  }

  scrubText(text: string, found: Set<string>): string {
    text = this.exact(text, found)
    text = text.replace(PRIVATE_KEY, block => this.hide('private-key', block, found, true))
    text = this.kubernetes(text, found)
    text = text.replace(KEYED, (all, quote: string, key: string, sep: string, raw: string, offset: number, whole: string) => {
      const quoted = /^["']/.test(raw)
      const value = quoted ? raw.slice(1, -1) : raw
      if (!isSecretKey(key, this.rule) || !isSecretLiteral(value, !quoted)) return all
      // A key inside a quoted string (`grep 'TOKEN=' .env | cut -d= -f2-`): the quote after it closes that
      // string, and what follows up to the next quote is more command, not a value.
      if (quoted && (whole.slice(whole.lastIndexOf('\n', offset) + 1, offset).split(raw[0] ?? '').length - 1) % 2 === 1) return all
      // A name that is only `key` (a React key, a YAML selector) hides a value only when it looks generated.
      if (/^keys?$/i.test(key) && !looksGenerated(value)) return all
      const after = whole.slice(offset + all.length)
      // Unquoted after `:`, the value must end its line (YAML); after `=`, it must end at a space, a quote or a
      // shell separator (`password=pw_var,` and `f(token=t)` are code).
      if (!quoted && sep.includes(':') && !/^[ \t]*(#.*)?(\r?\n|$)/.test(after)) return all
      if (!quoted && sep.includes('=') && !/^(\s|["'`;&|]|$)/.test(after)) return all
      const shown = quoted ? `${raw[0]}${marker(key)}${raw[0]}` : marker(key)
      found.add(key)
      this.remember(key, value, looksGenerated(value))
      return `${quote}${key}${quote}${sep}${shown}`
    })
    text = text.replace(DSN, (all, scheme: string, user: string, password: string) => {
      if (/^[$%<{*‹]/.test(password)) return all
      found.add('dsn-password')
      this.remember('dsn-password', password, looksGenerated(password))
      return `${scheme}${user}:${marker('dsn-password')}@`
    })
    text = text.split('\n').map(line => {
      if (!AWS_KEY_ID.test(line)) return line
      const withSecret = line.replace(AWS_SECRET, token =>
        /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token) ? this.hide('aws-secret-access-key', token, found, true) : token)
      return withSecret.replace(new RegExp(AWS_KEY_ID.source, 'g'), id => this.hide('aws-access-key-id', id, found, true))
    }).join('\n')
    text = text.replace(JWT, token => this.hide('jwt', token, found, true))
    // A value found just now may also stand bare elsewhere in the same text.
    return this.exact(text, found)
  }

  // The values under a Kubernetes Secret's `data:` / `stringData:`, whatever their names.
  private kubernetes(text: string, found: Set<string>): string {
    if (/^\s*kind:\s*Secret\s*$/m.test(text)) {
      const lines = text.split('\n')
      let blockIndent = -1
      let valueIndent = -1
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        const indent = line.length - line.trimStart().length
        if (line.trim() === '') continue
        if (valueIndent >= 0 && indent > valueIndent) {
          // The lines of a `key: |` block scalar.
          lines[i] = `${line.slice(0, indent)}${this.hide('k8s-secret', line.trim(), found, false)}`
          continue
        }
        valueIndent = -1
        if (blockIndent >= 0 && indent > blockIndent) {
          const entry = /^(\s*)([\w.-]+):[ \t]*(\S.*)$/.exec(line)
          if (entry === null) continue
          const [, lead, key, value] = entry as unknown as [string, string, string, string]
          if (/^[|>][-+0-9]*$/.test(value.trim())) valueIndent = indent
          else lines[i] = `${lead}${key}: ${this.hide('k8s-secret', value.trim(), found, looksGenerated(value.trim()))}`
          continue
        }
        blockIndent = /^\s*(data|stringData):\s*$/.test(line) ? indent : -1
      }
      text = lines.join('\n')
    }
    if (/"kind"\s*:\s*"Secret"/.test(text)) {
      text = text.replace(/("(?:data|stringData)"\s*:\s*\{)([^{}]*)\}/g, (_all, head: string, body: string) =>
        `${head}${body.replace(/("(?:[^"\\]|\\.)*"\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (_e, key: string, value: string) =>
          `${key}"${this.hide('k8s-secret', value, found, looksGenerated(value))}"`)}}`)
    }
    return text
  }

  // Every string in a tool's result: object keys stay (the result keeps its shape), a value under a secret
  // key (`{ "apiKey": "..." }` from an MCP tool) is hidden whole.
  scrub(value: unknown, found: Set<string>): unknown {
    if (typeof value === 'string') return this.scrubText(value, found)
    if (Array.isArray(value)) return value.map(v => this.scrub(v, found))
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => {
        if (typeof v === 'string' && isSecretKey(k, this.rule) && isSecretLiteral(v) && !v.includes('‹hidden: ')) {
          found.add(k)
          this.remember(k, v, looksGenerated(v))
          return [k, marker(k)]
        }
        return [k, this.scrub(v, found)]
      }))
    }
    // Numbers stay numbers so the result keeps its shape; find still sees them, and the guard withholds.
    return value
  }

  // The names of known values left in any string, number, array item, object value or object key.
  find(values: readonly unknown[]): string[] {
    const found = new Set<string>()
    const visit = (value: unknown): void => {
      if (typeof value === 'string') {
        for (const s of this.named) if (value.includes(s.value)) found.add(s.name)
      } else if (typeof value === 'number' || typeof value === 'bigint') {
        // A numeric value (a 12-digit PIN) can sit in a result as a number, not as text.
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
}

export function fill(text: string, values: ReadonlyMap<string, string>): string {
  return text.replace(MARKER, (all, label: string) => values.get(label) ?? all)
}

// The value behind each marker in an Edit or Write, when the target file settles it: each value must already be
// in the file (restoring, never spreading), and every old_string must then match the file. Undefined when a
// marker has no such value or could stand for several. A marker whose label stands for no value secret-guard
// knows (a document quoting the format) is plain text and stays as written; so does a marker the file already
// holds as text.
export function resolveMarkers(texts: readonly { text: string; isOld: boolean }[], fileText: string, values: (label: string) => readonly string[]): Map<string, string> | undefined {
  const labels = [...new Set(texts.flatMap(t => [...t.text.matchAll(MARKER)].map(m => m[1] ?? '')))]
    .filter(label => values(label).length > 0)
  let combos: Map<string, string>[] = [new Map()]
  for (const label of labels) {
    const candidates = [...values(label), marker(label)].filter(v => fileText.includes(v))
    combos = combos.flatMap(c => candidates.map(v => new Map([...c, [label, v]])))
    if (combos.length > 64) return undefined
  }
  const fits = combos.filter(c => texts.every(t => !t.isOld || fileText.includes(fill(t.text, c))))
  return fits.length === 1 ? fits[0] : undefined
}

// What secret-guard answers when its own hook failed: refuse before the tool ran, withhold after.
export function failClosed(called: boolean, kind: string): { deny: string } {
  return called
    ? { deny: 'secret-guard could not check this result, so it was withheld' }
    : { deny: `secret-guard could not check this call (${kind}), so it was not run` }
}
