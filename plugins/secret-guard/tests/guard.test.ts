import { describe, expect, test } from 'claude-code/testing'

// Runs a slash command as the person would; the test host fills in args, origin and presentation.
const runCommand = ($: any, command: string) => $.command.run({ command })

import { refusal } from '../hooks/commands'
import { ancestorDirs } from '../hooks/files'
import { failClosed, isSecretKey, nameSet, parseEnv } from '../hooks/secrets'
import { bashResult, shown, startSession } from './fixtures/host'

// Fake values only: these are test strings, never a real key.
const ENV = [
  '# workspace secrets (fake, for tests)',
  'ID=alice_login_01',
  'LOGIN_USER=alice_login_01',
  'LLM_API_KEY=canary-test-0f1e2d3c4b5a69788796a5b4',
  'PW="canary-test-pw-quoted-value"',
  'SHORT_PW=abc',
  'DB_NAME=canary_orders_production',
  'ACCOUNT_ID=123456789012',
].join('\n')
const KEY = 'canary-test-0f1e2d3c4b5a69788796a5b4'
const PW = 'canary-test-pw-quoted-value'
const NO_RULE = { extra: new Set<string>(), identifiers: new Set<string>() }

const start = ($: any, on: any, answer: (e: any) => unknown) => startSession($, on, ENV, answer)
// A session with no env file anywhere: only the content detectors are at work.
const bare = ($: any, on: any, answer: (e: any) => unknown) => startSession($, on, {}, answer)
const run = ($: any, command: string, tool = 'Bash') => $.tool.call({ tool, command })

