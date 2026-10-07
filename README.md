# claude-code-mods-kit

Three small [Claude Code](https://code.claude.com) mods, free to use under the MIT licence. A mod is a plugin made of function hooks: Claude Code calls it at every step (a tool call, a slash command, a redraw), and it can answer, change or watch that step.

| Mod | What it does | Command |
|---|---|---|
| **secret-guard** | Reads your project's `.env` when a session starts and hides those values in every tool result before Claude reads it. `cat .env` reaches Claude as `DEMO_API_KEY=‹hidden: DEMO_API_KEY›`. | `/secret-guard` lists the protected key names |
| **plan-meter** | A one-line band above the prompt that says how far your plan is: `plan ▸ Ship the export · phases 1/3 · steps 3/6 (50%) · now: API · Claude's tasks 2/5`. It reads your plan file (and the phase files it links to) in [many formats](#plan-formats-plan-meter-reads), and Claude's own task list. It updates when a file changes. | `/plan` opens a pane with the details; `/plan docs/roadmap.md` picks a file |
| **done-gate** | When Claude marks a task done while code it changed has not been tested since, it tells Claude, in the tool result Claude reads, and you, in a toast. A band shows the last test run: `done-gate ▸ tests ✔ passed 4 min ago · 2 files changed since`. **It warns; it never blocks.** | `/done-gate` lists the changed files and the last test command |

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
```

Start a new session afterwards. To remove one: `claude plugin uninstall plan-meter@chien-mods`.

## Options

Every option has a default, so all three mods work without any. To change one, use `/plugin configure <name>@chien-mods` inside Claude Code, pass `--config key=value` to `claude plugin install`, or pipe a JSON object to `claude plugin configure <name>@chien-mods --values-stdin`. With `--plugin-dir`, put them in a settings file: `--settings '{"pluginConfigs":{"done-gate":{"options":{"testCommands":"make ci"}}}}'`.

**secret-guard**

- `mode`: `value` (default) hides values in results. `command` instead refuses any call whose command or path names a `.env` file, without reading values; it is simpler, but it blocks harmless commands and misses reads that don't name the file.
- `identifierKeys`: comma-separated keys that hold names, not secrets (a login name that shows up in ordinary paths). They are never hidden. Values shorter than 12 characters are never hidden either.

**plan-meter**

- `plan`: comma-separated paths, relative to the project, tried in order; the first one that matches a file wins. A `*` in any part matches anything, and among several matches the most recently changed file wins. Default: `plans/*/plan.md, PLAN.md, plan.md, TODO.md, TASKS.md, ROADMAP.md, todo.txt, TODO.org`.
- `refreshSeconds` (default 15, at least 5): how often the plan is read again, so an edit you make in your own editor shows up too. Edits Claude makes show up at once.

The band shows only when there is a plan or a task list. The pane draws in the terminal and the desktop app; under `claude -p`, `/plan` answers with the band's line.

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

- **It is not a security boundary.** It hides exact copies of the values in your `.env`. In the author's tests it missed a base64-encoded copy and two partial prefixes of a value. To stop Claude from reading a file at all, use [permission deny rules](https://code.claude.com/docs/en/permissions) such as `Read(./.env)`, the sandbox, OS file permissions or a secrets manager.
- It reads the nearest `.env` at or above the folder where the session starts, at session start. A value added later is protected from the next session.
- When it cannot check a result, it withholds the result rather than letting it through. If the `.env` failed to load, it refuses every call and `/secret-guard` says why; if a check failed, or a value sat in a result as a number it can't replace, `/secret-guard` counts the results it withheld.
- It keeps the values in memory only: never in a file, a log, the status line or Claude Code's state.

## Before you install any mod

Mods are not sandboxed. A mod's hooks run with your permissions and can read files and start processes. These three are short; read them first. `claude plugin validate plugins/<name>` lists every hook a mod registers and every call it makes. None of the three starts a process or uses the network.

## How it was tested

- Each mod passes `claude plugin validate` and `claude plugin test` (`plugins/<name>/tests/`) and type-checks with `tsc`.
- In a throwaway folder holding a `.env` of fake canary values, a demo plan with two phase files, and a small Python file, real Claude Code sessions (2.1.291, haiku) ran with the three mods, once loaded by `--plugin-dir` and once installed from a local copy of this marketplace:
  - asked to run `cat .env`, Claude received two `‹hidden: …›` markers and no canary value;
  - asked to add a task, change the Python file, tick the plan's step and mark the task done without running anything, Claude received the done-gate note and quoted it back;
  - `/plan` answered `phases 0/2 · steps 1/4 (25%)` before that session and `steps 2/4 (50%)` after it, with no model turn.
- A second reviewer, OpenAI's Codex, read both new mods; its 13 findings (a test runner named only inside `echo`, `cat` counted as running a file, and parsing and path cases) are fixed and each has a test.
- In a control session without the mods, both canary values reached Claude and no note appeared.

## Licence

MIT. See [LICENSE](LICENSE).
