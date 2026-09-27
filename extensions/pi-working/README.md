# pi-working

Adds an elapsed timer to pi's working label. When the run ends, the spinner turns into a check and the time stays in the prompt's top border.

```
 ╭── ⠋ Working (12s) ─────────────────────────────────╮    while running
 ╭── ✓ Worked for 4m 12s ─────────────────────────────╮    after the run
 ╭── ✓ Worked for 4m 12s · 3m ago ────────────────────╮    a minute or more later
```

| State   | Shows                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Running | `Working (12s)`, then `(4m)`, `(1h 4m)`. The time is dim, and turns yellow when the model has been silent for 30s (running tools don't count) |
| Done    | `✓ Worked for 4m 12s` in the theme's `success` color. `■` (yellow) if you interrupted it, `✗` (red) if it failed                              |
| Cleared | When the next run starts or you press esc (esc still does whatever it normally does in pi)                                                    |

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

- The done label relies on an internal pi editor method (`setWorkingStatusIndicator`). If pi changes it, the label stops showing and nothing else breaks.
- Another extension that also sets pi's working message will clash with this one; the last one to write wins.