describe('value mode', () => {
  test('hides a value in a Bash stdout', async ($, on) => {
    const seen = await start($, on, () => bashResult(`LLM_API_KEY=${KEY}\nPW=${PW}\n`))
    const out = await run($, './show-config.sh')
    const text = JSON.stringify(out)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(PW)
    expect(text).toContain('‹hidden: LLM_API_KEY›')
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
    const out = await run($, 'false')
    expect(JSON.stringify(out)).not.toContain(KEY)
  })

  test('a clean result passes unchanged', async ($, on) => {
    const clean = bashResult('hello\n')
    await start($, on, () => clean)
    const out = await run($, 'echo hello')
    expect(out.result).toEqual(clean.result)
    expect(out.text).toBe('hello\n')
  })

  test('hides by key name: logins, database names, account ids and short values stay', async ($, on) => {
    const stdout = 'ssh alice_login_01@spark\nDB_NAME=canary_orders_production\nACCOUNT_ID=123456789012\nSHORT_PW=abc\n'
    await start($, on, () => bashResult(stdout))
    const out = await run($, './deploy.sh --dry-run')
    expect(out.text).toBe(stdout)
  })

  test('identifierKeys removes a key, secretKeys adds one', { options: { identifierKeys: 'LLM_API_KEY', secretKeys: 'DB_NAME' } }, async ($, on) => {
    await start($, on, () => bashResult(`${KEY} canary_orders_production\n`))
    const out = await run($, './deploy.sh')
    const text = JSON.stringify(out)
    expect(text).toContain(KEY)
    expect(text).not.toContain('canary_orders_production')
    expect(text).toContain('‹hidden: DB_NAME›')
  })

  test('which key names hold a secret', () => {
    const secret = (name: string) => isSecretKey(name, NO_RULE)
    for (const name of ['AWS_SECRET_ACCESS_KEY', 'apiKey', 'DB_PASSWD', 'DB_PASSWORD', 'PW', 'DB_PWD', 'APIKEY', 'GITHUB_TOKEN', 'SENTRY_DSN', 'clientSecret', 'PRIVATE_KEY_PEM']) {
      expect([name, secret(name)]).toEqual([name, true])
    }
    for (const name of ['PWD', 'OLDPWD', 'TOKENIZER_PATH', 'MAX_TOKENS', 'PASSPORT_NO', 'KEYBOARD', 'DB_NAME', 'DB_HOST', 'ACCOUNT_ID', 'USER']) {
      expect([name, secret(name)]).toEqual([name, false])
    }
    expect(isSecretKey('KMS_KEY_ID', { extra: new Set(), identifiers: nameSet('kms_key_id') })).toBe(false)
  })

  test('/secret-guard replies with key names only', async ($, on) => {
    const seen = await start($, on, () => bashResult(`${KEY}\n`))
    await run($, 'printenv LLM_API_KEY')
    const reply = await runCommand($, 'secret-guard')
    const text = JSON.stringify(reply)
    expect(text).toContain('LLM_API_KEY')
    expect(text).toContain('PW')
    expect(text).not.toContain('DB_NAME')
    expect(text).toContain('1 values hidden this session')
    for (const value of [KEY, PW]) {
      expect(text).not.toContain(value)
      expect(JSON.stringify(seen)).not.toContain(value)
    }
  })

  test('every env file from the session folder up is read: .env and .env.*, not *.example', async ($, on) => {
    const PROJECT = 'canary-test-project-key-77aa'
    const LOCAL = 'canary-test-local-secret-88bb'
    const EXAMPLE = 'canary-example-placeholder-99cc'
    const seen = await startSession($, on, {
      'C:/ws/project/.env': `PROJECT_KEY=${PROJECT}\nSHARED_TOKEN=${KEY}`,
      'C:/ws/project/.env.local': `LOCAL_SECRET=${LOCAL}`,
      'C:/ws/project/.env.example': `EXAMPLE_KEY=${EXAMPLE}`,
      'C:/ws/.env': ENV,
    }, () => bashResult(`${PROJECT} ${KEY} ${PW} ${LOCAL} ${EXAMPLE}\n`))
    const out = await run($, './run.sh')
    const text = JSON.stringify(out)
    for (const value of [PROJECT, KEY, PW, LOCAL]) expect(text).not.toContain(value)
    expect(text).toContain(EXAMPLE)
    // A value in two files keeps the nearest file's name.
    expect(text).toContain('‹hidden: SHARED_TOKEN›')
    expect(seen.status).toContain('secret-guard: 4 hidden this session')
    const reply = (await runCommand($, 'secret-guard')).text
    expect(reply).toMatch(/protects 4 values from C:.ws.project.\.env, C:.ws.project.\.env\.local, C:.ws.\.env: /)
    expect(reply).not.toContain('EXAMPLE_KEY')
  })

  test('secretFiles adds a path glob from the home folder', { options: { secretFiles: '.env, ~/vault/**/.env' } }, async ($, on) => {
    const SVC = 'canary-test-service-token-55dd'
    await startSession($, on, {
      'C:/home/me/vault/acme/stag/.env': `SVC_TOKEN=${SVC}`,
      'C:/ws/.env': ENV,
    }, () => bashResult(`${SVC}\n`))
    const out = await run($, './check.sh')
    expect(JSON.stringify(out)).not.toContain(SVC)
    expect(JSON.stringify(out)).toContain('‹hidden: SVC_TOKEN›')
  })

  test('fails closed when the result cannot be checked', async ($, on) => {
    await start($, on, () => { throw new Error('tool exploded') })
    const out = await run($, './show-config.sh')
    expect(JSON.stringify(out)).not.toContain(KEY)
    expect(out.deny).toBe('secret-guard could not check this result, so it was withheld')
  })
})

