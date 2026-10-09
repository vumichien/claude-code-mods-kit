import type { Register } from 'claude-code'

import { namesProtectedFile, refusal } from './commands'
import { DEFAULT_SECRET_FILES, findSecretFiles, isProtectedName, parseFileRules } from './files'
import { MARKER, Vault, failClosed, fill, mergeSecrets, nameSet, parseEnv, resolveMarkers } from './secrets'
import type { Secret } from './secrets'

// The input fields a person's first rule would look at for a file name.
const INPUT_FIELDS = ['command', 'file_path', 'path', 'pattern', 'glob'] as const
const SHELLS = new Set(['Bash', 'PowerShell'])
// The context block's name: Claude reads it as `# secret-guard` in the first message of every conversation.
const BLOCK = 'secret-guard'
const MAX_NAMES = 80

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
const hasMarker = (text: string) => new RegExp(MARKER.source).test(text)

type Input = Record<string, unknown>
type Texts = { path: string; texts: { text: string; isOld: boolean }[]; fill: (values: ReadonlyMap<string, string>) => Input }

// The text fields of a call that writes a file, and how to put values back into them.
function writerTexts(input: Input): Texts | undefined {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const swap = (fields: string[]) => (values: ReadonlyMap<string, string>) =>
    ({ ...input, ...Object.fromEntries(fields.map(f => [f, fill(str(input[f]), values)])) })
  switch (input.tool) {
    case 'Edit':
      return { path: str(input.file_path), texts: [{ text: str(input.old_string), isOld: true }, { text: str(input.new_string), isOld: false }], fill: swap(['old_string', 'new_string']) }
    case 'Write':
      return { path: str(input.file_path), texts: [{ text: str(input.content), isOld: false }], fill: swap(['content']) }
    case 'NotebookEdit':
      return { path: str(input.notebook_path), texts: [{ text: str(input.new_source), isOld: false }], fill: swap(['new_source']) }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : []
      return {
        path: str(input.file_path),
        texts: edits.flatMap(e => [{ text: str(e.old_string), isOld: true }, { text: str(e.new_string), isOld: false }]),
        fill: values => ({ ...input, edits: edits.map(e => ({ ...e, old_string: fill(str(e.old_string), values), new_string: fill(str(e.new_string), values) })) }),
      }
    }
    default:
      return undefined
  }
}

// The status line and one log line per name hidden (names only, never a value).
function report($: { ui: { status: (text: string) => unknown; log: (text: string) => unknown } }, hidden: number, found: ReadonlySet<string>, where: string): void {
  $.ui.status(`secret-guard: ${hidden} hidden this session`)
  for (const name of found) $.ui.log(`hid ${name} from ${where}`)
}

const RESTORE_TEXT = (tool: string, path: string) => `secret-guard: this ${tool} holds ‹hidden: …›, a placeholder for a secret value. secret-guard puts the real value back only into a file that already holds it, and ${path || 'the target file'} does not, or holds several values it could stand for. Edit around the value (pick an old_string without the placeholder), or write the file with a command that reads the value from its env file without printing it.`

