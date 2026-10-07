# claude-code-mods-kit

Three small [Claude Code](https://code.claude.com) mods, free to use under the MIT licence. A mod is a plugin made of function hooks: Claude Code calls it at every step (a tool call, a slash command, a redraw), and it can answer, change or watch that step.

| Mod | What it does | Command |
|---|---|---|
| **secret-guard** | Reads your project's `.env` when a session starts and hides those values in every tool result before Claude reads it. `cat .env` reaches Claude as `DEMO_API_KEY=‹hidden: DEMO_API_KEY›`. | `/secret-guard` lists the protected key names |
| **spark-band** | A one-line band above the prompt with a remote Linux machine's free memory, GPU processes and load, read over ssh every two minutes. Built for an NVIDIA DGX Spark; works with any Linux box you can `ssh` into with a key. | `/spark` reads it now |
| **article-meter** | A pane with your Markdown draft's words per numbered part (`## 1. …`), one part's share of the words, and how many placeholders are left. It updates when Claude edits the draft. | `/article` (or `/article docs/my-draft.md`) |

Tested on Claude Code 2.1.291 on Windows 11. Mods are an early-access feature, so the API can change between versions; if a mod stops loading after an update, check `claude plugin validate` on its folder.

## Try one without installing anything

```bash
git clone https://github.com/vumichien/claude-code-mods-kit.git
claude --plugin-dir claude-code-mods-kit/plugins/secret-guard
```

`--plugin-dir` loads the mod for that session only. Repeat the flag to load more than one.

## Install

```bash
claude plugin marketplace add vumichien/claude-code-mods-kit
claude plugin install secret-guard@chien-mods
claude plugin install article-meter@chien-mods
claude plugin install spark-band@chien-mods
echo '{"host":"<your ssh alias>"}' | claude plugin configure spark-band@chien-mods --values-stdin
```

Start a new session afterwards. To remove one: `claude plugin uninstall secret-guard@chien-mods`.

## Options

Set them with `/plugin configure <name>@chien-mods` inside Claude Code, or pipe a JSON object to `claude plugin configure <name>@chien-mods --values-stdin`, as above. With `--plugin-dir`, put them in a settings file: `--settings '{"pluginConfigs":{"spark-band":{"options":{"host":"spark"}}}}'`.

**secret-guard**

- `mode`: `value` (default) hides values in results. `command` instead refuses any call whose command or path names a `.env` file, without reading values; it is simpler, but it blocks harmless commands and misses reads that don't name the file.
- `identifierKeys`: comma-separated keys that hold names, not secrets (a login name that shows up in ordinary paths). They are never hidden. Values shorter than 12 characters are never hidden either.

**spark-band**

- `host`: the ssh alias to read. Empty (the default) leaves the band off.
- `onlyIn`: read the host automatically only in sessions whose folder path contains this text. Empty means every session. `/spark` always reads, wherever you are.
- `intervalSeconds` (default 120, at least 60) and `lowGb` (default 4; less free memory than this draws the band in the warning colour).

It runs one ssh login per read with `BatchMode=yes` and a 5-second connect timeout, and only reads: `free -g`, `/proc/loadavg`, and `nvidia-smi --query-compute-apps=used_memory` when the machine has it.

**article-meter**

- `draft`: the draft's path relative to the project (default `docs/*-draft.md`; with a `*`, the newest match wins).
- `markers`: comma-separated texts counted as work left (default `⟨,TODO`).
- `focusPart` and `focusShare`: the numbered part whose share of the words is drawn as a bar, and where its line sits (defaults 3 and 50). `focusPart` 0 hides the bar.

The pane draws in the terminal and the desktop app. Under `claude -p`, `/article` answers with one line instead.

## What secret-guard does not do

- **It is not a security boundary.** It hides exact copies of the values in your `.env`. In the author's tests it missed a base64-encoded copy and two partial prefixes of a value. To stop Claude from reading a file at all, use [permission deny rules](https://code.claude.com/docs/en/permissions) such as `Read(./.env)`, the sandbox, OS file permissions or a secrets manager.
- It reads the nearest `.env` at or above the folder where the session starts, at session start. A value added later is protected from the next session.
- When it cannot check a result, it withholds the result rather than letting it through. If the `.env` failed to load, it refuses every call and `/secret-guard` says why; if a check failed, or a value sat in a result as a number it can't replace, `/secret-guard` counts the results it withheld.
- It keeps the values in memory only: never in a file, a log, the status line or Claude Code's state.

## Before you install any mod

Mods are not sandboxed. A mod's hooks run with your permissions and can read files and start processes. These three are short; read them first. `claude plugin validate plugins/<name>` lists every hook a mod registers and every call it makes.

## How it was tested

- Each mod passes `claude plugin validate` and `claude plugin test` (`plugins/<name>/tests/`) and type-checks with `tsc`.
- In a throwaway folder holding a `.env` of fake canary values, a real Claude Code session (2.1.291, haiku) was asked to run `cat .env`, once with the mod loaded by `--plugin-dir` and once installed from this marketplace. Both times the tool result Claude received held two `‹hidden: …›` markers and no canary value. In a control session without the mod, both values reached Claude.

## Licence

MIT. See [LICENSE](LICENSE).
