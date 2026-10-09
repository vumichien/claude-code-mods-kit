// The shell commands secret-guard refuses: in value mode the few that print a whole env file, the whole
// environment or a decrypted secret to the screen, each refusal naming a way that does not print it; in
// command mode any call that names a protected file. Loading a file (source, --env-file) is always allowed.

import { MARKER } from './secrets'

export type IsProtected = (path: string) => boolean

const CAT_LIKE = new Set(['cat', 'type', 'get-content', 'gc', 'less', 'more', 'head', 'tail', 'bat'])
// Commands that pass on everything they are given: a dump piped into one of these still reaches the screen.
const DISPLAY = new Set(['cat', 'type', 'less', 'more', 'head', 'tail', 'bat', 'tee', 'sort', 'uniq', 'column', 'out-host', 'out-string', 'write-output', 'write-host', 'format-list', 'format-table'])
// Words in front of the command itself.
const PREFIXES = new Set(['sudo', 'command', 'exec', 'time', 'nohup', '&'])

const words = (text: string): string[] => (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^(["'])(.*)\1$/, '$2'))
const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
const commandName = (word: string) => baseName(word).toLowerCase().replace(/\.exe$/, '')

// The command and its arguments, past `FOO=1` assignments and `sudo`.
function parseStage(stage: string): { name: string; args: string[] } {
  const all = words(stage)
  let i = 0
  while (i < all.length && (/^[A-Za-z_]\w*=/.test(all[i] ?? '') || PREFIXES.has(commandName(all[i] ?? '')))) i += 1
  return { name: commandName(all[i] ?? ''), args: all.slice(i + 1) }
}

// Output sent to a file (`> out`, `>> out`, `| Out-File`), not `2>/dev/null` or `2>&1`.
const redirected = (statement: string) => /(^|[^0-9&<>])>>?(?!&)\s*\S|&>|\|\s*(out-file|set-content|add-content)\b|-OutFile\b/i.test(statement)
// Output captured into a variable: `X=$(...)`, `export X=$(...)`, PowerShell `$x = ...`.
const captured = (statement: string) => /^\s*(?:(?:export|local|readonly)\s+|declare\s+(?:-\w+\s+)*)?[A-Za-z_]\w*=["']?(?:\$\(|`)|^\s*\$[\w:]+\s*=/.test(statement)

const MARKER_TEXT = (label: string) => `secret-guard: this command holds ‹hidden: ${label}›, a placeholder for a secret, not its value. Reference the variable instead ($${label}, or $env:${label} in PowerShell), or let the command load its env file (source .env, set -a; . .env; set +a, or --env-file .env).`
const FILE_TEXT = (file: string) => `secret-guard: this prints a protected env file (${file}), secrets included. To see its key names: sed -E 's/=.*/=<hidden>/' ${file}. To use the values without printing them: source ${file} (or set -a; . ${file}; set +a, or --env-file ${file}), then reference $NAME.`
const ENV_TEXT = 'secret-guard: this prints every environment variable, secrets included. List the names only (env | cut -d= -f1; PowerShell: Get-ChildItem env: | Select-Object Name), or print one variable that is not a secret.'
const SSM_TEXT = 'secret-guard: this prints a decrypted SSM parameter. Capture it without printing it, VALUE=$(aws ssm get-parameter --name NAME --with-decryption --query Parameter.Value --output text), or redirect it to a file, then report only whether it worked.'
const SECRETS_MANAGER_TEXT = 'secret-guard: this prints a secret from Secrets Manager. Capture it without printing it, VALUE=$(aws secretsmanager get-secret-value --secret-id NAME --query SecretString --output text), or redirect it to a file, then report only whether it worked.'
const KUBECTL_TEXT = "secret-guard: this prints a Kubernetes Secret's data. Redirect it to a file (> secret.yaml), or see its key names and sizes only: kubectl describe secret NAME."

// Why a value-mode command is refused, or undefined to let it run.
export function refusal(command: string, isProtected: IsProtected): string | undefined {
  const label = new RegExp(MARKER.source).exec(command)?.[1]
  if (label !== undefined) return MARKER_TEXT(label)
  for (const statement of command.split(/\r?\n|;|&&|\|\|/)) {
    const hidden = redirected(statement) || captured(statement)
    const all = words(statement)
    const lower = all.map(w => w.toLowerCase())
    if (!hidden) {
      if (lower.some(w => w.startsWith('--with-decryption'))) return SSM_TEXT
      if (lower.includes('get-secret-value')) return SECRETS_MANAGER_TEXT
      if (lower.some(w => commandName(w) === 'kubectl') && lower.includes('get') && lower.some(w => /^secrets?(\/|$)/.test(w))
        && /(?:^|\s)(?:-o|--output)(?:\s+|=)?(?:yaml|json|jsonpath|go-template|template|custom-columns)/.test(lower.join(' '))) return KUBECTL_TEXT
    }
    const stages = statement.split('|').map(parseStage)
    for (let i = 0; i < stages.length; i++) {
      const { name, args } = stages[i] ?? { name: '', args: [] }
      // Whatever this stage prints reaches the screen: nothing after it but commands that pass it all on.
      const shown = !hidden && stages.slice(i + 1).every(s => DISPLAY.has(s.name))
      if (!shown) continue
      if (CAT_LIKE.has(name)) {
        const file = args.find(a => !a.startsWith('-') && isProtected(a))
        if (file !== undefined) return FILE_TEXT(file)
      }
      if ((name === 'env' || name === 'printenv' || name === 'set') && args.length === 0) return ENV_TEXT
      if (['get-childitem', 'gci', 'dir', 'ls'].includes(name) && args.some(a => /^env:\\?\*?$/i.test(a))) return ENV_TEXT
    }
  }
  return undefined
}

// The old rule (`.env` as a file token, also inside a glob such as `**/.env*`), not `.venv` or `.env.example`.
const ENV_FILE = /(?<![\w.])\.env(?![\w.])/
// Loading a file without printing it: `source X`, `. X`, `--env-file X`, `env_file: X`.
const LOADS = /(?:\bsource|(?:^|[\s;&|(])\.)\s+\S+|--env-file(?:=|\s+)\S+|env_file:\s*\S+/g

// Command mode: does any field of the call name a protected file, other than to load it?
export function namesProtectedFile(text: string, isProtected: IsProtected): boolean {
  const rest = text.replace(LOADS, ' ')
  return ENV_FILE.test(rest) || rest.split(/[\s'"=;|&<>()`,]+/).some(token => token !== '' && isProtected(token))
}
