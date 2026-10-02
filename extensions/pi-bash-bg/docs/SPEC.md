# pi-bash-bg spec

Background bash for pi. The `bash` tool can run a command in the background, either from the start or after it is already running. Background jobs keep running across `/reload`, session switches and a pi exit. When a job ends, the sessions watching it get a message.

- **Starting a job:** `bash({ command, background: true })`. A running foreground call moves to the background with ctrl+shift+b, `/background`, or automatically after 120 s. The process keeps running; only the tool call stops waiting.
- **Identity:** a job is its **pid**. `<id>.json` keeps the id of the session that started it, but nothing reads that id. Nothing records who killed a job, and anyone can kill any job.
- **Output:** always goes to a log file.
- **Stopping:** Esc kills the running foreground call, as in pi, and never touches background jobs. The agent stops a job with `kill <pid>`. The user stops one with `/background kill`, the log viewer, or pi-footer's jobs tab.
- **Ending:** however a watched job ends (exit, any kill, timeout), its session gets one steer message shaped like a bash result.

Code: `index.ts` (everything except the viewer) and `viewer.ts` (the log viewer).

## 1. Files

Everything lives flat in `~/.pi/agent/bash-bg/`. `<id>` is `<startedAtMs>-<4 random base36 chars>`, so parallel calls started in the same millisecond don't collide. The id is internal: the agent and the user only see pids.

| File                     | Written                                | Contents                                      |
| ------------------------ | -------------------------------------- | --------------------------------------------- |
| `<id>.log`               | by the command (stdout and stderr)     | output, interleaved                           |
| `<id>.exit`              | by the wrapper when the command ends   | exit code                                     |
| `<id>.json`              | when the call moves to the background  | `{ pid, command, cwd, startedAt, sessionId }` |
| `<id>.watch.<sessionId>` | when a session starts watching the job | empty                                         |

- A call without `<id>.json` is a foreground call. Lists ignore it, and its `.log` and `.exit` are deleted when it finishes.
- Every file is written once. An empty `<id>.exit` means it is being written. Several pi processes share the folder without locks.
- A pid resolves to the newest `<id>.json` with that pid, so a reused pid is harmless.

**Cleanup:** once per pi process, after the first `session_start`, an async task that nobody awaits deletes the files of jobs that ended more than 7 days ago, and of foreground calls (no `.json`) whose log was last written more than a day ago, which a crash left behind. A foreground call can run longer than a day, so its start time is not used.

## 2. Running a command

Every bash call spawns pi's shell (`shellPath` setting, else pi's default) once. Settings come from `SettingsManager.create(cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() })`, so a project's `.pi/settings.json` applies only in a trusted project, as for pi's own bash.

```
spawn(shell, ["-c", WRAPPER, "bash", command, "<id>.exit"],
      { cwd, env, detached: true, stdio: ["ignore", logFd, logFd] })
```

```sh
trap 'trap - TERM INT HUP; echo 143 > "$2"; kill -TERM 0' TERM INT HUP
(__cmd=$1; set --; eval "$__cmd") & wait $!; c=$?; echo $c > "$2"; exit $c
```

- `command` has `shellCommandPrefix` applied. `env` is pi's bash environment, `PI_*` included. The log is opened in append mode.
- `detached` makes the shell's pid the process group id, so the job outlives pi.
- The command runs in a subshell with no positional parameters, so it behaves like `bash -c "<command>"`, including `exit N`, `set -e` and heredocs.
- **Why `& wait`:** a shell runs a trap only between commands, so it would wait for a foreground command to finish first. While the shell waits on a background child, the trap runs right away. The trap stops the whole group, so plain `kill <pid>` also stops `&` grandchildren, and 143 is recorded. `kill -9 <pid>` cannot be trapped; `kill -9 -- -<pid>` kills the group.
- `exit $c` gives the wrapper the command's exit code, so a foreground call can use the child's own `exit` event.
- **Cost:** about 13 ms per `echo hi`, against about 6 ms for pi's pipe-based bash, from one subshell fork and two small files. There is no PTY and no login shell.

**The `bash` tool** is pi's own `createBashToolDefinition(cwd, { commandPrefix, operations: { exec } })`, created per call. So pi's renderer, truncation, full-output file, error strings and `PI_*` env are unchanged, and pi-bash-cap still caps the result because the tool is still `bash`. The parameters are pi's `command` and `timeout`, plus `background?: boolean`.