describe('the standing context block', () => {
  test('names the protected keys and the convention, never a value', async ($, on) => {
    await start($, on, () => bashResult(''))
    const out: any = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'Today is 2026-10-09.' }] })
    expect(out.blocks.map((b: any) => b.name)).toEqual(['currentDate', 'secret-guard'])
    const text = out.blocks[1].text
    expect(text).toContain('Protected keys (names only): LLM_API_KEY, PW.')
    expect(text).toContain('C:/ws/.env')
    expect(text).toContain('‹hidden: NAME›')
    expect(text).toContain('reference it as $NAME')
    expect(text).toContain('report only whether it worked')
    for (const value of [KEY, PW, 'canary_orders_production']) expect(text).not.toContain(value)
  })

  test('is built again on a re-read, as after a compaction', async ($, on) => {
    await start($, on, () => bashResult(''))
    const first: any = await $.prompt.context({ blocks: [] })
    const again: any = await $.prompt.context({ blocks: first.blocks })
    expect(again.blocks.filter((b: any) => b.name === 'secret-guard').length).toBe(1)
    expect(again.blocks[0].text).toBe(first.blocks[0].text)
  })
})

describe('content detector', () => {
  test('hides KEY=VALUE, KEY: VALUE and "KEY": "VALUE" by the key name', async ($, on) => {
    const stdout = [
      'export STRIPE_SECRET=canary-stripe-secret-value-01',
      'db_password: canary-yaml-password-02',
      '{"apiKey": "canary-json-api-key-03", "region": "ap-northeast-1"}',
      'docker run -e "SMTP_PASS=canary-docker-pass-04" app',
    ].join('\n')
    await bare($, on, () => bashResult(stdout))
    const text = shown(await run($, 'aws ssm describe-parameters'))
    for (const n of ['01', '02', '03', '04']) expect(text).not.toMatch(new RegExp(`canary-[a-z-]+-${n}`))
    for (const label of ['STRIPE_SECRET', 'db_password', 'apiKey', 'SMTP_PASS']) expect(text).toContain(`‹hidden: ${label}›`)
    expect(text).toContain('ap-northeast-1')
  })

  test('leaves references, types and code alone', async ($, on) => {
    const stdout = [
      'PASSWORD=$DB_PASSWORD',
      'TOKEN="${{ secrets.DEPLOY_TOKEN }}"',
      'apiKey: string',
      'const token = config.token,',
      'connect(password=password_var, host=h)',
      'MAX_TOKENS=4096',
      'PWD=/home/me/projects/acme',
      "h(Box, { key: 'plan-meter-band' })",
      'SSH_KEY=~/.ssh/id_ed25519_deploy',
    ].join('\n')
    await bare($, on, () => bashResult(stdout))
    const out = await run($, 'cat src/settings.py')
    expect(out.text).toBe(stdout)
  })

  test('hides only the password of a DSN', async ($, on) => {
    await bare($, on, () => bashResult('postgres://app_user:canary-dsn-pw-05@db.internal:5432/orders\n'))
    const text = shown(await run($, './print-url.sh'))
    expect(text).toContain('postgres://app_user:‹hidden: dsn-password›@db.internal:5432/orders')
  })

  test('hides an AWS access key id and the secret beside it, not a git hash', async ($, on) => {
    // Built at run time, so the source holds no string a secret scanner takes for a real key.
    const KEY_ID = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
    const SECRET = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYCANARY0001'].join('/')
    const SHA = '462f0ba1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4'
    await bare($, on, () => bashResult(`${KEY_ID},${SECRET}\ncommit ${SHA}\n`))
    const text = shown(await run($, 'cat credentials.csv'))
    expect(text).not.toContain(KEY_ID)
    expect(text).not.toContain(SECRET)
    expect(text).toContain('‹hidden: aws-secret-access-key›')
    expect(text).toContain(SHA)
  })

  test('hides a private key block and a JWT', async ($, on) => {
    const JWT_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJlLWNhbmFyeQ'
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAACANARY\n-----END OPENSSH PRIVATE KEY-----'
    await bare($, on, () => bashResult(`${pem}\nAuthorization: Bearer ${JWT_TOKEN}\n`))
    const text = shown(await run($, './debug.sh'))
    expect(text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAACANARY')
    expect(text).not.toContain(JWT_TOKEN)
    expect(text).toContain('‹hidden: private-key›')
    expect(text).toContain('Bearer ‹hidden: jwt›')
  })

  test("hides a Kubernetes Secret's data, in YAML and in JSON", async ($, on) => {
    const yaml = 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: app\ndata:\n  username: Y2FuYXJ5LXVzZXI=\n  url: Y2FuYXJ5LXVybC0wNg==\ntype: Opaque\n'
    const json = '{"apiVersion": "v1", "kind": "Secret", "data": {"username": "Y2FuYXJ5LWpzb24tMDc="}, "metadata": {"name": "app"}}'
    await bare($, on, () => bashResult(`${yaml}---\n${json}\n`))
    const text = shown(await run($, 'kubectl get secret app -o yaml > /tmp/app.yaml && cat /tmp/app.yaml'))
    for (const value of ['Y2FuYXJ5LXVzZXI=', 'Y2FuYXJ5LXVybC0wNg==', 'Y2FuYXJ5LWpzb24tMDc=']) expect(text).not.toContain(value)
    expect(text).toContain('name: app')
    expect(text).toContain('type: Opaque')
  })

  test('a value found beside its key is hidden where it shows up bare later', async ($, on) => {
    let n = 0
    await bare($, on, () => bashResult(n++ === 0 ? 'SESSION_TOKEN=canary0token0value0123\n' : 'login ok with canary0token0value0123\n'))
    await run($, './login.sh')
    const later = shown(await run($, './whoami.sh'))
    expect(later).not.toContain('canary0token0value0123')
    expect(later).toContain('‹hidden: SESSION_TOKEN›')
  })

  test('a value under a secret key in a structured result is hidden', async ($, on) => {
    await bare($, on, () => ({ result: { name: 'svc', clientSecret: 'canary-mcp-client-secret-08' }, text: 'svc' }))
    const out: any = await $.tool.call({ tool: 'mcp__demo__lookup', query: 'q' } as any)
    expect(out.result).toEqual({ name: 'svc', clientSecret: '‹hidden: clientSecret›' })
  })
})

describe('Edit and Write with a marker', () => {
  const FILE = 'C:/ws/project/app.conf'
  const conf = `LLM_API_KEY=${KEY}\nMODE=dev\n`

  test('puts the value back when the file already holds it', async ($, on) => {
    const seen = await startSession($, on, { 'C:/ws/.env': ENV, [FILE]: conf }, (e: any) =>
      ({ result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string }, text: 'ok' }))
    const out: any = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'LLM_API_KEY=‹hidden: LLM_API_KEY›\nMODE=dev', new_string: 'LLM_API_KEY=‹hidden: LLM_API_KEY›\nMODE=prod' } as any)
    expect(seen.calls[0].old_string).toBe(`LLM_API_KEY=${KEY}\nMODE=dev`)
    expect(seen.calls[0].new_string).toBe(`LLM_API_KEY=${KEY}\nMODE=prod`)
    // What comes back is scrubbed again.
    expect(JSON.stringify(out)).not.toContain(KEY)
  })

  test('refuses when the file does not hold the value: never spreads it', async ($, on) => {
    const seen = await startSession($, on, { 'C:/ws/.env': ENV, [FILE]: 'MODE=dev\n' }, () => bashResult('ok'))
    const out: any = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'MODE=dev', new_string: 'MODE=dev\nLLM_API_KEY=‹hidden: LLM_API_KEY›' } as any)
    expect(seen.calls.length).toBe(0)
    expect(out.deny).toContain('puts the real value back only into a file that already holds it')
  })

  test('refuses a Write of a new file holding a marker', async ($, on) => {
    const seen = await start($, on, () => bashResult('ok'))
    const out: any = await $.tool.call({ tool: 'Write', file_path: 'C:/ws/project/new.env', content: 'PW=‹hidden: PW›\n' } as any)
    expect(seen.calls.length).toBe(0)
    expect(out.deny).toContain('secret-guard')
  })

  test('never puts a value into a shell command', async ($, on) => {
    const seen = await start($, on, () => bashResult('ok'))
    const out: any = await run($, 'curl -H "Authorization: Bearer ‹hidden: LLM_API_KEY›" https://api.example.com')
    expect(seen.calls.length).toBe(0)
    expect(out.deny).toContain('Reference the variable instead ($LLM_API_KEY')
  })
})

