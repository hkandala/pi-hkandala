# herdr

Optional pieces for [herdr](https://herdr.dev), shared by the extensions in this repo:

| Folder              | What                                                                                                           | Used by                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`patch/`](patch)   | A patch to herdr's pi integration: keeps a pane `working` while work that will wake the agent is still pending | [pi-bash-bg](../extensions/pi-bash-bg/README.md) (background jobs), pi-herd (waits on other agents) |
| [`plugin/`](plugin) | A herdr plugin with popups: attach to, or watch, another pane's terminal in a floating window                  | pi-herd (`/agents`)                                                                                 |

Each extension works without them. They only make herdr's display right and add the popups.

## Patch

herdr shows each pane's agent state. Its pi integration reports `idle` as soon as the agent's turn
ends, even when something will wake the agent again: a background job still running, or another
agent it is waiting on. herdr then plays its "done" sound and shows its toast.

The patch keeps the pane at `working` while any extension says it has such pending work. The pane
goes idle/done only when the turn has ended and nothing is pending.

### What it changes

herdr installs its pi integration at `~/.pi/agent/extensions/herdr-agent-state.ts`. The patch
changes 8 lines there:

- It listens for a `herdr:working` event on `pi.events`, shaped
  `{ source: string, active: boolean }`, and keeps a set of the sources that are active.
- It reports `working` while the agent runs **or** that set is not empty. `blocked` still takes
  priority.

Details:

- The set makes repeated events harmless, and lets more than one extension use the event. Current
  sources are `pi-bash-bg` and `pi-herd`.
- The flag is stored even before the session starts, so an event that arrives early still counts.
- Without an extension sending the event, the integration behaves exactly as before.

### Rules for an extension that emits `herdr:working`

`active` is true while the agent is idle and something pending will wake it. herdr plays "done" on
every working → idle change, with no debounce, so an extension must never let herdr see even a brief
idle while it is still waiting:

- **Every change.** Emit every change of `active`, and the current value at every `session_start`.
- **`/reload`:** extension load order isn't guaranteed. If herdr's integration loads first, it
  publishes its state at its own `session_start`, before the extension's handler runs. So also emit
  `true` from the extension's factory when the value cached on `globalThis` is true. The patched
  integration stores the flag even before its session starts.
- **Waking an idle agent:** when pending work ends and wakes the agent, keep `active` true until the
  woken run's `agent_start` (or 2 s if no run starts). Otherwise herdr would see idle between the end
  and the run's start.
- **While the agent runs:** emit `false` right away. The run's own end reports idle.
- **Never from `session_shutdown`:** the next `session_start` sends the right value.

### Apply

Pick the folder for your herdr version (`herdr --version`). Each folder also lists the pi
integration version it was made for. That is the `HERDR_INTEGRATION_VERSION=` line at the top of the
file; `herdr integration status` shows it as `pi: current (v9)`.

```bash
patch ~/.pi/agent/extensions/herdr-agent-state.ts < patch/v0.9.1/herdr-agent-state.patch
```

Then run `/reload` in pi.

herdr overwrites the file whenever the integration is reinstalled or updated, so apply the patch
again after that. If there is no folder for your herdr version yet, the latest folder's patch may
still apply; `patch --dry-run` shows whether it does.

### Test

`patch/test.mts` applies a patch to a temporary copy of your integration file. It then replays pi
events against a fake herdr socket and checks the states that get reported: turn end, pending work
waking the agent, reload order, blocked, and repeated events.

```bash
node --experimental-strip-types herdr/patch/test.mts v0.9.1
```

It needs the unpatched file. Once the patch is applied, pass a fresh copy as a second argument (for
example, a backup taken before patching). Run it before adding a folder for a new herdr version.

### Versions

| Folder          | herdr        | pi integration |
| --------------- | ------------ | -------------- |
| `patch/v0.9.1/` | 0.9.1, 0.9.3 | v9             |

### Known issues in herdr's pi integration (herdr 0.9.1, integration v9)

The patch doesn't fix these; they are worth reporting to herdr.

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
3. **pi's own UI prompts don't show as blocked.** The integration only counts `herdr:blocked` events
   from other extensions. It ignores pi's native `ui_prompt_start` / `ui_prompt_end` events, which
   fire for blocking extension dialogs (confirm, select, input, editor). So a pending dialog shows as
   `working` or `idle` instead of `blocked`.
4. **An `agent_settled` during compaction is skipped.** The handler ignores `agent_settled` unless
   `isIdle()` is true. If compaction is still running at that moment, idle is never reported, and
   the pane stays `working` until the next run.
5. **No release on exit.** herdr's docs say an integration should release its lifecycle authority
   when the agent exits, and this one doesn't. herdr's process-exit detection appears to cover it.

Issues 3 and 4 are planned for this patch alongside pi-herd, since pi-herd depends on herdr showing
dialogs as blocked and turns as settled.

## Plugin

herdr opens a floating window (a **popup**) only from a plugin pane. A pane's command and its border
title are fixed in the manifest. So `plugin/` holds a manifest with no code, and each pane runs
whatever shell command the caller passes in `POPUP_COMMAND`. There is one popup per herdr session at
a time anyway.

herdr's popup has no close button, and clicks outside it are ignored. The only hint a user sees is
the border title, so there is one pane per way of closing, and its title says how:

| Pane     | Title               | For                                                                                      |
| -------- | ------------------- | ---------------------------------------------------------------------------------------- |
| `attach` | `ctrl+b q to close` | `herdr agent attach`: `ctrl+b q` detaches, the popup closes, and the agent keeps running |

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
  `logs` pane titled `ctrl+c to close`.
- Ask herdr upstream for a way to close a popup with the mouse (a close mark in the border, or a
  click outside), and for a per-open title, which would allow one generic pane.
