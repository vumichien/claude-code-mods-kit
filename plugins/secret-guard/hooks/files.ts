// Which env files secret-guard reads: the `secretFiles` globs, looked for from the session's folder up to the
// drive root (a bare file name) or at a path of their own (`~/secrets/**/.env`).

export const DEFAULT_SECRET_FILES = '.env, .env.*, !*.example'

export type FileRules = {
  // File-name globs, looked for in every folder from the session's up to the root.
  names: RegExp[]
  // Path globs (they hold a `/`), from the home folder (`~/`), absolute, or relative to the session's folder.
  paths: string[]
  // `!glob`: a file whose name (or, for a glob with a `/`, whose path) matches is never read.
  excludes: RegExp[]
}

// `*` and `?` stay inside one folder; `**` crosses folders.
export function globRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? ''
    if (ch === '*' && glob[i + 1] === '*') {
      source += '.*'
      i += 1
    } else if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

const hasSlash = (text: string) => /[\\/]/.test(text)
const slashes = (path: string) => path.replace(/\\/g, '/')

export function parseFileRules(option: unknown): FileRules {
  const rules: FileRules = { names: [], paths: [], excludes: [] }
  for (const entry of String(option ?? '').split(',').map(e => e.trim()).filter(Boolean)) {
    if (entry.startsWith('!')) rules.excludes.push(globRegExp(slashes(entry.slice(1))))
    else if (hasSlash(entry)) rules.paths.push(slashes(entry))
    else rules.names.push(globRegExp(entry))
  }
  return rules
}

export function excluded(path: string, rules: FileRules): boolean {
  const full = slashes(path)
  const name = full.slice(full.lastIndexOf('/') + 1)
  return rules.excludes.some(re => re.test(name) || re.test(full))
}

// A file name (no folder) the name globs protect: what the command checks match a path's last part against.
export function isProtectedName(name: string, rules: FileRules): boolean {
  return rules.names.some(re => re.test(name)) && !excluded(name, rules)
}

// The folder itself, then each parent up to and including the root (`C:\`, `/`), nearest first.
// Each keeps the start's own separator, so a path /secret-guard shows reads as one path.
export function ancestorDirs(start: string): string[] {
  const sep = start.includes('\\') ? '\\' : '/'
  const out: string[] = []
  let dir = start.replace(/[\\/]+$/, '')
  for (;;) {
    const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
    if (cut < 0) {
      // `C:` alone means the drive's current folder, so the root is listed as `C:\`; an empty dir is Unix's `/`.
      out.push(`${dir}${sep}`)
      return out
    }
    out.push(dir)
    dir = dir.slice(0, cut)
  }
}

export function join(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

export type Entry = { name: string; kind: string }
export type Lister = (dir: string) => Promise<readonly Entry[]>

// Folders a `**` never walks into, and how far it goes, so a broad glob cannot stall the session's start.
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__'])
const MAX_DEPTH = 8
const MAX_DIRS = 2000

// A folder that cannot be listed (missing, no permission) holds nothing secret-guard could read either.
async function listed(list: Lister, dir: string): Promise<readonly Entry[]> {
  try {
    return await list(dir)
  } catch {
    return []
  }
}

// Every protected file, nearest first: the name globs in each folder from each start up to the root, then each
// path glob. A file is listed once, by the first spelling found.
export async function findSecretFiles(list: Lister, starts: readonly string[], rules: FileRules, home: string | undefined): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (path: string) => {
    const key = slashes(path)
    if (seen.has(key) || excluded(path, rules)) return
    seen.add(key)
    out.push(path)
  }
  const looked = new Set<string>()
  if (rules.names.length > 0) {
    for (const start of starts) {
      for (const dir of ancestorDirs(start)) {
        if (looked.has(slashes(dir))) continue
        looked.add(slashes(dir))
        const names = (await listed(list, dir)).filter(e => e.kind !== 'dir' && rules.names.some(re => re.test(e.name))).map(e => e.name).sort()
        for (const name of names) add(join(dir, name))
      }
    }
  }
  let budget = MAX_DIRS
  const walk = async (dir: string, segs: readonly string[], depth: number): Promise<void> => {
    const [seg, ...rest] = segs
    if (seg === undefined || budget <= 0) return
    budget -= 1
    const entries = await listed(list, dir)
    if (seg === '**') {
      await walk(dir, rest, depth)
      if (depth >= MAX_DEPTH) return
      for (const e of entries) if (e.kind === 'dir' && !SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), segs, depth + 1)
      return
    }
    const re = globRegExp(seg)
    for (const e of entries) {
      if (!re.test(e.name)) continue
      if (rest.length === 0) {
        if (e.kind !== 'dir') add(join(dir, e.name))
      } else if (e.kind === 'dir') await walk(join(dir, e.name), rest, depth)
    }
  }
  for (const pattern of rules.paths) {
    let base: string
    let rel: string
    if (pattern.startsWith('~/')) {
      if (home === undefined) continue
      base = home
      rel = pattern.slice(2)
    } else if (/^[A-Za-z]:\//.test(pattern)) {
      base = `${pattern.slice(0, 2)}\\`
      rel = pattern.slice(3)
    } else if (pattern.startsWith('/')) {
      base = '/'
      rel = pattern.slice(1)
    } else {
      base = starts[0] ?? '.'
      rel = pattern.replace(/^\.\//, '')
    }
    await walk(base, rel.split('/').filter(Boolean), 0)
  }
  return out
}
