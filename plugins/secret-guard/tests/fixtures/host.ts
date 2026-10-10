import { mock } from 'claude-code/testing'

// The host beneath secret-guard in a test: a workspace whose root holds the given .env, a tool whose
// answer each test sets, and the status and log lines the mod writes. Every stub is registered before
// the test's first $ call, as the kit requires, then the session starts.

// calls: the input each tool call reached the host with, after secret-guard (a refused call never arrives);
// sent: the text of each message that left the session.
export type Host = { status: unknown[]; log: unknown[]; calls: any[]; sent: string[]; answer: (e: any) => unknown }

// env is the text of C:/ws/.env, or a map from path to text for several files. A text given as an
// Error makes that read fail, as an unreadable file would. HOME is C:/home/me.
// stored: what secret-guard's store holds as the session starts (an earlier /secret-guard off: { enabled: false }).
type EnvText = string | Error
export async function startSession($: any, on: any, env: EnvText | Record<string, EnvText>, answer: (e: any) => unknown, stored: Record<string, unknown> = {}): Promise<Host> {
  const host: Host = { status: [], log: [], calls: [], sent: [], answer }
  mock.store(on, stored)
  const files: Record<string, EnvText> = typeof env === 'string' || env instanceof Error ? { 'C:/ws/.env': env } : env
  // The host hands paths back with either separator.
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
  const lookup = (path: string) => files[norm(path)]
  on('tool.call', ($: any, e: any) => { host.calls.push(e); return host.answer(e) })
  on('session.root', () => ({ value: 'C:/ws' }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:/home/me' : undefined }))
  // A folder lists the files under it and the folders that lead to them.
  on('fs.list', ($: any, e: any) => {
    const dir = norm(e.path)
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    const entries = new Map<string, string>()
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length).split('/')
      entries.set(rest[0] ?? '', rest.length > 1 ? 'dir' : 'file')
    }
    return { value: [...entries].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($: any, e: any) => {
    const text = lookup(e.path)
    if (text === undefined) throw new Error('unexpected read ' + e.path)
    if (text instanceof Error) throw text
    return { value: text }
  })
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.status', ($: any, e: any) => { host.status.push(e.text); return { value: undefined } })
  on('ui.log', ($: any, e: any) => { host.log.push(e.text); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: 'no hook answered' }))
  on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))
  on('prompt.attachment', ($: any, e: any) => ({ text: e.text }))
  on('session.send', ($: any, e: any) => { host.sent.push(e.text); return { isDelivered: true } })
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
