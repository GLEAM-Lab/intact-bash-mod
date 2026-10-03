# intact-bash-mod

Claude Code's Bash tool on Windows runs a command as `eval '<command>'` inside one `bash -c` argument. On that hop
the MSYS2 runtime of Git for Windows silently cuts a quoted argument at 8,186 UTF-16 code units and merges backslash
pairs (`\\` becomes `\`), so a long command, a heredoc with Python or regex text, or a Windows path can run as a
different command than the one written, often without any error.

This mod delivers such a command as a file instead. It writes a command that is longer than 200 characters, or
contains a heredoc or a backslash pair, to `%LOCALAPPDATA%\Temp\claude-cmd\` and replaces the tool input with
`. '<file>'  # delivered as a file (<n> chars): <first line>`, so bash sources the command exactly as written, in the
same shell (`cd`, exports and the exit status behave as before). Shorter commands pass unchanged.

A command that no channel carries is refused, and the message names the hop:

- a carriage return before a line feed (Git Bash drops it wherever it reads a command): `Not run (hop: shell parse). ...`
- a command the mod would deliver as a file that asks how it was read (`$BASH_SOURCE`, `$BASH_EXECUTION_STRING`,
  `$FUNCNAME`, `caller`, or a `return` outside a function): `Not run (hop: host wrapper). ...`

On other platforms the mod does nothing.

## What the mod changes, writes and decides

**Tool input.** Only the Bash tool's `command`, and only for a command the rule above reroutes: it is replaced by the
statement `. '<file>'  # delivered as a file (<n> chars): <first line>`. Every other tool call, and every other Bash
command, reaches Claude Code unchanged. A refused command is answered with the refusal message and does not run.

**Files.** For each rerouted command the mod writes one file, `%LOCALAPPDATA%\Temp\claude-cmd\<time>-<hash>.sh`,
holding that command exactly as Claude wrote it, and bash sources it once, for that call. The mod writes nothing
else, except one small record per Bash call when you turn records on (see below). It never edits a build, start-up,
settings or instructions file.

**Permission decisions** (`tool.check` hook on the Bash tool). Claude Code decides whether a call may run on the call
it runs, which after a reroute is the delivery statement. For such a statement the mod reads the delivered command
back from its file and asks Claude Code how it would decide that command: if Claude Code would deny it, the mod
denies the statement; if Claude Code would ask, the mod asks; otherwise it leaves the decision on the statement to
Claude Code as usual. The mod never allows a call by itself, so deny rules, ask rules and the Bash tool's own checks
apply to your command exactly as they would without the mod. For any other call the hook does nothing.

## Requirements

Windows, Claude Code 2.1.287 or later (mods are on by default) with Git for Windows. No Python, no other dependency.

## Install

Install it from the plugin directory, or for one session only: `claude --plugin-dir <path to this folder>`.

## Check it

In a session, ask Claude to run `printf '%s\n' 'left\\right'`. Without the mod the output is `left\right`; with the
mod it is `left\\right`, and the delivered file holds the command as written. `claude plugin test` runs the mod's own
tests.

## Switch off, records, uninstall

- `INTACT_BASH_DELIVERY=off` in Claude Code's environment passes every command unchanged.
- With `INTACT_MOD_LOG=on` the mod writes one record per Bash call, counts only and no command text, to
  `%LOCALAPPDATA%\intact-mod\log\<session id>\` (action, command length, what decided the action, rendering time).
  Without it nothing is recorded.
- Delivered files are not removed by the mod; delete `%LOCALAPPDATA%\Temp\claude-cmd\` when you like.
- Uninstall it like any plugin (`claude plugin uninstall intact-bash-mod@<marketplace>`).

## License

MIT, see `LICENSE`.
