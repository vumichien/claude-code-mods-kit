# claude-code-mods-kit

Four small [Claude Code](https://code.claude.com) mods, free to use under the MIT licence. A mod is a plugin made of function hooks: Claude Code calls it at every step (a tool call, a slash command, a redraw), and it can answer, change or watch that step.

| Mod | What it does | Command |
|---|---|---|
| **secret-guard** | Reads every `.env` and `.env.*` from your session's folder up to the drive root when a session starts and hides their secret values (keys named like `PASSWORD`, `SECRET`, `TOKEN`, `API_KEY`) in every tool result before Claude reads it, along with anything that looks like a secret on its own: `KEY=VALUE` under such a name, the password in `postgres://user:pass@host`, private keys, JWTs, AWS keys, Kubernetes Secret data. A secret reaches Claude as `‹hidden: DB_PASSWORD›`. It tells Claude, in every conversation, to use `$DB_PASSWORD` instead of printing the value, and it refuses the few commands that would print a whole env file or a decrypted secret. | `/secret-guard` lists the protected files and key names |
| **plan-meter** | A one-line band above the prompt that says how far your plan is: `plan ▸ Ship the export · phases 1/3 · steps 3/6 (50%) · now: API · Claude's tasks 2/5`. It reads your plan file (and the phase files it links to) in [many formats](#plan-formats-plan-meter-reads), and Claude's own task list. It updates when a file changes. | `/plan-meter on` / `/plan-meter off` shows or hides the band; `/plan-meter` opens a pane with the details; `/plan-meter docs/roadmap.md` picks a file |
| **done-gate** | When Claude marks a task done while code it changed has not been tested since, it tells Claude, in the tool result Claude reads, and you, in a toast. A band shows the last test run: `done-gate ▸ tests ✔ passed 4 min ago · 2 files changed since`. **It warns; it never blocks.** | `/done-gate on` / `/done-gate off` shows or hides the band; `/done-gate` lists the changed files and the last test command |
| **context-meter** | A band above the prompt with what fills the context window, by category and in `/context`'s colours (`context ▸ 90k of 1M · 9% · compacts at 987k`), and a countdown to when the prompt cache expires, which turns from green through amber to red: `cache ▸ 41:07 left (1h TTL, assumed: subscription)`. A **Compact** button (or `c` while the band has focus) runs the same compaction as `/compact`. | `/context-meter` shows or hides the band (`on` / `off` to set it); the button |

Tested on Claude Code 2.1.291 on Windows 11. Mods are an early-access feature, so the API can change between versions; if a mod stops loading after an update, check `claude plugin validate` on its folder.

## Try one without installing anything

```bash
git clone https://github.com/vumichien/claude-code-mods-kit.git
claude --plugin-dir claude-code-mods-kit/plugins/plan-meter
```

`--plugin-dir` loads the mod for that session only. Repeat the flag to load more than one.

## Install

```bash
claude plugin marketplace add vumichien/claude-code-mods-kit
claude plugin install secret-guard@chien-mods
claude plugin install plan-meter@chien-mods
claude plugin install done-gate@chien-mods
claude plugin install context-meter@chien-mods
```

Start a new session afterwards. To remove one: `claude plugin uninstall plan-meter@chien-mods`.

**The bands start hidden.** plan-meter, done-gate and context-meter each draw a band above the prompt, but only when you ask: type `/plan-meter on`, `/done-gate on` or `/context-meter on` when you want to see it, and `off` to hide it again (a bare `/context-meter` flips it). The choice lasts for the session. Hiding a band changes only what is drawn: the plan is still read, done-gate still tells Claude when a task is marked done too early, and context-meter still measures, so a band is current the moment it comes back. To have a band from the start, set that mod's `band` option to `on`.

## Options

Every option has a default, so all four mods work without any. plan-meter, done-gate and context-meter share one: `band`, `off` (default) or `on`, whether the band shows before you switch it with its command. To change one, use `/plugin configure <name>@chien-mods` inside Claude Code, pass `--config key=value` to `claude plugin install`, or pipe a JSON object to `claude plugin configure <name>@chien-mods --values-stdin`. With `--plugin-dir`, put them in a settings file: `--settings '{"pluginConfigs":{"done-gate":{"options":{"testCommands":"make ci"}}}}'`.

**secret-guard**

- `mode`: `value` (default) hides secrets in results and refuses the commands listed below. `command` instead refuses any call whose command or path names a protected env file, except to load it (`source .env`, `--env-file .env`), without reading values or changing results; it is simpler, but it blocks harmless commands and misses reads that don't name the file.
- `secretFiles` (default `.env, .env.*, !*.example`): comma-separated globs of the env files to read. A file name is looked for in the session's folder and every folder above it, up to the drive root. A path is read where it points: `~/vault/**/.env` (from your home folder; `**` goes up to 8 folders deep and skips `node_modules`, `.git`, `.venv`, `venv` and `__pycache__`), an absolute path, or one relative to the session's folder. `!glob` leaves files out. Each file must be in `.env` format.
- `secretKeys`: comma-separated key names to treat as secrets on top of the built-in rule. The rule: a key is a secret when a part of its name (split at `_`, `-`, `.` and camelCase) is `PASS`, `PASSWD`, `PASSWORD`, `PW`, `PWD`, `SECRET`, `TOKEN`, `KEY`, `DSN`, `CREDENTIAL` or `PRIVATE`, or ends with one of the first seven (`APIKEY`, `DBPASS`). So `DB_PASSWORD`, `apiKey` and `AWS_SECRET_ACCESS_KEY` are secrets; `DB_NAME`, `DB_HOST`, `ACCOUNT_ID`, `MAX_TOKENS`, `TOKENIZER_PATH` and the shell's own `PWD` are not.
- `identifierKeys`: comma-separated keys that match the rule but hold names, not secrets (`KMS_KEY_ID`, `SSH_KEY_NAME`). They are never hidden.

Values shorter than 8 characters are never hidden (except the password in a URL such as `postgres://user:pass@host`, which is always hidden), so `PW=1` or `TOKEN_TTL=60` does not mask every `1` or `60`. The values of non-secret keys are never hidden at all, so database names, hosts, users and account ids stay readable.

In value mode it refuses these commands, each time naming a way to do the same without printing the secret: `cat`, `type`, `Get-Content`, `less`, `more`, `head`, `tail` or `bat` of a protected file (`cat .env | cut -d= -f1` is allowed, it prints names); a bare `env`, `printenv`, `set` or `Get-ChildItem env:`; and, unless the output goes to a file or a variable (`> out.json`, `VALUE=$(...)`), `aws ssm ... --with-decryption`, `aws secretsmanager get-secret-value` and `kubectl get secret ... -o yaml|json`. It never refuses loading a file: `source .env`, `. .env`, `set -a`, `--env-file .env`.

Every conversation starts with a short `# secret-guard` note to Claude: the protected files and key names (names only), what `‹hidden: NAME›` means, and the convention (reference `$NAME`, let scripts load the env file, never print a secret, report only whether a command worked). So you no longer need to remind each session. The note is rebuilt after a compaction or `/clear`. Messages Claude sends to another agent or session (SendMessage) are scrubbed like tool results. So is what Claude Code attaches to a message on its own, which never passes through a tool call: a file Claude read, attached again after a compaction; a file changed on disk; a file you @-mention; a settings hook's output.

**plan-meter**

- `plan`: comma-separated paths, relative to the project, tried in order; the first one that matches a file wins. A `*` in any part matches anything, and among several matches the most recently changed file wins. Default: `plans/*/plan.md, PLAN.md, plan.md, TODO.md, TASKS.md, ROADMAP.md, todo.txt, TODO.org`.
- `refreshSeconds` (default 15, at least 5): how often the plan is read again, so an edit you make in your own editor shows up too. Edits Claude makes show up at once.

The band shows only when there is a plan or a task list. The pane draws in the terminal and the desktop app; under `claude -p`, `/plan-meter` answers with the band's line. (The command was `/plan` up to 0.1.0; Claude Code 2.1.294 has a built-in `/plan`, which refused the name.)

**context-meter**

- `cacheTtl`: `auto` (default), `5m` or `1h`. A mod cannot read the cache lifetime Claude Code asks for, so `auto` follows Claude Code's defaults: one hour on a Claude subscription (the session reports rate-limit windows), five minutes with an API key or a cloud provider. Set it when you know better: you set `promptCacheTtl` or `ENABLE_PROMPT_CACHING_1H`, or you are drawing on usage credits, where Claude Code drops to five minutes. The band always says which lifetime it assumed and why.
- `breakdown`: `summary` (default) estimates the categories locally and sends nothing. `full` counts them with the token-count API after every turn, as `/context` does: more exact, one request per tool and memory file.

Every request of the main conversation that hits the cache resets its timer, so the clock restarts at each model request, from the moment it was sent, not only when a turn ends. While Claude works the band says the cache is being kept warm; the countdown runs between turns, from the last request. A subagent's requests have caches of their own and are left out. After a compaction it starts again with the next message. The button is hidden while a turn runs and before the conversation's first reply, when Claude Code refuses a compaction ("Not enough messages to compact"); if a compaction is refused or a hook vetoes it, the band says why, and so does a toast. If you set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, which can only bring auto-compaction earlier, the header shows that point and marks it as your setting (`compacts at 500k (your 50% setting)`), since the breakdown Claude Code returns may still give its default; that one environment variable is all context-meter reads. In the desktop app and the IDE extensions, which run Claude Code through its SDK, Claude Code cannot compact between turns yet, so there the button runs `/compact` as if you had typed it. Below the bar, every category and the free part get a coloured entry with their tokens and share of the window, wrapped onto as many rows as they need. **Compacting is a model call**: the band costs no tokens, the button does. With little room above the prompt the band keeps two rows, the fill and the cache clock.

**done-gate**

- `testCommands`: comma-separated commands that run your tests, added to the usual runners. Example: `./scripts/check.sh, make ci`. Each one counts when it is the command itself, with or without arguments, so `check` does not match `git checkout`.
- `ignore` (default `.md,.mdx,.markdown,.txt,.rst,.adoc,.org`): file endings whose changes need no test run.

The usual runners it knows: `pytest`, `python -m pytest` or `unittest`, `npm`/`pnpm`/`yarn`/`bun` `test` or `run test`, `vitest`, `jest`, `mocha`, `go test`, `cargo test`, `cargo nextest`, `mvn test` or `verify`, `gradle test`, `dotnet test`, `rspec`, `phpunit`, `mix test`, `swift test`, `ctest`, `make test` or `check`, `tox`, `nox`, `deno test`, `claude plugin test`. A runner counts when it is a command in the line, after `&&`, `;` or `cd api &&` and behind `FOO=1`, `npx`, `uv run` or `poetry run`; a runner named inside an argument (`echo pytest`, `git commit -m "fix pytest"`) does not.

## Plan formats plan-meter reads

plan-meter does not ask you to write your plan its way. It recognises these, alone or mixed in one file:

| Format | Example | What it counts |
|---|---|---|
| **Checklist** | `- [x] write the schema` | One step per item. Bullets `-`, `*`, `+`, `1.`, `1)`. Marks: `x` or `X` done; `/` or `~` in progress (Obsidian); `-` cancelled, left out of the count; a space, `>`, `<`, `!` or `?` still to do. |
| **Status table** | `\| Phase \| Name \| Status \|` with a row `\| 2 \| API \| 🚧 In progress \|` | One phase per row. The status column is the one headed Status, State, Progress, Done or Done?, Trạng thái, Tình trạng, ステータス or 状態. The name comes from a Name, Title, Task, Item, What, Deliverable, Tên or Công việc column, else Phase, Step, Milestone, Stage or Giai đoạn, else the first cell with words in it (so a Phase column holding only `2` is skipped). |
| **Headings as phases** | `## Phase 2: API (in progress)`, `## Step 3 ✅` | Used when the file has no status table. A heading named Phase, Step, Stage, Milestone, Sprint, Part or Task with a number (also Giai đoạn 1, Bước 2, フェーズ1) is a phase. Its status comes from a mark in it, a status at its end (`(done)`, `[WIP]`, `— done`, `: in progress`), the checklist beneath it (all ticked is done, some ticked is in progress), or the phase file it links to. Any other heading counts only when it ends with a status alone: `## Setup (done)`. |
| **Linked phase files** | `[Phase 1](./phase-01-schema.md)` | Links in the plan (in text, tables or headings) to Markdown files whose name starts with phase, step, stage, milestone, sprint, part or task and goes on with a number or a dash: `phase-01-schema.md`, `phase1.md`, `steps.md`, `part_2.md`, but not `department.md`. Relative to the plan's folder, up to 30; a `#section` part is ignored, and two links to one file count it once. Their checklists add to the steps. A phase whose status the plan leaves blank or unknown takes the file's status from its frontmatter or status line, else from its checklist; a status the plan states, such as Pending, wins. A plan with no phases of its own takes one phase per linked file. |
| **YAML frontmatter** | `title: Ship the export` / `status: in_progress` | The plan's title and its own status. |
| **Status line** | `Status: Draft, phase 3 next`, `**Status:** …`, `Status (2026-10-07): …` | The plan's own status, shown as written when nothing in the file can be counted. |
| **org-mode** | `* TODO write the schema`, `** DONE tests` | One step per headline. `DONE` done; `DOING`, `IN-PROGRESS`, `STARTED`, `WAITING`, `HOLD` in progress; `CANCELLED` left out; `TODO`, `NEXT` to do. |
| **todo.txt** | `x 2026-10-01 call the bank` | A file named `todo.txt` (or `*.todo.txt`): one step per line, `x ` at the start is done. |

**Status words** it understands in tables, headings, status lines and frontmatter, in English, Vietnamese and Japanese. When a cell holds several, the first one wins, so `Done (review pending)` is done and `Not started` is to do.

- Done: done, complete, completed, finished, shipped, merged, closed, resolved, delivered, passed, xong, hoàn thành, 完了, ✅ ✔ ☑ ✓ `[x]`
- In progress: in progress (also `in-progress`, `in_progress`), WIP, doing, ongoing, active, started, running, in review, reviewing, blocked, đang, đang làm, 進行中, 🚧 🔄 ⏳ ▶
- To do: not started, not done, not yet, incomplete, unfinished, todo, to do, pending, planned, backlog, queued, open, chưa, chưa làm, chưa xong, 未着手, ⬜ ☐ `[ ]`
- Dropped, left out of the count: cancelled, canceled, dropped, won't do, won't fix, wontfix, skipped, obsolete, abandoned, n/a, hủy, bỏ qua, 中止, 🚫

The title is the frontmatter `title:`, else the first `#` heading (a leading `Plan:` is dropped). Anything inside a fenced code block is skipped.

**Claude's own tasks.** When Claude keeps a task list (its `TodoWrite`, `TaskCreate` and `TaskUpdate` tools), the band adds `Claude's tasks done/total`, and the pane lists them. That list is the session's: it starts empty in a new session.

**What it cannot read.** A plan that says how far it is only in prose ("we finished the API last week") has nothing to count; the band then shows its status line if it has one. Headings named Phase with no status and no checklist beneath give no phase count, rather than a made-up 0 of N. On the 21 plan files in the author's own writing workspace, 10 gave a phase count, 8 a step count, 10 had only a status line to show, and 1 had nothing plan-meter could read.

## What done-gate does and does not do

- It watches the files Claude changes with its Edit, Write, MultiEdit and NotebookEdit tools, and the commands Claude runs with Bash or PowerShell. A test command that passes clears every file changed before it started; one that fails keeps them and turns the band red.
- When the exit status could belong to another command (`pytest -q | tail -20`, `pytest; echo done`, `pytest || true`), done-gate reads the runner's own summary line in the output instead: `5 passed`, `1 failed`, `18 pass … 0 fail`, `test result: ok`, `ok  pkg`, `OK`. Failure words win. With no summary to read, the run counts for nothing.
- A passing command that runs a changed file (`python scripts/report.py`, `./build.sh`) clears that file, since running a script checks at least that it runs. Reading it (`cat`, `git diff`) does not.
- When Claude marks a task done (TaskUpdate to `completed`, or a TodoWrite item newly `completed`) while changed files are unchecked, Claude reads this beside the tool's result, and you see the same as a toast:

  > done-gate: "Add the export" was marked done, but 1 code file was changed and no test has run in this session: src/export.py. Before you report this task as finished, run the tests that cover these files, or tell the user plainly that they were not tested and why.

- It does not refuse anything, and it cannot tell whether your tests cover the changed files: any passing test run counts.
- It does not see files changed by a shell command (`sed -i`, a code generator) or outside Claude Code, nor a test run sent to the background, whose result it cannot know.
- It keeps its record for the session only.

## What secret-guard does not do

- **It is not a security boundary.** It hides exact copies of the values in your env files, and values that look like secrets by their key name or their shape. In the author's tests it missed a base64-encoded copy and two partial prefixes of a value. A secret printed bare, with no key name beside it and in no env file (`aws ssm get-parameter --query Parameter.Value --output text`, a password file, a column of a CSV), is not recognised; that is why the commands above are refused. To stop Claude from reading a file at all, use [permission deny rules](https://code.claude.com/docs/en/permissions) such as `Read(./.env)`, the sandbox, OS file permissions or a secrets manager.
- It reads the env files at session start. A value added later is protected from the next session. A file outside the folders above the session (another project, a secrets folder in your home directory) is read only when `secretFiles` names its path.
- A file it cannot parse (a quoted value that never closes) is skipped: its values are **not** protected, while every other file still is. secret-guard names the file and the reason, never its content, in the status line, in the `# secret-guard` note (so Claude tells you) and in `/secret-guard`, and it still refuses `cat` of that file. Fix the file, or leave it out with `!` in `secretFiles`. A file it cannot read at all (no permission) makes it refuse every call in that session; `claude plugin disable secret-guard@chien-mods` turns it off.
- The detectors also hide what only looks like a secret: a literal under a secret-looking name in code you read (`password: "hunter2-test"` in a test), the values of a ConfigMap listed together with a Secret. When Claude then edits that file, the marker is turned back into the value, so the edit works.
- **Edits.** A file Claude read with a hidden value shows `‹hidden: NAME›`. When an Edit, Write, MultiEdit or NotebookEdit carries that marker, secret-guard puts the real value back only when the target file already holds it, so a value is restored where it was and never copied into a new file. Otherwise the call is refused and Claude is told why. A marker in a Bash or PowerShell command is refused, never filled in.
- An AWS secret access key is caught by its key name (`aws_secret_access_key`, `SecretAccessKey`) or when it sits on the same line as an access key id; a bare 40-character string elsewhere is not, since every git commit hash would match.
- When it cannot check a result, it withholds the result rather than letting it through. If an env file could not be read, it refuses every call and every outgoing message and `/secret-guard` says why; if a check failed, or a secret sat in a result as a number it can't replace, `/secret-guard` counts the results it withheld.
- It keeps the values in memory only: never in a file, a log, the status line, the context block or Claude Code's state. The context block holds the key names only.

## Before you install any mod

Mods are not sandboxed. A mod's hooks run with your permissions and can read files and start processes. These four are short; read them first. `claude plugin validate plugins/<name>` lists every hook a mod registers and every call it makes. None of the four starts a process or uses the network of its own. (context-meter's `breakdown: full` asks Claude Code to count tokens, which Claude Code does with the API; its Compact button asks Claude Code for a compaction, which is a model call.)

## How it was tested

- Each mod passes `claude plugin validate` and `claude plugin test` (`plugins/<name>/tests/`) and type-checks with `tsc`.
- In a throwaway folder holding a `.env` of fake canary values, a demo plan with two phase files, and a small Python file, real Claude Code sessions (2.1.291, haiku) ran with the three mods, once loaded by `--plugin-dir` and once installed from this repository with `claude plugin marketplace add vumichien/claude-code-mods-kit`:
  - asked to run `cat .env`, Claude received two `‹hidden: …›` markers and no canary value;
  - asked to add a task, change the Python file, tick the plan's step and mark the task done without running anything, Claude received the done-gate note and quoted it back;
  - `/plan` (now `/plan-meter`) answered `phases 0/2 · steps 1/4 (25%)` before that session and `steps 2/4 (50%)` after it, with no model turn.
- A second reviewer, OpenAI's Codex, read both new mods; its 13 findings (a test runner named only inside `echo`, `cat` counted as running a file, and parsing and path cases) are fixed and each has a test.
- In a control session without the mods, both canary values reached Claude and no note appeared.
- The live-session checks above are for the first three mods. context-meter (added 2026-10-08, on Claude Code 2.1.294) is checked by `validate`, `tsc` and its 26 tests, which drive its band, countdown and button against the engine's test host, and in one live terminal session (2.1.294, a 1M window): before `/compact` the band read `178k of 1M · 18%`, against the 179,681 tokens Claude Code recorded for the compaction; once the compaction finished, before any new message, it read `98k of 1M · 10%`, and the cache line had reset to `starts with the next message`.
- secret-guard 0.3.0 (2026-10-09, Claude Code 2.1.295, haiku) is checked by `validate`, `tsc` and its 47 tests, and in live sessions loaded with `--plugin-dir` (the debug log confirms it replaced the installed 0.2.0) in a throwaway folder holding a `.env`, a `.env.local` and a `.env.example` of canary values. The `# secret-guard` note reached Claude with the key names only (`LIVE_API_TOKEN, LOCAL_SECRET, DB_PASSWORD`, not `DB_NAME`), and again after `/compact`. `echo "JWT_SECRET=…"` came back as `JWT_SECRET=‹hidden: JWT_SECRET›`, and the `.env.local` value as `‹hidden: LOCAL_SECRET›`. `env`, `cat .env` and `aws ssm get-parameter --with-decryption` were refused with their alternatives. An Edit whose `old_string` held `‹hidden: LIVE_API_TOKEN›` (built from a scrubbed Read) changed the file, and the real value stayed in it. After `/compact`, Claude Code attached the file read earlier again, straight from disk and past every tool hook: the first build let its value through raw (as 0.2.0 would have), so 0.3.0 also scrubs attachments, and the same check then showed Claude the placeholder. When it was not told to run them exactly, Claude, given the note, skipped the printing commands by itself and ran the SSM call with its output discarded.

## Licence

MIT. See [LICENSE](LICENSE).