Our `exec`:

0. Checks `timeout` as pi does: not finite or ≤ 0 throws `Invalid timeout: must be a finite number of seconds`, above 2147483.647 throws `Invalid timeout: maximum is 2147483.647 seconds`. `setTimeout` would fire at once on such a value.
1. Spawns the wrapper and passes the bytes newly appended to the log to pi's `onData` every 250 ms, so the live preview works as usual. Each pass sends at most 4 MB (copies of a reused 64 KB buffer), so a fast writer such as `yes` can't hold the event loop: the log file has no backpressure.
2. On the child's `exit`, reads the rest of the log, 4 MB per event-loop turn, deletes `.log` and `.exit`, and resolves with the exit code, or throws pi's `aborted` / `timeout:N` errors.
3. **Esc** (the abort signal) sends SIGKILL to the group, as pi does. So does a pi exit without `session_shutdown` (a crash, a lost terminal), through one `process.on("exit")` hook per process, as pi does for its own bash.
4. **`timeout`** kills the group at the deadline: SIGKILL in the foreground, and SIGTERM once in the background, so the wrapper records 143. The timer is unref'd, so it only fires while this pi process lives, and cleared when the job exits, so it can't hit a reused pid.

**Moving to the background** (`background: true`, ctrl+shift+b, `/background`, or `autoBackgroundSeconds`):

1. Stop streaming, detach the abort signal and `unref()` the child.
2. Write `<id>.json` and `<id>.watch.<sessionId>`, and add the job to this session's list of jobs it has seen running (section 4).
3. Resolve `exec` with exit code 0 and replace the whole tool result, which would otherwise hold the output so far, with one of these, then `You'll be notified when it exits; don't wait, sleep or poll on it.`:

   | Trigger                     | Text                                                                                                                                                   |
   | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `background: true`          | `Running in background as pid 12345 (log: <path>).`                                                                                                    |
   | ctrl+shift+b, `/background` | `The user moved this command to the background while it ran. It keeps running as pid 12345 (log: <path>); its output so far is in the log.`            |
   | `autoBackgroundSeconds`     | `Still running after 120s, so it moved to the background automatically. It keeps running as pid 12345 (log: <path>); its output so far is in the log.` |

**Duration:** every result's `details` carries `durationMs`, how long the call held the turn (until it ended or moved to the background). pi turns a thrown error (exit code ≠ 0, Esc, timeout) into a result with empty details, so a `tool_result` handler adds `durationMs` there. pi saves a batch of parallel results together, so their timestamps can't time each call; pi-content-layout uses `durationMs` for history rows, and pi-bash-cap keeps it when it rewrites the details.

**Sleep nudge:** if the command contains `sleep N` with N ≥ 5 and finishes in the foreground, `\nTip: don't sleep to wait. Run long commands with background: true; you'll be notified when they exit.` is appended to the output through `onData`. It is part of the output, so it survives truncation and stays before pi's `Command exited with code N` line, which pi-bash-cap expects to be last.

**Description and guidelines:** pi's description plus one sentence about `background: true`. After pi's own guidelines comes one grouped guideline, so that the rules in the system prompt read as sections:

```
Background bash (bash, bash_list, bash_watch):
    - Run servers, watchers, long builds, or anything that takes a while with bash `background: true`. Never use `&`.
    - Bash calls still running after 120s move to the background automatically.
    - You are notified when a background job exits: don't sleep, poll or wait on it.
    - Stop a background job with `kill <pid>`; bash_list lists them.
```

When `autoBackgroundSeconds` is 0, the second item is not there.

## 3. Job state

Checked in this order:

| State   | Condition                                                                                                    | Shown as                                |
| ------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| ended   | `<id>.exit` has a code                                                                                       | `exit N`; `killed` for 129, 130 and 143 |
| running | it started after the last boot, and the group is alive: `process.kill(-pid, 0)` succeeds or fails with EPERM | `running`                               |
| ended   | neither (`kill -9` of the shell, a reboot)                                                                   | `ended` (no exit code)                  |

- A job that started before the last boot (`startedAt < now - os.uptime()`) has ended, even if a group with its pid is alive: after a reboot the pid can belong to another process, which a kill would hit.
- If the group is dead, `<id>.exit` is read a second time, because the job may have ended between the two checks.
- The end time is the mtime of `<id>.exit`, or of the log when there is no code.
- `<id>.json` never changes and an ended job stays ended, so both are cached in memory.
- `&` grandchildren that outlive the command don't keep it running: once `<id>.exit` exists, the job has ended.

