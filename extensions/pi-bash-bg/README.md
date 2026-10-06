# pi-bash-bg

Background bash for pi. Any bash call can move to the background, from the start or while it runs, without restarting it. When a background job ends, the agent gets a message with its result and picks up from there.

With [pi-content-layout](../pi-content-layout/README.md), an end message looks like this:

```
   └ bash  npm run dev
 ● Started the dev server (pid 48213).
 ╭┄┄ background job ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮
 ┆ ✗ npm run dev · pid 48213 · exit 1 · 4m12s (ctrl+o to expand) ┆
 ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯
```

| How a call moves to the background          |                                       |
| ------------------------------------------- | ------------------------------------- |
| The agent passes `background: true`         | for servers, watchers and long builds |
| You press ctrl+shift+b or run `/background` | moves the running bash calls          |
| It runs for more than 120 s                 | automatic                             |

- The call returns right away with the pid and the log path. The agent learns how the call moved: it asked, you moved it, or it ran too long. It is also told not to wait on it.
- Jobs keep running across `/reload`, session switches and quitting pi. When you quit the TUI, pi-bash-bg prints a line next to pi's resume hint. The line lists this session's jobs that still run (or that it killed, with `keepOnExit: false`).
- When a job ends, the session that started or watches it gets a steer message. This happens for every kind of end: an exit, a `kill`, or a timeout. The message looks like a bash result: the end of the output and the exit code, and the log path when the output was cut. An idle agent wakes up.
- The agent gets no message for a job that ended while its session was closed (after a resume or a restart). It can find such a job with `bash_list`.
- Esc kills the running foreground command, as in pi. It never touches background jobs.
- Running jobs show only through the extensions below. On its own, pi-bash-bg adds nothing to pi's footer. `/background list` shows the jobs, and end messages use pi's default message box.

## Agent tools

| Tool         | Does                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash`       | pi's bash tool plus `background: true`                                                                                                                |
| `bash_list`  | Lists background jobs: this session's (`jobs: "watching"`, default) or all (`"all"`). `status` filters them: `running`, `finished` or `any` (default) |
| `bash_watch` | Gets the end message of a job another session started                                                                                                 |

The agent stops a job with `kill <pid>`. Output always goes to a log file under `~/.pi/agent/bash-bg/`, which the agent can `tail` or `grep`.

## Commands

| Command                            | Does                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/background`                      | Moves the running bash calls to the background                                                                                                                                                    |
| `/background list [jobs] [status]` | Prints jobs, with `bash_list`'s two params in order: `watching` (default) or `all`, then `running` (default), `finished` or `any`                                                                 |
| `/background logs [pid]`           | Opens a log viewer that follows the output. With no pid, you pick a job first. ↑↓, PgUp PgDn or the wheel scroll, Home goes to the top, End follows, `x` twice kills, Esc or `q` closes. TUI only |
| `/background kill <pid\|all>`      | Kills one job, or all of this session's                                                                                                                                                           |

## Works with

Each of these is optional. Install one to get its extra:

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

- It replaces pi's `bash` tool with pi's own tool, run through a small wrapper. So pi's rendering, truncation and error messages stay the same. The `shellPath` and `shellCommandPrefix` settings of pi apply (project settings only in a trusted project, as in pi).
- macOS and Linux only: it stops jobs through process groups.
- In `pi -p` and `--mode json`, pi waits for this session's running background jobs before it exits, and then the agent continues with their results. A server started in the background keeps pi running until the server stops.
- Each call costs about 7 ms more than pi's bash (one or two extra forks and two small files: the log and the exit code).
- A process cannot catch `kill -9 <pid>`, so that command does not stop the job's child processes. Use `kill -9 -- -<pid>` to stop them too.
- When pi starts, it deletes the files of jobs that ended more than 7 days ago. It also deletes the files that a crash left behind, one day after their last write.
- In tmux, ctrl+shift+b needs `set -g extended-keys on`.
- Design and details: [docs/SPEC.md](docs/SPEC.md).