describe('command blocklist in value mode', () => {
  const blocked = (command: string) => refusal(command, p => /(^|[\\/])\.env(\.(?!example$)[\w.-]+)?$/.test(p))

  test('refuses printing a protected file and names the sed alternative', async ($, on) => {
    const seen = await start($, on, () => bashResult('x'))
    const out: any = await run($, 'cat .env')
    expect(seen.calls.length).toBe(0)
    expect(out.deny).toContain("sed -E 's/=.*/=<hidden>/' .env")
    for (const command of ['head -5 ../.env.local', 'Get-Content .\\.env.prod', 'type .env | more', 'tail .env']) expect(blocked(command)).toContain('prints a protected env file')
  })

  test('refuses dumping the environment, not one variable or names only', () => {
    for (const command of ['env', 'printenv', 'set', 'Get-ChildItem env:', 'gci env:* | Out-Host', 'env | sort']) expect(blocked(command)).toContain('every environment variable')
    for (const command of ['env | cut -d= -f1', 'printenv HOME', 'set -a', 'set -euo pipefail', 'env FOO=1 ./run.sh', 'Get-ChildItem env: | Select-Object Name', 'env > /tmp/env.txt']) expect(blocked(command)).toBeUndefined()
  })

  test('lets a command load an env file without printing it', () => {
    for (const command of ['source .env && ./deploy.sh', '. ./.env.stag; ./migrate.sh', 'set -a; . .env; set +a', 'docker run --env-file .env.prod app', 'cat .env.example', "sed -E 's/=.*/=<hidden>/' .env", 'cat .env | cut -d= -f1']) {
      expect([command, blocked(command)]).toEqual([command, undefined])
    }
  })

  test('refuses decrypted cloud secrets on screen, not when captured or redirected', () => {
    expect(blocked('aws ssm get-parameter --name /app/db --with-decryption')).toContain('VALUE=$(aws ssm get-parameter')
    expect(blocked('aws secretsmanager get-secret-value --secret-id app')).toContain('--query SecretString')
    expect(blocked('kubectl get secret app -o yaml')).toContain('kubectl describe secret')
    expect(blocked('kubectl -n prod get secrets/app -ojson | jq .data')).toContain('kubectl describe secret')
    for (const command of [
      'export DB_PASS=$(aws ssm get-parameter --name /app/db --with-decryption --query Parameter.Value --output text)',
      'aws secretsmanager get-secret-value --secret-id app > /tmp/app.json',
      'kubectl get secret app -o yaml > app-secret.yaml',
      'kubectl get secrets',
      'kubectl get pods -o yaml',
    ]) expect([command, blocked(command)]).toEqual([command, undefined])
  })
})

