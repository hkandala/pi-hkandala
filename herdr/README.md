# herdr

Optional pieces for [herdr](https://herdr.dev), shared by the extensions in this repo:

| Folder              | What                                                                                                           | Used by                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`patch/`](patch)   | A patch to herdr's pi integration: keeps a pane `working` while work that will wake the agent is still pending | [pi-bash-bg](../extensions/pi-bash-bg/README.md) (background jobs), [pi-herd](../extensions/pi-herd/README.md) (waits on other agents) |
| [`plugin/`](plugin) | A herdr plugin with popups: attach to another pane's terminal in a floating window                             | [pi-herd](../extensions/pi-herd/README.md) (`/agents dashboard`, pi-footer's agents tab)                                               |

Each extension works without them. The patch makes herdr's state right, and pi-herd's watches
depend on that state. The plugin adds the popups.

## Patch

herdr shows each pane's agent state. Its pi integration reports `idle` as soon as the agent's turn
ends, even when something will wake the agent again: a background job still running, or another
agent it is waiting on. herdr then marks the pane done at once, and an agent that watches this one
(pi-herd, `herdr agent wait`) takes that as finished. If the pane stays done for
`ui.toast.delay_seconds` (1 s by default), herdr also plays its "done" sound and shows its toast,
when those are on.

The patch keeps the pane at `working` while any extension says it has such pending work. The pane
goes idle/done only when the turn has ended and nothing is pending.

### What it changes

herdr installs its pi integration at `~/.pi/agent/extensions/herdr-agent-state.ts`. The patch
makes four changes there:

- It listens for a `herdr:working` event on `pi.events`, shaped
  `{ source: string, active: boolean }`, and keeps a set of the sources that are active.
- It reports `working` while the agent runs **or** that set is not empty. `blocked` still takes
  priority.
- It fixes a turn end that the integration skips (known issue 4 below). The integration ignores an
  `agent_settled` that arrives while pi still compacts or summarizes a branch, so the pane stays
  `working` until the next run. The patch then checks again every 100 ms, for up to 5 minutes.
  Once pi is idle, it marks the run as ended and reports the state again. A new run or the end of
  the session stops the checks.
- It resumes a pi started with `-ne` with the flags it started with. herdr resumes a pi after a
  server restart with a bare `pi --session <file>`, which loads the default extensions, not the ones
  that pi was given. So the session report carries a resume command: `pi`, the start flags minus the
  ones that pick a session, then `--session <file>`. The flags come from a `pi` launcher's command
  line when one started this pi. A pi started without `-ne` keeps herdr's default. herdr 0.9.2 and
  newer take a resume command. Start such a pi without a message argument, or the resume sends it
  again.

Details:

- The set makes repeated events harmless, and lets more than one extension use the event. Current
  sources are `pi-bash-bg` and `pi-herd`.
- The flag is stored even before the session starts, so an event that arrives early still counts.
- Without an extension sending the event, only the turn-end fix changes what the integration
  reports.

### Rules for an extension that emits `herdr:working`

`active` is true while something pending will wake the agent, whether it is idle or still running.
An agent that watches this one takes any idle as finished, even a brief one. So an extension must
never let herdr see an idle while it is still waiting:

- **Every change.** Emit every change of `active`, and the current value at every `session_start`.
- **`/reload`:** extension load order isn't guaranteed. If herdr's integration loads first, it
  publishes its state at its own `session_start`, before the extension's handler runs. So also emit
  `true` from the extension's factory when the value cached on `globalThis` is true. The patched
  integration stores the flag even before its session starts.
- **Waking an idle agent:** when pending work ends and wakes the agent, keep `active` true until the
  woken run has started (or 2 s if no run starts). Otherwise herdr would see idle between the end
  and the run's start. End it one macrotask after `agent_start` (`setTimeout(..., 0)`), so herdr's
  integration has handled `agent_start` too, whichever extension loaded first.
- **While the agent runs:** keep `active` true while work is pending. The integration publishes idle
  when the turn settles, before an extension's `agent_settled` handler can say otherwise.
- **Until the wake-up is sent:** when pending work ends, count it as pending until the steer that
  reports it is sent. pi-bash-bg counts a job that ended until its end message is sent. pi-herd
  batches messages and endings for 250 ms and counts them until the batch is sent.
- **Never from `session_shutdown`:** the next `session_start` sends the right value.

### Apply

Pick the folder for your herdr version (`herdr --version`) in the Versions table below. The table
also gives the pi integration version that each patch was made for. That is the
`HERDR_INTEGRATION_VERSION=` line at the top of `herdr-agent-state.ts`. `herdr integration status`
shows it as `pi: current (v9)`.

From the repo root:

```bash
patch ~/.pi/agent/extensions/herdr-agent-state.ts < herdr/patch/v0.9.1/herdr-agent-state.patch
```

Then run `/reload` in pi.

herdr overwrites the file whenever the integration is reinstalled or updated. Apply the patch again
after that. To replace an older version of the patch, first run `herdr integration install pi` to
get the unpatched file back. If there is no folder for your herdr version yet, the latest folder's patch can still
apply. `patch --dry-run` shows whether it does.

### Test

`patch/test.mts` gets a fresh, unpatched integration file from `herdr integration install pi` in a
temporary HOME, and applies a patch to it. It then replays pi events against a fake herdr socket and
checks the states that get reported: turn end, pending work waking the agent, reload order,
blocked, repeated events, a turn settling while pi still compacts, compaction during a run, and
the resume command.

