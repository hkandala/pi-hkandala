# pi-ponytail

Makes the agent a lazy senior developer: the simplest solution that works, the standard library before custom code, deletion before addition. The ruleset and skills come from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail). This is a smaller pi port of its extension.

- **Always on, and short.** While the mode is not `off`, a `<ponytail>` section of about 300 tokens goes into the system prompt. It holds the mode and its intensity row, the gist of the rules, and the paths of the skill files. It tells the model to read [`skills/ponytail/SKILL.md`](skills/ponytail/SKILL.md) before it writes, changes or reviews code. So the full rules load only when there is code work.
- **Cache-friendly.** It is a prompt section, not a full system prompt replacement. A mode change is sent as a section update, so the cached prefix stays valid on providers that support prompt updates.
- **Skills without the clutter.** `ponytail`, `review`, `audit`, `debt`, and `gain` are not registered as pi skills. They add no `/skill:` commands and no skill-list entries. `/ponytail run` sends one of them. For `ponytail`, it keeps only the current mode's intensity row and example. The `<ponytail>` section lists the skill file paths, so you can also ask for "use ponytail" or "a ponytail review" at any time.
- **No state.** Every session starts at the default mode. There is no status bar item and no startup message.

## Commands

| Command                                               | Effect                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ponytail mode <lite\|full\|ultra\|off>`             | Set the mode for this session. It applies from the next prompt.                                                                                                                                                                                 |
| `/ponytail status`                                    | Show the current and default mode.                                                                                                                                                                                                              |
| `/ponytail run [ponytail\|review\|audit\|debt\|gain]` | Send that skill as a message. While the agent is working, it is queued as a follow-up. During a `/compact`, it waits until the compaction ends. `ponytail`, the default, resends the rules. While the mode is `off`, it sends the `full` rules. |

Modes:

- `lite` builds what you ask and names the lazier option.
- `full` enforces the ladder: does it need to exist, is it already in the codebase, does the standard library cover it, can it be one line? Only then write code.
- `ultra` challenges the requirement first.
- `off` removes the section.

## Install

```bash
pi install npm:@hkandala/pi-ponytail
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-ponytail`.

## Configuration

`~/.pi/agent/extensions/pi-ponytail.json`. The key is optional:

| Key           | Default  | Meaning                                                                                       |
| ------------- | -------- | --------------------------------------------------------------------------------------------- |
| `defaultMode` | `"full"` | Mode each session starts in: `lite`, `full`, `ultra`, or `off`. Any other value means `full`. |

Run `/reload` after editing.

## Syncing with upstream

`skills/` is copied unchanged from upstream [`skills/`](https://github.com/DietrichGebert/ponytail/tree/main/skills) (v4.10.0, commit `e3ba2aa`), without `ponytail-help`. To update, copy the five folders again. The text still names upstream's commands (`/ponytail lite`, `/ponytail-review`, "stop ponytail"); the model does not run commands, so this is harmless.
