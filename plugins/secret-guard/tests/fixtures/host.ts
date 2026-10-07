// The host beneath secret-guard in a test: a workspace whose root holds the given .env, a tool whose
// answer each test sets, and the status and log lines the mod writes. Every stub is registered before
// the test's first $ call, as the kit requires, then the session starts.

export type Host = { status: unknown[]; log: unknown[]; answer: (e: any) => unknown }

// envText as an Error makes the read fail, as an unreadable file would.
export async function startSession($: any, on: any, envText: string | Error, answer: (e: any) => unknown): Promise<Host> {
  const host: Host = { status: [], log: [], answer }
  // The host hands paths back with either separator.
  const isEnv = (path: string) => path.replace(/\\/g, '/') === 'C:/ws/.env'
  on('tool.call', ($: any, e: any) => host.answer(e))
  on('session.root', () => ({ value: 'C:/ws' }))
  on('fs.exists', ($: any, e: any) => ({ value: isEnv(e.path) }))
  on('fs.read', ($: any, e: any) => {
    if (!isEnv(e.path)) throw new Error('unexpected read ' + e.path)
    if (envText instanceof Error) throw envText
    return { value: envText }
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
