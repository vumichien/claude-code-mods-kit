// Pure helpers for done-gate: which commands run tests or scripts, which files count as code, and the words it shows.

import type { Gate } from '../types'

// The usual test runners, as the first word(s) of a simple command.
export const TEST_COMMAND =
  /^(pytest|py\.test|python[\d.]* -m (pytest|unittest)|(npm|pnpm|yarn|bun)( run)? test|vitest|jest|mocha|go test|cargo (test|nextest)|mvn( -\S+)* (test|verify)|(\.\/)?gradlew? test|dotnet test|(bundle exec )?rspec|(vendor\/bin\/)?phpunit|mix test|swift test|ctest|make (test|check)|tox|nox|deno test|claude plugin test)(\s|$)/

// Words that run the rest of the command: `FOO=1 pytest`, `npx vitest`, `uv run pytest`.
const WRAPPERS = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|time|env|npx|bunx|pnpm (?:exec|dlx)|yarn dlx|uv run|poetry run|pipenv run|hatch run|pdm run|rye run)\s+)+/
// Programs that run the file named after them.
const INTERPRETERS = /^(python[\d.]*|py|node|deno run|bun(?: run)?|tsx|ts-node|ruby|perl|php|bash|sh|zsh|pwsh|powershell|Rscript|julia|lua|go run)(?=\s|$)/

export function list(option: unknown): string[] {
  return String(option ?? '').split(',').map(p => p.trim()).filter(Boolean)
}

// Quoted text is an argument, never a command: `echo "pytest"` runs echo.
function unquoted(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
}

// The simple commands in a command line, split at `&&`, `||`, `;`, `|`, newlines and brackets, wrappers dropped.
export function segments(command: string): string[] {
  return unquoted(command)
    .split(/&&|\|\||[;|\n()]/)
    .map(s => s.trim().replace(WRAPPERS, ''))
    .filter(Boolean)
}

// What a command line says about tests: `test` when one of its simple commands is a test runner (or one of yours,
// `testCommands`) and the line's exit status is the runner's; `masked` when it could be another command's
// (`pytest | tail -20`, `pytest; echo done`, `pytest || true`): then only the runner's own summary line can tell.
export function testRun(command: string, extra: readonly string[]): 'test' | 'masked' | undefined {
  const isTest = (s: string) => TEST_COMMAND.test(s) || extra.some(e => s === e || s.startsWith(`${e} `))
  const line = unquoted(command)
  const pieces = line.split(/(&&|\|\||[;|\n])/)
  const first = pieces.findIndex((p, at) => at % 2 === 0 && isTest(p.trim().replace(/^\(+\s*|\s*\)+$/g, '').replace(WRAPPERS, '')))
  if (first < 0) return segments(command).some(isTest) ? 'masked' : undefined
  // After the runner, only `&&` keeps its exit status; `||` anywhere can turn a failure into success.
  const after = pieces.slice(first + 1).filter((_, at) => at % 2 === 0)
  return line.includes('||') || after.some(sep => sep !== '&&') ? 'masked' : 'test'
}

// A runner's own summary in its output, for a run whose exit status was masked. Failure words win.
export function testOutcome(output: string): 'passed' | 'failed' | undefined {
  if (/\b[1-9]\d* (failed|failing|fail|errors?)\b|^FAIL(ED)?\b|test result: FAILED/m.test(output)) return 'failed'
  if (/\b\d+ passed\b|\b\d+ passing\b|\b\d+ pass\b[\s\S]*\b0 fail\b|^ok\s+\S|test result: ok|^OK\b|Tests:\s+\d+ passed/m.test(output)) return 'passed'
  return undefined
}

// The files a command line runs: the first argument after an interpreter (`python scripts/report.py`), or a
// command that is itself a path (`./build.sh`). `python -m pkg` and `python -c "…"` name no file.
export function ranFiles(command: string): string[] {
  const out: string[] = []
  for (const s of segments(command)) {
    const program = INTERPRETERS.exec(s)
    if (program === null) {
      const first = s.split(/\s+/)[0] ?? ''
      if (/[\\/]/.test(first)) out.push(first)
      continue
    }
    for (const word of s.slice(program[0].length).trim().split(/\s+/)) {
      if (word === '-m' || word === '-c' || word === '-e') break
      if (word.startsWith('-')) continue
      if (word !== '') out.push(word)
      break
    }
  }
  return out
}

// Docs and notes are not code: a change to them does not need a test run.
export function isIgnored(path: string, suffixes: readonly string[]): boolean {
  const lower = path.toLowerCase()
  return suffixes.some(s => lower.endsWith(s.toLowerCase()))
}

// Windows paths (a drive letter or a network share) compare without case; others with it.
function caseless(path: string): boolean {
  return /^([A-Za-z]:|[\\/]{2})/.test(path)
}

function clean(path: string): string {
  const unc = /^[\\/]{2}/.test(path)
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..' && parts.length > 0) parts.pop()
    else parts.push(part)
  }
  return (unc ? '//' : path.replace(/\\/g, '/').startsWith('/') ? '/' : '') + parts.join('/')
}

// The path relative to the project when it lies inside it, with forward slashes.
export function shortPath(root: string, path: string): string {
  const full = clean(/^([A-Za-z]:)?[\\/]/.test(path) ? path : `${root}/${path}`)
  const base = clean(root)
  const fold = (p: string) => (caseless(root) ? p.toLowerCase() : p)
  return fold(full).startsWith(`${fold(base)}/`) ? full.slice(base.length + 1) : full
}

export function sameFile(root: string, a: string, b: string): boolean {
  const x = shortPath(root, a)
  const y = shortPath(root, b)
  return caseless(root) ? x.toLowerCase() === y.toLowerCase() : x === y
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}

function files(names: readonly string[], max = 3): string {
  return names.slice(0, max).join(', ') + (names.length > max ? ` and ${names.length - max} more` : '')
}

// The band's line; undefined when nothing has happened yet.
export function describe(gate: Gate, now: number): string | undefined {
  if (gate.lastTest === null && gate.unchecked.length === 0) return undefined
  const test =
    gate.lastTest === null ? 'no test run yet' : `tests ${gate.lastTest.passed ? '✔ passed' : '✘ failed'} ${ago(now - gate.lastTest.at)}`
  const changed = gate.unchecked.length === 0 ? '' : ` · ${gate.unchecked.length} file${gate.unchecked.length === 1 ? '' : 's'} changed since`
  const warned = gate.warnings === 0 ? '' : ` · warned ${gate.warnings}×`
  return `done-gate ▸ ${test}${changed}${warned}`
}

// What Claude reads after it marks a task done while code is unchecked. A note, never a refusal.
export function warning(gate: Gate, task: string): string {
  const since = gate.lastTest === null ? 'and no test has run in this session' : gate.lastTest.passed ? 'since the last passing test run' : 'and the last test run failed'
  return (
    `done-gate: "${task}" was marked done, but ${gate.unchecked.length} code file${gate.unchecked.length === 1 ? ' was' : 's were'} changed ${since}: ` +
    `${files(gate.unchecked)}. Before you report this task as finished, run the tests that cover these files, ` +
    `or tell the user plainly that they were not tested and why.`
  )
}
