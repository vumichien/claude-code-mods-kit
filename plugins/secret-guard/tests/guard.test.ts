import { describe, expect, test } from 'claude-code/testing'

// Runs a slash command as the person would; the test host fills in args, origin and presentation.
const runCommand = ($: any, command: string) => $.command.run({ command })

import { envCandidates, failClosed, parseEnv } from '../hooks/secrets'
import { bashResult, shown, startSession } from './fixtures/host'

// Fake values only: these are test strings, never a real key.
const ENV = [
  '# workspace secrets (fake, for tests)',
  'ID=alice_login_01',
  'LOGIN_USER=alice_login_01',
  'LLM_API_KEY=canary-test-0f1e2d3c4b5a69788796a5b4',
  'PW="canary-test-pw-quoted-value"',
  'SHORT=abc',
].join('\n')
const KEY = 'canary-test-0f1e2d3c4b5a69788796a5b4'
const PW = 'canary-test-pw-quoted-value'

const start = ($: any, on: any, answer: (e: any) => unknown) => startSession($, on, ENV, answer)

describe('value mode', () => {
  test('hides a value in a Bash stdout', async ($, on) => {
    const seen = await start($, on, () => bashResult(`LLM_API_KEY=${KEY}\nPW=${PW}\n`))
    const out = await $.tool.call({ tool: 'Bash', command: 'cat .env' })
    const shown = JSON.stringify(out)
    expect(shown).not.toContain(KEY)
    expect(shown).not.toContain(PW)
    expect(shown).toContain('‹hidden: LLM_API_KEY›')
    expect(seen.status).toContain('secret-guard: 2 hidden this session')
  })

  test('hides a value in a Read result', async ($, on) => {
    const content = `1\tLLM_API_KEY=${KEY}\n`
    await start($, on, () => ({
      result: { type: 'text', file: { filePath: 'C:/ws/.env', content, numLines: 1, startLine: 1, totalLines: 1 } },
      text: content,
    }))
    const out = await $.tool.call({ tool: 'Read', file_path: 'C:/ws/.env' })
    expect(JSON.stringify(out)).not.toContain(KEY)
  })

  test('hides a value in an errored result', async ($, on) => {
    await start($, on, () => ({ isError: true, result: `exit 1: ${KEY}`, text: `exit 1: ${KEY}` }))
    const out = await $.tool.call({ tool: 'Bash', command: 'false' })
    expect(JSON.stringify(out)).not.toContain(KEY)
  })

  test('a clean result passes unchanged', async ($, on) => {
    const clean = bashResult('hello\n')
    await start($, on, () => clean)
    const out = await $.tool.call({ tool: 'Bash', command: 'echo hello' })
    expect(out.result).toEqual(clean.result)
    expect(out.text).toBe('hello\n')
  })

  test('identifier keys and short values are not hidden', { options: { identifierKeys: 'ID,LOGIN_USER' } }, async ($, on) => {
    await start($, on, () => bashResult('ssh alice_login_01@spark; SHORT=abc\n'))
    const out = await $.tool.call({ tool: 'Bash', command: 'whoami' })
    expect(JSON.stringify(out)).toContain('alice_login_01')
    expect(JSON.stringify(out)).toContain('SHORT=abc')
  })

  test('/secret-guard replies with key names only', async ($, on) => {
    const seen = await start($, on, () => bashResult(`${KEY}\n`))
    await $.tool.call({ tool: 'Bash', command: 'printenv LLM_API_KEY' })
    const reply = await runCommand($, 'secret-guard')
    const text = JSON.stringify(reply)
    expect(text).toContain('LLM_API_KEY')
    expect(text).toContain('PW')
    expect(text).toContain('1 values hidden this session')
    for (const value of [KEY, PW]) {
      expect(text).not.toContain(value)
      expect(JSON.stringify(seen)).not.toContain(value)
    }
  })

  test('fails closed when the result cannot be checked', async ($, on) => {
    await start($, on, () => { throw new Error('tool exploded') })
    const out = await $.tool.call({ tool: 'Bash', command: 'cat .env' })
    expect(JSON.stringify(out)).not.toContain(KEY)
    expect(out.deny).toBe('secret-guard could not check this result, so it was withheld')
  })
})

describe('command mode', () => {
  test('denies cat .env', { options: { mode: 'command' } }, async ($, on) => {
    let ran = false
    await start($, on, () => { ran = true; return bashResult(`LLM_API_KEY=${KEY}\n`) })
    const out = await $.tool.call({ tool: 'Bash', command: 'cat .env' })
    expect(ran).toBe(false)
    expect(out.deny).toContain('reads a .env file')
  })

  test('lets ls through', { options: { mode: 'command' } }, async ($, on) => {
    await start($, on, () => bashResult('a.txt\n'))
    const out = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(out.deny).toBeUndefined()
    expect(out.text).toBe('a.txt\n')
  })

  test('does not match .venv or .env.example', { options: { mode: 'command' } }, async ($, on) => {
    await start($, on, () => bashResult('ok\n'))
    for (const command of ['ls .venv', 'cat .env.example']) {
      const out = await $.tool.call({ tool: 'Bash', command })
      expect(out.deny).toBeUndefined()
    }
  })
})

