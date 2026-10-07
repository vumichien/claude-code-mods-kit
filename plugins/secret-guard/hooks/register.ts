import type { Register } from 'claude-code'

import { envCandidates, failClosed, findSecrets, mentionsEnvFile, parseEnv, scrub } from './secrets'
import type { Secret } from './secrets'

// The input fields a person's first rule would look at for a file name.
const INPUT_FIELDS = ['command', 'file_path', 'path', 'pattern', 'glob'] as const

export const register: Register = (on, options) => {
  const mode = options.mode === 'command' ? 'command' : 'value'
  const identifiers = new Set(String(options.identifierKeys ?? '').split(',').map(k => k.trim()).filter(Boolean))
  // Values live in this module variable only: never in $.ui, $.store, $.state or a log.
  let secrets: Secret[] = []
  let envPath: string | undefined
  let hidden = 0
  // 'ready' once the .env was looked for and read (or there is none). Until then, or after a failure, value
  // mode refuses every call: a guard that silently loaded nothing would pass every value through.
  let loading: 'pending' | 'ready' | 'failed' = 'pending'
  let loadError = ''
  // Results withheld because the check itself failed (the .catch below).
  let withheld = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'secret-guard', description: 'Show which .env keys secret-guard protects' })
    // Command mode matches file names only, so it never reads the values.
    if (mode === 'command') {
      loading = 'ready'
      return next(e)
    }
    try {
      search: for (const start of [e.cwd, await $.session.root()]) {
        for (const file of envCandidates(start)) {
          if (await $.fs.exists(file)) {
            envPath = file
            break search
          }
        }
      }
      if (envPath !== undefined) secrets = parseEnv(await $.fs.read(envPath), identifiers)
      loading = 'ready'
    } catch (err) {
      loading = 'failed'
      loadError = err instanceof Error ? err.message : 'unknown error'
      $.ui.status('secret-guard: could not load .env, tool calls are refused')
    }
    return next(e)
  })

  on('command.run', { command: 'secret-guard' }, async () => {
    if (mode === 'command') return { text: 'mode command: refuses any call whose command or path names a .env file; values are not read' }
    if (loading === 'failed') return { text: `could not load ${envPath ?? '.env'} (${loadError}), so value mode refuses every tool call` }
    // The start hook has not finished: still running, or skipped by the engine (it overran its budget).
    if (loading === 'pending') return { text: 'has not loaded the .env yet (its start hook did not finish), so value mode refuses every tool call' }
    if (envPath === undefined) return { text: 'no .env found above this session, so nothing is protected' }
    const names = secrets.map(s => s.name).join(', ') || 'none'
    const failures = withheld > 0 ? `; ${withheld} results withheld because they could not be checked` : ''
    return { text: `mode ${mode}; protects ${secrets.length} keys from ${envPath}: ${names}; ${hidden} values hidden this session${failures}` }
  })

  on('tool.call', async ($, e, next) => {
    if (mode === 'command') {
      const input = e as unknown as Record<string, unknown>
      const named = INPUT_FIELDS.some(field => typeof input[field] === 'string' && mentionsEnvFile(input[field] as string))
      if (named) return { deny: 'secret-guard: this call reads a .env file. Print key names only: sed -E "s/=.*/=<hidden>/" .env' }
      return next(e)
    }

    if (loading !== 'ready') return { deny: 'secret-guard has not loaded the .env values, so this call was not run' }
    const ran = await next(e)
    if (secrets.length === 0) return ran
    // A refusal from beneath is read by the model too, so its reason is checked like a result.
    const found = findSecrets([ran.deny ?? '', ran.text ?? '', ran.result, ran.context ?? []], secrets)
    if (found.length === 0) return ran
    hidden += found.length
    $.ui.status(`secret-guard: ${hidden} hidden this session`)
    for (const name of found) $.ui.log(`hid ${name} from a ${e.tool} result`)
    if (ran.deny !== undefined) return { deny: scrub(ran.deny, secrets) as string }
    // An errored result has no typed record to answer with, so its scrubbed text goes back as the error.
    if (ran.isError) return { deny: scrub(ran.text ?? String(ran.result), secrets) as string }
    const context = ran.context?.map(c => scrub(c, secrets) as string)
    const answer = { result: scrub(ran.result, secrets) as typeof ran.result, ...(context ? { context } : {}) }
    // A value left after scrubbing (an object key, which scrub keeps so the shape stays valid) withholds the result.
    // So does a number, which cannot become a marker without breaking the result's shape.
    if (findSecrets([answer.result, answer.context ?? []], secrets).length > 0) {
      withheld += 1
      return failClosed(true, 'throw')
    }
    return answer
  }).catch(($, e, next) => {
    if (next.called) withheld += 1
    return failClosed(next.called, next.error.kind)
  })
}
