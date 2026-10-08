---
name: verify
description: Check a change to one of the kit's mods in a real Claude Code session (bands, slash commands), not only in claude plugin test.
---

# Verify a mod change live

The surface is an interactive `claude` session (not `claude -p`). A slash command passed as the launch
argument runs locally, with no model call: `claude "/context-meter on"`.

- Installed copies read straight from this folder (`claude plugin list` shows `Read from: ...\plugins\<mod>`).
  After a version bump run `claude plugin update <mod>@chien-mods`; a new session then loads the change.
- A command a mod registers can be dropped as a launch argument when it arrives before the mod has
  registered it (nothing on screen, nothing in the debug log); launch again.
- One launch argument = one command. There is no way to type a second one from a Terminal-panel tab, so
  each step is a fresh session.
- Start sessions in a folder that is already trusted; a new folder (such as the scratchpad) stops at the
  "trust this folder" prompt.
- `--settings '{"pluginConfigs":...}'` is not applied to installed plugins (the debug log says
  `no pluginConfigs["<mod>@chien-mods"].options`), so options cannot be set per launch that way.
- `claude --debug "<command>"`, then read the newest file in `~/.claude/debug/` and grep the mod's name:
  it shows each hook module loading, refused registrations, and hooks that threw and were skipped.
- plan-meter needs a plan the session can find; a temporary `PLAN.md` in the trusted folder works. Delete
  it afterwards.
- done-gate's band draws nothing until a file was edited or a test ran, which takes a model turn.