describe('fail closed', () => {
  test('a failure before the tool ran refuses the call', () => {
    expect(failClosed(false, 'timeout').deny).toBe('secret-guard could not check this call (timeout), so it was not run')
  })

  test('a failure after the tool ran withholds the result', () => {
    expect(failClosed(true, 'throw').deny).toBe('secret-guard could not check this result, so it was withheld')
  })
})

describe('edge cases', () => {
  test('a refusal from beneath has its reason scrubbed', async ($, on) => {
    await start($, on, () => ({ deny: `blocked: LLM_API_KEY=${KEY}` }))
    const out: any = await $.tool.call({ tool: 'Bash', command: 'printenv' })
    expect(out.deny).toBe('blocked: LLM_API_KEY=‹hidden: LLM_API_KEY›')
  })

  test('an unreadable .env makes value mode refuse every call', async ($, on) => {
    let ran = false
    await startSession($, on, new Error('EACCES'), () => { ran = true; return bashResult('hello\n') })
    const out: any = await $.tool.call({ tool: 'Bash', command: 'echo hello' })
    expect(ran).toBe(false)
    expect(out.deny).toBe('secret-guard has not loaded the .env values, so this call was not run')
    const reply = await runCommand($, 'secret-guard')
    // The reason is the host's (a stub that throws is skipped, so the kit reports no implementation).
    expect(reply.text).toMatch(/^could not load C:.ws\/\.env \(.+\), so value mode refuses every tool call$/)
  })

  test('before its start hook finishes, value mode refuses calls and says so', async ($, on) => {
    let ran = false
    on('tool.call', () => { ran = true; return bashResult('hello\n') })
    on('command.run', () => ({ text: 'no hook answered' }))
    const out: any = await $.tool.call({ tool: 'Bash', command: 'echo hello' })
    expect(ran).toBe(false)
    expect(out.deny).toBe('secret-guard has not loaded the .env values, so this call was not run')
    const reply = await runCommand($, 'secret-guard')
    expect(reply.text).toBe('has not loaded the .env yet (its start hook did not finish), so value mode refuses every tool call')
  })

  test('a value held in an object key withholds the result', async ($, on) => {
    await start($, on, () => ({ result: { [KEY]: 'x' }, text: 'x' }))
    const out: any = await $.tool.call({ tool: 'mcp__demo__lookup', query: 'q' } as any)
    expect(shown(out)).not.toContain(KEY)
    expect(out.deny).toBe('secret-guard could not check this result, so it was withheld')
  })

  test('parses .env values as python-dotenv does', () => {
    const parsed = parseEnv([
      'A_KEY="quoted-value-0001" # a comment',
      "B_KEY='single-quoted-02'",
      'C_KEY="escaped \\"quote\\" inside"',
      'D_KEY=plain-value-00004 # comment',
    ].join('\n'), new Set())
    const byName = Object.fromEntries(parsed.map(s => [s.name, s.value]))
    expect(byName).toEqual({
      A_KEY: 'quoted-value-0001',
      B_KEY: 'single-quoted-02',
      C_KEY: 'escaped "quote" inside',
      D_KEY: 'plain-value-00004',
    })
  })

  test('a value held as a number withholds the result, and /secret-guard counts it', async ($, on) => {
    await startSession($, on, 'ACCOUNT_NUMBER=123456789012', () => ({ result: { id: 123456789012 }, text: 'id 123456789012' }))
    const out: any = await $.tool.call({ tool: 'mcp__demo__lookup', query: 'q' } as any)
    expect(shown(out)).not.toContain('123456789012')
    expect(out.deny).toBe('secret-guard could not check this result, so it was withheld')
    const reply = await runCommand($, 'secret-guard')
    expect(reply.text).toContain('1 results withheld because they could not be checked')
  })

  // A pure check: on Windows the test host turns `/srv/app` into `C:\srv\app`, so a Unix layout can't be staged.
  test('the search for a .env reaches the root on Unix and on Windows', () => {
    expect(envCandidates('/srv/app')).toEqual(['/srv/app/.env', '/srv/.env', '/.env'])
    expect(envCandidates('C:\\ws\\project\\')).toEqual(['C:\\ws\\project\\.env', 'C:\\ws\\.env', 'C:\\.env'])
  })

  test('command mode never reads the values', { options: { mode: 'command' } }, async ($, on) => {
    await startSession($, on, new Error('EACCES'), () => bashResult('a.txt\n'))
    const out: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(out.text).toBe('a.txt\n')
    expect((await runCommand($, 'secret-guard')).text).toBe('mode command: refuses any call whose command or path names a .env file; values are not read')
  })

  test('a quoted value that does not close is refused, not guessed', () => {
    expect(() => parseEnv('A_KEY="opens-and-never-closes', new Set())).toThrow()
  })
})