describe('messages sent out', () => {
  test('a SendMessage text is scrubbed before it leaves', async ($, on) => {
    const seen = await start($, on, () => bashResult(''))
    const out: any = await $.session.send({ to: 'peer', origin: { kind: 'model' }, text: `deploy used ${KEY}; JWT_SECRET=canary-send-secret-value-09` })
    expect(out.isDelivered).toBe(true)
    expect(seen.sent.length).toBe(1)
    expect(seen.sent[0]).not.toContain(KEY)
    expect(seen.sent[0]).not.toContain('canary-send-secret-value-09')
    expect(seen.sent[0]).toContain('‹hidden: LLM_API_KEY›')
  })
})

describe('attachments the engine adds on its own', () => {
  test('a file attached again after a compaction is scrubbed', async ($, on) => {
    const seen = await start($, on, () => bashResult(''))
    const out: any = await $.prompt.attachment({ type: 'file', origin: { kind: 'engine' }, text: `Contents of app.conf:
LLM_API_KEY=${KEY}
MODE=prod` } as any)
    expect(out.text).not.toContain(KEY)
    expect(out.text).toContain('LLM_API_KEY=‹hidden: LLM_API_KEY›')
    expect(seen.log).toContain('hid LLM_API_KEY from a file attachment')
  })

  test('an attachment with nothing secret passes unchanged', async ($, on) => {
    await start($, on, () => bashResult(''))
    const out: any = await $.prompt.attachment({ type: 'todo_reminder', origin: { kind: 'engine' }, text: 'The task list is empty.' } as any)
    expect(out.text).toBe('The task list is empty.')
  })
})

