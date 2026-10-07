// Pure path helpers for plan-meter: Windows and Unix paths, compared the way each file system would.

export function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(path)
}

// Windows paths (a drive letter or a network share) compare without case; Unix paths with it.
export function caseless(path: string): boolean {
  return /^([A-Za-z]:|[\\/]{2})/.test(path)
}

// Forward slashes, `.` and `..` segments applied, case kept, a network share's leading `//` kept.
export function normalize(path: string): string {
  const share = /^[\\/]{2}[^\\/]/.test(path)
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 1) out.pop()
    else if (part !== '..') out.push(part)
  }
  return (share ? '/' : '') + out.join('/')
}

// A path relative to `base` unless absolute, normalized.
export function resolvePath(base: string, path: string): string {
  const clean = path.trim()
  return normalize(isAbsolute(clean) ? clean : `${base}/${clean}`)
}

export function dirname(path: string): string {
  const full = normalize(path)
  return full.slice(0, Math.max(0, full.lastIndexOf('/')))
}

function fold(path: string, like: string): string {
  return caseless(like) ? path.toLowerCase() : path
}

// The path relative to the project when it lies inside it.
export function relativeTo(root: string, path: string): string {
  const base = normalize(root)
  const full = normalize(path)
  return fold(full, base).startsWith(`${fold(base, base)}/`) ? full.slice(base.length + 1) : full
}

export function samePath(a: string, b: string): boolean {
  return fold(normalize(a), a) === fold(normalize(b), a)
}

// One segment of a pattern as a test for a name: `*` matches any run of characters; case is ignored on Windows.
export function segmentTest(segment: string, ignoreCase = true): RegExp {
  return new RegExp(`^${segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, ignoreCase ? 'i' : '')
}

export function candidates(option: unknown): string[] {
  return String(option ?? '').split(',').map(p => p.trim()).filter(Boolean)
}
