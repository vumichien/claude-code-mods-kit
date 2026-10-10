// The mod's on/off switch, `/<mod> on|off|status`. The value is kept in $.store under STORE_KEY: one store per
// plugin, shared by every session and folder, so the switch holds across restarts. A session reads it as it
// starts and when its own command changes it; a session already open elsewhere picks a change up when it next
// starts. Pure helpers only: `claude plugin validate` follows `$` only within the file that uses it.
export const STORE_KEY = 'enabled'

export type SwitchWord = 'on' | 'off' | 'status'

// The command's argument as a switch word: '' and 'status' ask, 'on' and 'off' set; anything else is the mod's own.
export function switchWord(args: string | undefined): SwitchWord | undefined {
  const word = (args ?? '').trim().toLowerCase()
  if (word === '' || word === 'status') return 'status'
  return word === 'on' || word === 'off' ? word : undefined
}

// The stored value, or the mod's default when it was never set (or holds something else).
export function storedSwitch(value: unknown, byDefault: boolean): boolean {
  return typeof value === 'boolean' ? value : byDefault
}

export function switchText(mod: string, isOn: boolean): string {
  return isOn ? `on (/${mod} off turns it off)` : `off (/${mod} on turns it on)`
}
