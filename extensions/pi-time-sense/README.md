# pi-time-sense

Gives the agent a sense of time, for long sessions that run for hours or across days.

Pi's system prompt does not include the date. Pi removed it so that the prompt stays cacheable. So the model cannot tell what day it is, how long it has been working, or that you came back the next morning. This extension adds a hidden marker at the end of the transcript, at most once an hour by default:

```xml
<automatic-current-time>Mon 2026-07-13 07:05 GMT+3 (session +2d3h)</automatic-current-time>
```

- **Only rides on existing activity.** A marker is attached to your next prompt, to the first model call of a run that starts without a prompt (for example a [pi-continue](../pi-continue/README.md) nudge, a [pi-bash-bg](../pi-bash-bg/README.md) job's end message, or a [pi-herd](../pi-herd/README.md) message or wake-up), or to the model call that follows a finished tool call. It never starts a turn of its own, and an idle agent gets nothing.
- **Cache-friendly.** Markers are only ever appended, so the cached prompt prefix stays valid.
- **Hidden.** The model sees it. The transcript does not show it.
- **Covers gaps.** After any break longer than the interval, the next run carries a fresh time, whether your prompt or something else starts it.
- **Forks keep the clock.** Elapsed time counts from the oldest parent session still on disk.

Based on [giladbarnea/pi-time-sense](https://github.com/giladbarnea/pi-time-sense).

## Install

```bash
pi install npm:@hkandala/pi-time-sense
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-time-sense`.

## Configuration

`~/.pi/agent/extensions/pi-time-sense.json`. The key is optional:

| Key               | Default | Meaning                             |
| ----------------- | ------- | ----------------------------------- |
| `intervalMinutes` | `60`    | Minimum minutes between two markers |

`0` sends a marker at the start of every run and after every tool call. A negative or non-number value means `60`.

Run `/reload` after editing.

## Notes

- Each marker costs about 30 tokens. A busy 8-hour run adds only about 250 tokens.
- After `/reload` or resume, the interval continues from the last marker on the branch, so no extra marker is sent.