From the repo root:

```bash
node --experimental-strip-types herdr/patch/test.mts v0.9.1
```

To test against another integration file, pass it as a second argument. It must be unpatched.
Run the test before adding a folder for a new herdr version.

### Versions

| Folder          | herdr               | pi integration |
| --------------- | ------------------- | -------------- |
| `patch/v0.9.1/` | 0.9.1, 0.9.3, 0.9.5 | v9             |

### Known issues in herdr's pi integration (herdr 0.9.1 and 0.9.3, integration v9)

The patch fixes only issue 4. The others are worth reporting to herdr.

1. **A state report can be lost to a session report.**
   - herdr keeps one sequence counter per source, shared by `pane.report_agent_session` and
     `pane.report_agent` (`accept_hook_report` in herdr's `src/terminal/state.rs`).
   - The integration numbers a state report when it queues it, but sends it only after the previous
     send finishes. `agent_start` sends a session report right away, with a higher number.
   - If a state report is waiting behind a slow send, and the state it carries is unchanged at
     `agent_start` (so it isn't queued again), herdr receives it after the higher-numbered session
     report and drops it. The pane then stays on the old state until the next change.
   - It is rare, because the socket is local and fast.
2. **Failed sends are never retried.** The last state is recorded when it is queued, not when it is
   delivered. If both attempts fail (herdr busy or restarting), the same state is never sent again,
   and herdr stays stale until the next state change.
3. **Extension dialogs don't show as blocked.** The integration only counts `herdr:blocked` events
   from other extensions. It ignores pi's native `ui_prompt_start` / `ui_prompt_end` events, which
   fire for blocking extension dialogs (confirm, select, input, editor). So a pending dialog shows as
   `working` or `idle` instead of `blocked`.
4. **An `agent_settled` during compaction is skipped.** The handler ignores `agent_settled` unless
   `isIdle()` is true. `isIdle()` is false while pi compacts or summarizes a branch. A run can
   settle then: pi-bash-bg and pi-herd wake an idle agent with `triggerTurn`, which starts a run
   even during `/compact`. Idle is then never reported, and the pane stays `working` until the next
   run. **The patch fixes this** (see What it changes).
5. **No release on exit.** herdr's docs say an integration should release its lifecycle authority
   when the agent exits, and this one doesn't. herdr's docs also describe the fallback: herdr clears
   the agent once the pane is back at its shell prompt.

The patch leaves issue 3 alone. pi-herd uses herdr's status as herdr reports it. While a run waits
on a dialog, the pane shows `working`, not `blocked`. So a watch on that agent doesn't end as
blocked: it ends only at its timeout.

## Plugin

A program can open a floating window (a **popup**) in herdr only through a plugin pane. A pane's
command and its border title are fixed in the manifest. So `plugin/` holds a manifest with no code,
and each pane runs whatever shell command the caller passes in `POPUP_COMMAND`. herdr shows one
popup per session at a time, so one pane per kind of popup is enough.

herdr's popup has no close button, and herdr ignores clicks outside it. So the caller shows how to
close it. An agent that pi-herd shows in a popup shows `ctrl+b q or /detach to close` as its
prompt's placeholder. Without pi-footer, the hint shows above the prompt. A pane's title only names
what the popup shows. herdr requires a title that is not blank.

| Pane     | Title      | For                                                                                      |
| -------- | ---------- | ---------------------------------------------------------------------------------------- |
| `attach` | `pi agent` | `herdr agent attach`: `ctrl+b q` detaches, the popup closes, and the agent keeps running |

### Install

From GitHub:

```bash
herdr plugin install hkandala/pi-hkandala/herdr/plugin
```

Or from a checkout, which stays in sync with your edits:

```bash
herdr plugin link ~/code/pi-hkandala/herdr/plugin
```

Plugins are global to your user and work in every herdr session.

### Open a popup

```bash
herdr plugin pane open --plugin pi-hkandala --entrypoint attach --env POPUP_COMMAND='<command>'
```

For example, attach to a pane in another herdr session:

```bash
herdr plugin pane open --plugin pi-hkandala --entrypoint attach \
  --env POPUP_COMMAND='HERDR_SOCKET_PATH=<target socket> exec herdr agent attach <pane> --takeover'
```

- **Target socket.** herdr sets its own `HERDR_*` variables in the popup's env, so a command that
  targets another herdr session sets `HERDR_SOCKET_PATH` itself, as above.
- **Where it opens.** The popup opens over the caller's herdr session.
- **Input and closing.** It takes all keyboard input and closes when its command exits (for example,
  when an attach detaches), or on a `popup.close` socket request.
- **One at a time.** Opening a second popup, or opening one while Settings or copy mode is up,
  returns `ui_busy`.

Checked live on herdr 0.9.3: the popup ran the passed command and attached to another session's pane.
It closed on its own when its command exited, closed on request, and a second open returned
`ui_busy`. Inside an attach popup, `ctrl+b q` reaches the attach client: it detaches, the popup
closes, and the attached agent keeps running.

### Future

- pi-bash-bg: open a background job's log in a popup (`POPUP_COMMAND='tail -f <log>'`) from
  `/background logs` and pi-footer's jobs tab, as an alternative to its in-pi log viewer. It needs a
  `logs` pane. `tail -f` can't show a close hint, so this pane is the exception: its title says how
  to close it (`ctrl+c to close`).
- Ask herdr upstream for a way to close a popup with the mouse (a close mark in the border, or a
  click outside), and for a per-open title, which would allow one generic pane.
