// The host beneath secret-guard in a test: a workspace whose root holds the given .env, a tool whose
// answer each test sets, and the status and log lines the mod writes. Every stub is registered before
// the test's first $ call, as the kit requires, then the session starts.

export type Host = { status: unknown[]; log: unknown[]; answer: (e: any) => unknown }

// env is the text of C:/ws/.env, or a map from path to text for several .env files. A text given as an
// Error makes that read fail, as an unreadable file would.
type EnvText = string | Error
export async function startSession($: any, on: any, env: EnvText | Record<string, EnvText>, answer: (e: any) => unknown): Promise<Host> {
  const host: Host = { status: [], log: [], answer }
  const files: Record<string, EnvText> = typeof env === 'string' || env instanceof Error ? { 'C:/ws/.env': env } : env
  // The host hands paths back with either separator.
  const lookup = (path: string) => files[path.replace(/\\/g, '/')]
  on('tool.call', ($: any, e: any) => host.answer(e))
  on('session.root', () => ({ value: 'C:/ws' }))
  on('fs.exists', ($: any, e: any) => ({ value: lookup(e.path) !== undefined }))
  on('fs.read', ($: any, e: any) => {
    const text = lookup(e.path)
    if (text === undefined) throw new Error('unexpected read ' + e.path)
    if (text instanceof Error) throw text
    return { value: text }
  })
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.status', ($: any, e: any) => { host.status.push(e.text); return { value: undefined } })
  on('ui.log', ($: any, e: any) => { host.log.push(e.text); return { value: undefined } })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: 'no hook answered' }))
  await $.session.start({ cwd: 'C:/ws/project', surface: null, isInteractive: false })
  return host
}

export function bashResult(stdout: string) {
  return { result: { stdout, stderr: '', interrupted: false }, text: stdout }
}

// What Claude would read from a guard's answer: a deny's reason, or the result's text and record.
export function shown(out: any): string {
  return out.deny !== undefined ? String(out.deny) : JSON.stringify([out.text ?? '', out.result ?? null, out.context ?? []])
}
