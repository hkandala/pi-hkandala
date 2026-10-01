# pi-bash-bg

Background bash for pi. Any bash call can move to the background, from the start or while it runs, without restarting it. When a background job ends, the agent gets a message with its result and picks up from there.

```
   └ bash  npm run dev
 ● Started the dev server (pid 48213).
 ╭┄┄ background job ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮
 ┆ ✗ npm run dev · pid 48213 · exit 1 · 4m12s (ctrl+o to expand) ┆
 ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯
```

| How a call moves to the background              |                                       |
| ----------------------------------------------- | ------------------------------------- |
| The agent passes `background: true`             | for servers, watchers and long builds |
| You press **ctrl+shift+b** or run `/background` | moves the running bash calls          |
| It runs for more than **120 s**                 | automatic                             |

- The call returns right away with the pid and the log path, and the agent is told how it got there (it asked, you moved it, or it ran too long) and not to wait on it.
- Jobs keep running across `/reload`, session switches and quitting pi. On quit, pi-bash-bg prints a line with the pids that are still running, next to pi's resume hint.
- When a job ends, however it ends (exit, `kill`, timeout), the session that started or watches it gets a steer message shaped like a bash result: the output tail, the log path, and the exit code. An idle agent wakes up. After a resume or restart the agent isn't messaged about jobs that ended meanwhile; it can check with `bash_list`.
- **Esc** kills the running foreground command, as in pi. It never touches background jobs.
- Running jobs show through the extensions below. On its own, pi-bash-bg adds nothing to pi's footer; `/background list` shows the jobs, and end messages use pi's default message box.

## Agent tools

| Tool         | Does                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `bash`       | pi's bash tool plus `background: true`                                                                                                    |
| `bash_list`  | Lists background jobs: this session's (`jobs: "watching"`, default) or all (`"all"`), filtered by `status` (`running`, `finished`, `any`) |
| `bash_watch` | Gets the end message of a job another session started                                                                                     |

The agent stops a job with `kill <pid>`. Output always goes to a log file under `~/.pi/agent/bash-bg/`, which the agent can `tail` or `grep`.

## Commands

| Command                            | Does                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `/background`                      | Moves the running bash calls to the background                                                                                    |
| `/background list [jobs] [status]` | Prints jobs, with `bash_list`'s two params in order: `watching` (default) or `all`, then `running` (default), `finished` or `any` |
| `/background logs [pid]`           | Opens a log viewer that follows the output (↑↓, PgUp PgDn or the wheel scroll, End follows, `x` twice kills, Esc closes)          |
| `/background kill <pid\|all>`      | Kills one job, or all of this session's                                                                                           |

## Works with

Optional; install any of them for the extra:

- [pi-footer](../pi-footer/README.md): the job count in the footer line, and a jobs tab in the dashboard (↓ opens it while jobs run) to browse the running jobs (`e` shows finished ones), open their logs, and kill them.
- [pi-working](../pi-working/README.md): `Waiting on 2 background jobs (1m 12s)` in the prompt's border while the agent waits.
- [pi-content-layout](../pi-content-layout/README.md): end messages in its dashed frame (click to expand), a `ctrl+shift+b to run in background` hint under a bash call running 30s or more, and exact durations for parallel bash calls loaded from history.
- [pi-bash-cap](../pi-bash-cap/README.md): end messages use its limits instead of pi's.
- [herdr](https://herdr.dev): an optional patch keeps the pane `working` while jobs run; see [herdr/](../../herdr/README.md).

Each works alone, and pi-bash-bg needs none of them.

## Install

```bash
pi install npm:@hkandala/pi-bash-bg
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-bash-bg`.

## Configuration

Optional file: `~/.pi/agent/extensions/pi-bash-bg.json`

| Key                     | Default          | Meaning                                                                                              |
| ----------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `autoBackgroundSeconds` | `120`            | Move a foreground call to the background after this long. `0` turns it off                           |
| `shortcut`              | `"ctrl+shift+b"` | Key that moves running bash calls to the background                                                  |
| `keepOnExit`            | `true`           | Keep this session's jobs running when it ends (quit, `/new`, `/resume`, `/fork`). `false` kills them |

Run `/reload` after editing.

## Notes

- It replaces pi's `bash` tool with pi's own tool, run through a small wrapper, so pi's rendering, truncation and error messages stay the same. `shellPath` and `shellCommandPrefix` from pi's settings apply.
- Each call costs about 7 ms more than pi's bash (a subshell and a log file).
- `kill -9 <pid>` can't be caught, so it doesn't stop the job's child processes; `kill -9 -- -<pid>` does.
- Job files are deleted 7 days after the job ends.
- In tmux, ctrl+shift+b needs `set -g extended-keys on`.
- Design and details: [docs/SPEC.md](docs/SPEC.md).