## 4. Agent tools and end messages

**`bash_list({ jobs?: "watching" | "all", status?: "running" | "finished" | "any" })`**

- `watching` (default) lists the jobs with a `<id>.watch.<thisSessionId>` marker: the ones this session backgrounded or watches. `all` lists every `<id>.json`.
- `status` defaults to `any`.
- Newest first, at most 100 lines. When more match, a last line says `Showing 100 of 342. All jobs are in ~/.pi/agent/bash-bg/ (<id>.json has pid and command).`
- One line per job: `12345  running  4m12s   npm run dev  ~/proj  log: <path>`. With no match: `No matching background jobs.`

**`bash_watch({ pid })`**

- The pid must have an `<id>.json`. Anything else, including a foreground call, fails with `pid 999 is not a pi-bash-bg background job. See bash_list({ jobs: "all" }).`
- It writes the marker and returns right away. If the job has already ended, it returns the end message's content.

There is no kill tool and no wait tool.

**Delivery.** Each live session keeps an in-memory list of the watched jobs it has **seen running**. The list starts with the marked jobs that are running when the session starts, and grows when the session backgrounds or watches a job. When a job on the list ends, the session sends

```ts
pi.sendMessage(
  { customType: "background job", content, display: true, details },
  { deliverAs: "steer", triggerTurn: true },
);
```

and drops the job from the list.

- **Detection:** a 1 s tick checks every job on the list, while one of them runs (otherwise nothing can change). The spawning process also gets the child's `exit` event and checks 250 ms later, so jobs that end together share one message.
- **`/reload`:** the list stays on `globalThis`, and so does the hook that runs a check. A child that exits after the reload calls the new runtime's hook. No hook is set during the reload. A job that ends then gets its message from the check that runs at `session_start`.
- **Startup, `/resume`, `/new`, `/fork`:** the list starts from the jobs running at that moment, so a job that ended while its session was closed sends nothing. The agent sees it in `bash_list`. Nothing is written back to the markers.

**Content**, per job, joined by blank lines:

```
Background job 12400 `npm test` exited with code 1 after 2m13s.
<output tail>
[Showing the last 2000 of 48210 lines. Full output (3.4MB): <log>]
Command exited with code 1
```

- The header says `was killed after …` for 129/130/143, and `ended without an exit code after …` when there is no code.
- The tail comes from the log's last 1 MB, capped like the bash tool: pi-bash-cap's limits when it's loaded (asked for with `bash-cap:limits`, section 7), else pi's defaults (2000 lines, 50KB).
- The `[Showing …]` line is added only when the output was cut. It compares the lines shown with the lines in the whole log. It gives no byte count for the shown part, because such a count read as "only 114KB shown". A log of at most 1 MB is counted from the text already read, and a log of at most 32 MB by a scan in 1 MB chunks. A bigger log isn't counted, because the scan would block pi for seconds: the line is then `[Showing the last 2000 lines. Full output (…): <log>]`. When the last line itself was cut, it is `[Showing the last 50.0KB of the last line. Full output (…): <log>]`.
- `Command exited with code N` is added when N ≠ 0.

