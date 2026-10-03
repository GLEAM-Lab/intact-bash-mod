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

**Permissions are unchanged.** Claude Code decides whether a call may run on the call it runs, which after a reroute
is the delivery statement. The mod answers that decision with Claude Code's own decision on the delivered command, so
deny rules, ask rules and the Bash tool's own checks apply to your command exactly as they would without the mod.

On other platforms the mod does nothing.

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
