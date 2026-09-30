# herdr patch (optional)

[herdr](https://herdr.dev) shows each pane's agent state. Its pi integration reports `idle` as soon as the agent's turn ends, even when background jobs are still running and will wake the agent when they finish. herdr then plays its "done" sound and shows its toast.

This patch keeps the pane at `working` while pi-bash-bg has jobs that will wake the agent. The pane goes idle/done only when the turn has ended and no watched jobs are running.

## What it changes

herdr installs its pi integration at `~/.pi/agent/extensions/herdr-agent-state.ts`. The patch changes 8 lines there:

- It listens for a `herdr:working` event on `pi.events`, shaped `{ source: string, active: boolean }`, and keeps a set of the sources that are active.
- It reports `working` while the agent runs **or** that set is not empty. `blocked` still takes priority.

Details:

- The set makes repeated events harmless, and lets more than one extension use the event.
- The flag is stored even before the session starts, so an event that arrives early still counts.
- Without pi-bash-bg, nothing sends the event and the integration behaves exactly as before.

## When pi-bash-bg emits

`active` is true while watched jobs run and the agent is idle. herdr plays "done" on every working → idle change, with no debounce, so pi-bash-bg must never let it see even a brief idle while it is still waiting:

- **Every change** of `active` is emitted, and the current value at every `session_start`.
- **`/reload`:** extension load order isn't guaranteed. If herdr's integration loads first, it publishes its state at its own `session_start`, before pi-bash-bg's handler runs. So pi-bash-bg also emits `true` from its factory when the value cached on `globalThis` is true. The patched integration stores the flag even before its session starts.
- **A job's end wakes an idle agent:** `active` stays true until the woken run's `agent_start` (or 2 s if no run starts). Otherwise herdr would see idle between the job's end and the run's start.
- **While the agent runs,** `false` is emitted right away; the run's own end reports idle.
- **Never from `session_shutdown`:** the next `session_start` sends the right value.

## Apply

Pick the folder for your herdr version (`herdr --version`). Each folder also lists the pi integration version it was made for, which is the `HERDR_INTEGRATION_VERSION=` line at the top of the file (`herdr integration status` shows it as `pi: current (v9)`).

```bash
patch ~/.pi/agent/extensions/herdr-agent-state.ts < v0.9.1/herdr-agent-state.patch
```

Then run `/reload` in pi.

herdr overwrites the file whenever the integration is reinstalled or updated, so apply the patch again after that. If there is no folder for your herdr version yet, the latest folder's patch may still apply; `patch --dry-run` shows whether it does.

## Test

`test.mts` applies a patch to a temporary copy of your integration file, then replays pi events against a fake herdr socket and checks the states that get reported (turn end, a job waking the agent, reload order, blocked, repeated events):

```bash
node --experimental-strip-types herdr/test.mts v0.9.1
```

It needs the unpatched file: once the patch is applied, pass a fresh copy as a second argument (e.g. a backup taken before patching). Run it before adding a folder for a new herdr version.

## Versions

| Folder    | herdr | pi integration |
| --------- | ----- | -------------- |
| `v0.9.1/` | 0.9.1 | v9             |

## Known issues in herdr's pi integration (herdr 0.9.1, integration v9)

The patch doesn't fix these; they are worth reporting to herdr.

1. **A state report can be lost to a session report.**
   - herdr keeps one sequence counter per source, shared by `pane.report_agent_session` and `pane.report_agent` (`accept_hook_report` in herdr's `src/terminal/state.rs`).
   - The integration numbers a state report when it queues it, but sends it only after the previous send finishes. `agent_start` sends a session report right away with a higher number.
   - If a state report is waiting behind a slow send, and the state it carries is unchanged at `agent_start` (so it isn't queued again), herdr receives it after the higher-numbered session report and drops it. The pane then stays on the old state until the next change.
   - It is rare, because the socket is local and fast.
2. **Failed sends are never retried.** The last state is recorded when it is queued, not when it is delivered. If both attempts fail (herdr busy or restarting), the same state is never sent again, and herdr stays stale until the next state change.
3. **pi's own UI prompts don't show as blocked.** The integration only counts `herdr:blocked` events from other extensions. pi's native `ui_prompt_start` / `ui_prompt_end` events, which fire for blocking extension dialogs (confirm, select, input, editor), are ignored. So a pending dialog shows as `working` or `idle` instead of `blocked`.
4. **An `agent_settled` during compaction is skipped.** The handler ignores `agent_settled` unless `isIdle()` is true. If compaction is still running at that moment, idle is never reported, and the pane stays `working` until the next run.
5. **No release on exit.** herdr's docs say an integration should release its lifecycle authority when the agent exits, and this one doesn't. herdr's process-exit detection appears to cover it.