export const register: Register = (on, options) => {
  const mode = options.mode === 'command' ? 'command' : 'value'
  const rule = { extra: nameSet(options.secretKeys), identifiers: nameSet(options.identifierKeys) }
  const fileRules = parseFileRules(String(options.secretFiles ?? '').trim() || DEFAULT_SECRET_FILES)
  // Values live in the Vault only: never in $.ui, $.store, $.state, a log or the context block.
  let fileSecrets: Secret[] = []
  let vault = new Vault([], rule)
  // The env files found, nearest first, and the one being looked at (named if loading fails).
  const envPaths: string[] = []
  let current: string | undefined
  let hidden = 0
  // 'ready' once the env files were looked for and read (or there are none). Until then, or after a failure,
  // value mode refuses every call: a guard that silently loaded nothing would pass every value through.
  let loading: 'pending' | 'ready' | 'failed' = 'pending'
  let loadError = ''
  // Results withheld because the check itself failed (the .catch below).
  let withheld = 0
  // The context block was built before the files were loaded, so it is rebuilt once they are.
  let contextStale = false

  const isProtected = (path: string) => {
    const name = baseName(path)
    return isProtectedName(name, fileRules) || envPaths.some(p => baseName(p) === name)
  }

  const contextText = (): string => {
    const use = 'To use a secret, reference it as $NAME (PowerShell: $env:NAME), or let the command or script load the env file: source FILE, set -a; . FILE; set +a, or --env-file FILE.'
    const never = 'Never echo, cat or otherwise print a protected file or a secret value. To check a credential, run the command that uses it and report only whether it worked.'
    if (mode === 'command') return [`secret-guard refuses any tool call that names a protected env file (such as .env or .env.local), except to load it.`, use, never].join('\n')
    if (loading === 'failed') return `secret-guard could not load ${current ?? 'an env file'}, so every tool call is refused this session. Tell the user; \`claude plugin disable secret-guard@chien-mods\` turns it off.`
    const names = [...new Set(fileSecrets.map(s => s.name))]
    const shown = names.slice(0, MAX_NAMES).join(', ') + (names.length > MAX_NAMES ? ` and ${names.length - MAX_NAMES} more` : '')
    const head = loading === 'pending'
      ? 'secret-guard is loading the env files of this session.'
      : envPaths.length === 0
        ? 'secret-guard found no env file above this session.'
        : `secret-guard protects the secrets in ${envPaths.join(', ')}. Protected keys (names only): ${shown || 'none'}.`
    return [
      head,
      'In tool results a secret shows as ‹hidden: NAME›, where NAME is its key or a kind (jwt, private-key, dsn-password, aws-secret-access-key, k8s-secret). It is a placeholder, not the value: never put it in a command. In an Edit or Write, secret-guard puts the real value back only into a file that already holds it.',
      use,
      never,
    ].join('\n')
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'secret-guard', description: 'Show which env files and keys secret-guard protects' })
    // Command mode matches file names only, so it never reads the values.
    if (mode === 'command') {
      loading = 'ready'
      return next(e)
    }
    try {
      // session.start can fire again in one load (an enable, a worker respawn): start the list over.
      envPaths.length = 0
      loading = 'pending'
      const home = fileRules.paths.some(p => p.startsWith('~/')) ? ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))) : undefined
      // Every protected file from the session's folder up to the root, so a project's own .env does not hide
      // the workspace .env above it. The two starts usually share their upper folders, so each is looked at once.
      envPaths.push(...await findSecretFiles(dir => $.fs.list(dir), [e.cwd, await $.session.root()], fileRules, home))
      const lists: Secret[][] = []
      for (const file of envPaths) {
        current = file
        lists.push(parseEnv(String(await $.fs.read(file)), rule))
      }
      fileSecrets = mergeSecrets(lists)
      vault = new Vault(fileSecrets, rule)
      loading = 'ready'
    } catch (err) {
      loading = 'failed'
      loadError = err instanceof Error ? err.message : 'unknown error'
      $.ui.status('secret-guard: could not load an env file, tool calls are refused')
    }
    if (contextStale) await $.ui.invalidate('prompt.context')
    return next(e)
  })

  // A standing note in the first message of every conversation (and again after a compaction or /clear): the
  // protected key names, what a marker means and how to use a secret without printing it. Names only.
  on('prompt.context', async ($, e, next) => {
    const below = await next(e)
    contextStale = loading === 'pending'
    return { ...below, blocks: [...below.blocks.filter(b => b.name !== BLOCK), { name: BLOCK, text: contextText() }] }
  })

  on('command.run', { command: 'secret-guard' }, async () => {
    if (mode === 'command') return { text: 'mode command: refuses any call whose command or path names a protected env file, except to load it; values are not read' }
    if (loading === 'failed') return { text: `could not load ${current ?? 'an env file'} (${loadError}), so value mode refuses every tool call` }
    // The start hook has not finished: still running, or skipped by the engine (it overran its budget).
    if (loading === 'pending') return { text: 'has not loaded the env files yet (its start hook did not finish), so value mode refuses every tool call' }
    const counts = `${hidden} values hidden this session${withheld > 0 ? `; ${withheld} results withheld because they could not be checked` : ''}`
    if (envPaths.length === 0) return { text: `mode value; no env file found above this session; values that look like secrets are still hidden; ${counts}` }
    const names = [...new Set(fileSecrets.map(s => s.name))].join(', ') || 'none'
    return { text: `mode value; protects ${fileSecrets.length} values from ${envPaths.join(', ')}: ${names}; ${counts}` }
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Input
    if (mode === 'command') {
      const named = INPUT_FIELDS.some(field => typeof input[field] === 'string' && namesProtectedFile(input[field] as string, isProtected))
      if (named) return { deny: 'secret-guard: this call names a protected env file. Print key names only: sed -E "s/=.*/=<hidden>/" .env, or load it without printing: source .env, --env-file .env' }
      return next(e)
    }

    if (loading !== 'ready') return { deny: 'secret-guard has not loaded the env files, so this call was not run' }
    if (SHELLS.has(e.tool)) {
      const why = refusal(typeof input.command === 'string' ? input.command : '', isProtected)
      if (why !== undefined) return { deny: why }
    }
    let call = e
    const writer = writerTexts(input)
    if (writer !== undefined && writer.texts.some(t => hasMarker(t.text))) {
      let fileText = ''
      try {
        fileText = String(await $.fs.read(writer.path))
      } catch {
        // A new file holds no value to put back.
      }
      const values = resolveMarkers(writer.texts, fileText, label => vault.values(label))
      if (values === undefined) return { deny: RESTORE_TEXT(e.tool, writer.path) }
      call = writer.fill(values) as unknown as typeof e
      $.ui.log(`put ${values.size} hidden values back into ${writer.path}`)
    }

    const ran = await next(call)
    const found = new Set<string>()
    const where = `a ${e.tool} result`
    // A refusal from beneath is read by the model too, so its reason is checked like a result.
    if (ran.deny !== undefined) {
      const deny = vault.scrubText(ran.deny, found)
      if (found.size === 0) return ran
      hidden += found.size
      report($, hidden, found, where)
      return { deny }
    }
    // An errored result has no typed record to answer with, so its scrubbed text goes back as the error.
    if (ran.isError) {
      const text = vault.scrubText(ran.text ?? String(ran.result), found)
      if (found.size === 0 && vault.find([ran.result]).length === 0) return ran
      hidden += found.size
      report($, hidden, found, where)
      return { deny: text }
    }
    vault.scrubText(ran.text ?? '', found)
    const result = vault.scrub(ran.result, found) as typeof ran.result
    const context = ran.context?.map(c => vault.scrubText(c, found))
    // A value left after scrubbing (an object key, which scrub keeps so the shape stays valid) withholds the result.
    // So does a number, which cannot become a marker without breaking the result's shape.
    if (vault.find([result, context ?? []]).length > 0) {
      withheld += 1
      return failClosed(true, 'throw')
    }
    if (found.size === 0) return ran
    hidden += found.size
    report($, hidden, found, where)
    return { result, ...(context ? { context } : {}) }
  }).catch(($, e, next) => {
    if (next.called) withheld += 1
    return failClosed(next.called, next.error.kind)
  })

  // A message to another agent or session (SendMessage) leaves this conversation: scrub it the same way.
  on('session.send', async ($, e, next) => {
    if (mode === 'command') return next(e)
    if (loading !== 'ready') return { isDelivered: false, reason: 'secret-guard has not loaded the env files, so this message was not sent' }
    const found = new Set<string>()
    const text = vault.scrubText(e.text, found)
    if (found.size === 0) return next(e)
    hidden += found.size
    report($, hidden, found, 'a message sent out')
    return next({ ...e, text })
  }).catch(() => ({ isDelivered: false, reason: 'secret-guard could not check this message, so it was not sent' }))
}