describe('command mode', () => {
  test('denies cat .env', { options: { mode: 'command' } }, async ($, on) => {
    let ran = false
    await start($, on, () => { ran = true; return bashResult(`LLM_API_KEY=${KEY}\n`) })
    const out = await run($, 'cat .env')
    expect(ran).toBe(false)
    expect(out.deny).toContain('names a protected env file')
  })

  test('denies a .env.* file, lets a load through', { options: { mode: 'command' } }, async ($, on) => {
    await start($, on, () => bashResult('ok\n'))
    expect((await run($, 'cat .env.local')).deny).toContain('names a protected env file')
    for (const command of ['source .env && ./deploy.sh', 'docker run --env-file .env.prod app', 'ls']) {
      expect((await run($, command)).deny).toBeUndefined()
    }
  })

  test('does not match .venv or .env.example', { options: { mode: 'command' } }, async ($, on) => {
    await start($, on, () => bashResult('ok\n'))
    for (const command of ['ls .venv', 'cat .env.example']) {
      const out = await run($, command)
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
    const out: any = await run($, 'printenv LLM_API_KEY')
    expect(out.deny).toBe('blocked: LLM_API_KEY=‹hidden: LLM_API_KEY›')
  })

  test('an unreadable env file makes value mode refuse every call', async ($, on) => {
    let ran = false
    await startSession($, on, new Error('EACCES'), () => { ran = true; return bashResult('hello\n') })
    const out: any = await run($, 'echo hello')
    expect(ran).toBe(false)
    expect(out.deny).toBe('secret-guard has not loaded the env files, so this call was not run')
    const reply = await runCommand($, 'secret-guard')
    // The reason is the host's (a stub that throws is skipped, so the kit reports no implementation).
    expect(reply.text).toMatch(/^could not load C:.ws\/\.env \(.+\), so value mode refuses every tool call$/)
    const context: any = await $.prompt.context({ blocks: [] })
    expect(context.blocks[0].text).toContain('every tool call is refused this session')
  })

  test('before its start hook finishes, value mode refuses calls and messages and says so', async ($, on) => {
    let ran = false
    on('tool.call', () => { ran = true; return bashResult('hello\n') })
    on('command.run', () => ({ text: 'no hook answered' }))
    on('session.send', () => ({ isDelivered: true }))
    const out: any = await run($, 'echo hello')
    expect(ran).toBe(false)
    expect(out.deny).toBe('secret-guard has not loaded the env files, so this call was not run')
    const sent: any = await $.session.send({ to: 'peer', origin: { kind: 'model' }, text: 'hi' })
    expect(sent.isDelivered).toBe(false)
    const reply = await runCommand($, 'secret-guard')
    expect(reply.text).toBe('has not loaded the env files yet (its start hook did not finish), so value mode refuses every tool call')
  })

  test('a value held in an object key withholds the result', async ($, on) => {
    await start($, on, () => ({ result: { [KEY]: 'x' }, text: 'x' }))
    const out: any = await $.tool.call({ tool: 'mcp__demo__lookup', query: 'q' } as any)
    expect(shown(out)).not.toContain(KEY)
    expect(out.deny).toBe('secret-guard could not check this result, so it was withheld')
  })

  test('parses .env values as python-dotenv does, keeping secret keys only', () => {
    const parsed = parseEnv([
      'A_KEY="quoted-value-0001" # a comment',
      "B_KEY='single-quoted-02'",
      'C_KEY="escaped \\"quote\\" inside"',
      'D_KEY=plain-value-00004 # comment',
      'E_HOST=not-a-secret-host-05',
    ].join('\n'), NO_RULE)
    const byName = Object.fromEntries(parsed.map(s => [s.name, s.value]))
    expect(byName).toEqual({
      A_KEY: 'quoted-value-0001',
      B_KEY: 'single-quoted-02',
      C_KEY: 'escaped "quote" inside',
      D_KEY: 'plain-value-00004',
    })
  })

  test('a secret held as a number withholds the result; a non-secret number passes', async ($, on) => {
    await startSession($, on, 'PIN_SECRET=123456789012\nACCOUNT_ID=210987654321', (e: any) =>
      e.query === 'pin' ? { result: { id: 123456789012 }, text: 'id 123456789012' } : { result: { id: 210987654321 }, text: 'id 210987654321' })
    const out: any = await $.tool.call({ tool: 'mcp__demo__lookup', query: 'pin' } as any)
    expect(shown(out)).not.toContain('123456789012')
    expect(out.deny).toBe('secret-guard could not check this result, so it was withheld')
    const account: any = await $.tool.call({ tool: 'mcp__demo__lookup', query: 'account' } as any)
    expect(account.result).toEqual({ id: 210987654321 })
    const reply = await runCommand($, 'secret-guard')
    expect(reply.text).toContain('1 results withheld because they could not be checked')
  })

  // A pure check: on Windows the test host turns `/srv/app` into `C:\srv\app`, so a Unix layout can't be staged.
  test('the search for env files reaches the root on Unix and on Windows', () => {
    expect(ancestorDirs('/srv/app')).toEqual(['/srv/app', '/srv', '/'])
    expect(ancestorDirs('C:\\ws\\project\\')).toEqual(['C:\\ws\\project', 'C:\\ws', 'C:\\'])
  })

  test('command mode never reads the values', { options: { mode: 'command' } }, async ($, on) => {
    await startSession($, on, new Error('EACCES'), () => bashResult('a.txt\n'))
    const out: any = await run($, 'ls')
    expect(out.text).toBe('a.txt\n')
    expect((await runCommand($, 'secret-guard')).text).toBe('mode command: refuses any call whose command or path names a protected env file, except to load it; values are not read')
  })

  test('a file that cannot be parsed is skipped and named; the other files stay protected', async ($, on) => {
    const BAD = 'canary-test-bad-file-value-66ee'
    const seen = await startSession($, on, {
      'C:/ws/project/.env.rds': `RDS_PASSWORD="${BAD}`,
      'C:/ws/.env': ENV,
    }, () => bashResult(`${KEY}
`))
    const out = await run($, './check.sh')
    expect(out.text).toBeUndefined()
    expect(JSON.stringify(out)).toContain('‹hidden: LLM_API_KEY›')
    const warning = seen.status.find(t => String(t).includes('skipped'))
    expect(warning).toContain('C:/ws/project/.env.rds')
    expect(warning).toContain('a quoted value that does not close')
    const reply = (await runCommand($, 'secret-guard')).text
    expect(reply).toContain('protects 2 values from C:/ws/.env')
    expect(reply).toContain('skipped C:/ws/project/.env.rds (unsupported .env syntax on line 1')
    const context: any = await $.prompt.context({ blocks: [] })
    expect(context.blocks[0].text).toContain('could not parse C:/ws/project/.env.rds')
    // A skipped file is still one secret-guard will not print.
    expect((await run($, 'cat .env.rds')).deny).toContain('prints a protected env file')
    for (const text of [JSON.stringify(seen), reply, context.blocks[0].text]) expect(text).not.toContain(BAD)
  })

  test('a quoted value that does not close is refused, not guessed', () => {
    expect(() => parseEnv('A_KEY="opens-and-never-closes', NO_RULE)).toThrow()
  })
})
