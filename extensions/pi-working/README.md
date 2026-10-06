# pi-working

Adds an elapsed timer to pi's working label. When the run ends, the spinner turns into a check and the time stays in the prompt's top border.

```
 ╭── ⠋ Working (12s) ─────────────────────────────────╮    while running
 ╭── ✓ Worked for 4m 12s ─────────────────────────────╮    after the run
 ╭── ✓ Worked for 4m 12s · 3m ago ────────────────────╮    a minute or more later
 ╭── Waiting on 3 agents and 2 background jobs (1m) ─╮    with pi-herd or pi-bash-bg
```

| State   | Shows                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running | `Working (12s)`, then `(4m)`, `(1h 4m)`. The time is dim. It turns the theme's `warning` color when the model sends nothing for 30s. While a tool runs, it stays dim |
| Done    | `✓ Worked for 4m 12s` in muted text, with the ✓ in the theme's `success` color. `■` (`warning` color) if you interrupted it, `✗` (`error` color) if it failed        |
| Cleared | When the next run starts or you press esc (esc still does whatever it normally does in pi)                                                                           |

With [pi-herd](../pi-herd/README.md) or [pi-bash-bg](../pi-bash-bg/README.md), a run can end while the agent still waits on agents or background jobs that it watches. Then the label reads `Waiting on 3 agents and 2 background jobs (1m)`. Agents come first, and parts that are zero are left out (`Waiting on 1 agent (40s)`). The time starts when the waiting starts. When a watched agent or job ends, it wakes the agent and a new run starts. If the waiting ends some other way, the done label comes back, unless you pressed esc.

A run lasts from sending a message until pi is fully done, so retries, compaction and queued follow-ups all count toward the time.

Works with pi's own editor and with [pi-footer](../pi-footer/README.md)'s box. With an editor that doesn't draw pi's status in its border, the timer still shows in pi's working line, but there is no done label.

## Install

```bash
pi install npm:@hkandala/pi-working
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-working`.

## Configuration

Optional file: `~/.pi/agent/extensions/pi-working.json`

```json
{
  "workingVerbs": ["Working"],
  "doneVerbs": ["Worked"]
}
```

| Key            | Default       | Meaning                                  |
| -------------- | ------------- | ---------------------------------------- |
| `workingVerbs` | `["Working"]` | Running label, shown as `<verb> (12s)`   |
| `doneVerbs`    | `["Worked"]`  | Done label, shown as `<verb> for 4m 12s` |

Each run picks one verb at random from each list, e.g. `["Working", "Cooking", "Brewing"]`. Run `/reload` after editing.

## Notes

- The done label relies on internal parts of pi's editor (`setWorkingStatusIndicator`, `workingStatusIndicator`, `embedWorkingStatus`). If pi changes them, the label stops showing and nothing else breaks.
- Do not combine this with another extension that sets pi's working message. pi-working rewrites the message every second during a run, so the other message shows for a second at most.