**Rendering** (`details.jobs` holds each job's pid, command, code, state, elapsed, output and note): a `Box` with pi's `customMessageBg`, commands colored by pi's `highlightCode(…, "bash")`.

- Both forms cache their lines per width: pi renders the whole chat on every frame in full screen.
- Collapsed, like pi's compaction message, in at most 4 lines: one per job (with more than 4 jobs, 3 and `+N more`), `✓ npm test · pid 12400 · exit 0 · 2m13s` (`■` killed, `✗` otherwise). The command is cut with `…` to keep the row on one line with its details visible; a multi-line command shows its first line and `…`. A dim `(ctrl+o to expand)` ends the last line. This takes a small component instead of `Text`, which would wrap.
- Expanded (ctrl+o, or a click with pi-content-layout), like an open bash row in pi-content-layout. The output lines are cleaned like the log viewer's (below), so `\r` and cursor codes can't break pi's frame; the model gets the raw text, as with pi's bash. A command's color is reopened on each line, as in the viewer. the row; a command that takes more than one line (its own line breaks, or wrapping) continues under a dim `│` and gets a `│` line before its output; then the output and note hang off a dim `└`, indented, so input and output read apart. This also takes a component, to know the width.
- pi-content-layout draws the box in its dashed frame, labeled `background job`.

**Print and json modes** exit when the agent settles. `agent_before_settle` waits (250 ms polls) while any job on the list runs, and collects the end messages as `custom_message` entries instead of sending them. It returns `{ entries, continue: true }`, so `pi -p` ends with the results. TUI and RPC return right away.

## 5. Session end

- On every `session_shutdown`, running foreground calls get SIGKILL: their tool call is gone.
- `keepOnExit` (default `true`) keeps this session's running watched jobs alive on quit, `/new`, `/resume` and `/fork`. With `false`, they get SIGTERM, except on `/reload`. Nothing ever asks for confirmation.
- **Quit line:** on quit, pi stops the TUI, runs `session_shutdown`, then prints its resume hint. In TUI mode with running watched jobs, the `session_shutdown` handler (`reason: "quit"`) writes one line to stdout, just above the hint:

      pi-bash-bg: 2 background jobs still running (pids 12345, 12400). Logs: ~/.pi/agent/bash-bg
      To resume this session: pi --session ...

  With `keepOnExit: false` it says `were killed`.

## 6. User interface

**No status line of its own.** Running and waiting jobs show only through the other extensions (section 7): pi-footer's jobs piece and tab, and pi-working's waiting label in the prompt's top border. Without them, the jobs still run and end messages still arrive; `/background list` shows them.

**Shortcut:** `config.shortcut` (ctrl+shift+b) moves every running foreground call to the background. pi-content-layout hints at it under the last long-running bash row. In tmux it needs `extended-keys on`.

**`/background`**, with argument completion (subcommands, the two parameters of `list`, pids with their commands, `all`). It works while the agent runs.

| Command                            | Does                                                                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/background`                      | Moves the running bash calls to the background.                                                                                                                                                |
| `/background list [jobs] [status]` | Prints jobs filtered like `bash_list`, with its two params in order: `jobs` is `watching` (default) or `all`, `status` is `running` (default), `finished` or `any`. Newest first, at most 100. |
| `/background logs [pid]`           | Opens the log viewer; without a pid, first a picker (watched + others' running). Outside the TUI, it shows the log's path instead.                                                             |
| `/background kill <pid\|all>`      | SIGTERM to one job's group, or to all of this session's running watched jobs.                                                                                                                  |

`list` prints like `/hotkeys`: `appendEntry("bash-bg-list", { title, jobs, more })` with an entry renderer that skips entries from before this load, so it is never sent to the model and is gone after `/reload` or a restart. The title names the filter (`Background jobs · running · this session`). One bullet per job, newest first: `• ● 12400 · 18:28:51 · running · 4m12s · ~/proj` (● running, ✓ exit 0, ■ killed, ✗ otherwise; the start time, with the date when it isn't today), then the log path. The bullet and the path are dim. With more than 100 jobs, a dim last line says `+N more in ~/.pi/agent/bash-bg/`. Listing `all`, jobs this session watches end in `· watching`. Commands stay out: they can be long; the log viewer shows them.

**Log viewer** (`viewer.ts`): a full-screen page like pi-herd's dashboard, `ctx.ui.custom(…, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } })`. No border: it draws its own margin (2 rows on top, 1 below, 4 columns on each side) and pads every row to the full width and the page to the terminal's rows, so nothing of pi's screen shows.

- The title line is `pid 12345` (accent, bold) and a dim `running · 27s · ~/proj`, then a rule. The body is `> ` and the command, colored as bash and wrapped (at most a third of the page), a blank line, then the log, wrapped (`(no output yet)` while it runs, `(no output)` once done, also for only whitespace). The keys are pinned to the bottom row, with a counter on the right when the log scrolls (`120-150/400`).
- It shows the last 1 MB of the log, re-read every 250 ms when it grows (cleaned of control codes and wrapped again only then, or when the width changes); a running job's time updates once a second. It follows new output until you scroll up; then the view stays put (it keeps an absolute top line) until you scroll back to the bottom or press End.
- Each line shows only the text after its last `\r`, so a progress bar shows its last state. Tabs become 4 spaces. Color escapes stay. All other escapes (cursor moves, OSC titles and hyperlinks, charset switches) and control codes are removed, also when they are cut off.
- ↑/↓, PgUp/PgDn and the mouse wheel scroll, Home jumps to the top, End follows, `x` twice kills (running jobs only), Esc or `q` closes.

## 7. Other extensions

Events on `pi.events` are the only link. Nothing imports another extension, and each works alone.

- **`bash-bg:update`** is emitted when anything changes (compared as JSON on every tick). Consumers compute elapsed times from `startedAt`.

  ```ts
  { jobs: { pid, command, cwd, startedAt, endedAt?, state }[], // this session's watched jobs, newest first
    running: number, // of those, running
    waiting: number, // running, or ended with the end message not sent yet, while the agent is idle; else 0
    shortcut: string } // config.shortcut, for hints
  ```

- pi-bash-bg listens for **`bash-bg:kill { pid }`** and **`bash-bg:logs { pid }`**.
- **`bash-cap:limits`:** before building an end message, pi-bash-bg emits `{ maxLines, maxBytes }` holding pi's defaults; pi-bash-cap, when loaded, overwrites them with its own (the bus calls listeners synchronously).
- **pi-footer**, after its first `bash-bg:update` (its dashboard itself is described in pi-footer's README):
  - The footer line gets `󰦖 2` (md-progress-clock) on its right, before the context, while jobs run. It is never dropped on narrow terminals. A click on it opens the dashboard at the jobs tab, and so do ↓ and `/footer` while jobs run.
  - Once this session has jobs, the dashboard gets a `jobs` tab (`jobs 2`: the running count). It comes after `git` and before pi-herd's `agents` tab. The tab lists the running jobs by start time, then the finished ones by end time while `e` shows them, 3 rows at a time and always 3 rows tall (with none running and finished ones hidden: `no running jobs` on the first row, and `e show ended (2)` on the hint line at the bottom), scrolling with the selection (`3/12` when there are more). With the keys on the dashboard, ↑/↓ select, Enter opens the log viewer (`bash-bg:logs`), `x` twice kills a running one (`bash-bg:kill`), `e` shows or hides finished ones; a click selects a row, and a click on the selected row opens its log.
  - While an overlay is up, the keys go to it: `onTerminalInput` runs before overlay focus, so without that check the tab would eat the log viewer's keys. Raw input also carries key releases (kitty protocol); they are skipped, or each press would count twice.
  - The selection follows its job across updates while the tab is open, and starts at the top otherwise.
- **pi-working:** while `waiting > 0` after a run, the prompt's top border shows `Waiting on 2 background jobs (1m 12s)` (text only) instead of `✓ Worked for …`, timed from when waiting started. This is the only place the waiting state shows.
- **pi-content-layout:**
  - A click on an extension's framed message toggles it, like ctrl+o.
  - Framed messages show pi's `(ctrl+o to expand)` all dim (pi paints the parentheses and words in the message color, with only the key dim).
  - The last running bash row, once it has run 30 s, gets a dim `ctrl+shift+b to run in background` line hanging under it. Only the last: the key moves every running call. The shortcut comes from `bash-bg:update`, so it only shows with pi-bash-bg.
- **herdr:** pi-bash-bg emits `herdr:working { source: "pi-bash-bg", active }` for an optional patch to herdr's pi integration. `active` is true while a watched job runs or has ended without its end message sent yet, and from a wake-up (an end message to an idle agent) until the woken run starts, or for 2 s. The wake-up ends in a `setTimeout(0)` after `agent_start`, so every extension's `agent_start` runs first, herdr's included, whichever loaded first. The patch, its timing rules and tests are in [`herdr/`](../../../herdr/README.md) at the repo root, shared with other extensions.

## 8. Config: `~/.pi/agent/extensions/pi-bash-bg.json`

| Key                     | Default          | Meaning                                                                           |
| ----------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `autoBackgroundSeconds` | `120`            | Move a foreground call to the background after this long. `0` turns it off.       |
| `shortcut`              | `"ctrl+shift+b"` | Key that moves running bash calls to the background.                              |
| `keepOnExit`            | `true`           | Keep this session's jobs running when it ends (quit, `/new`, `/resume`, `/fork`). |

## Out of scope

Interactive commands (PTY, tmux, herdr panes); a CLI (the folder is readable with `ls`, `tail` and `cat`); readiness patterns and log watchers; wait and kill tools; limits on concurrent jobs or log size; tracking who killed a job.
