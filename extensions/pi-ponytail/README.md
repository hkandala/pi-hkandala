# pi-ponytail

Makes the agent a lazy senior developer: the simplest solution that works, the standard library before custom code, deletion before addition. The ruleset and skills come from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail). This is a smaller pi port of its extension.

- **Always on.** While the mode is not `off`, the rules from [`skills/ponytail/SKILL.md`](skills/ponytail/SKILL.md) go into the system prompt as a `<ponytail>` section (about 1,300 tokens). Only the current mode's intensity row and example are kept.
- **Cache-friendly.** It is a prompt section, not a full system prompt replacement. A mode change is sent as a section update, so the cached prefix stays valid.
- **Skills without the clutter.** `ponytail`, `review`, `audit`, `debt`, and `gain` are not registered as pi skills, so they add no `/skill:` commands and no skill-list entries. `/ponytail run` sends one, and the `<ponytail>` section lists their file paths, so asking to "use ponytail" or for "a ponytail review" mid-session works too.
- **No state.** Every session starts at the default mode. No status bar item, no startup message.

## Commands

| Command                                               | Effect                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `/ponytail mode [lite\|full\|ultra\|off]`             | Set the mode for this session. Applies from the next prompt.                                                                |
| `/ponytail status`                                    | Show the current and default mode                                                                                           |
| `/ponytail run [ponytail\|review\|audit\|debt\|gain]` | Send that skill as a message (queued as a follow-up while the agent is working). `ponytail`, the default, resends the rules |

Modes: `lite` builds what you ask and names the lazier option; `full` enforces the ladder; `ultra` challenges the requirement first; `off` removes the section.

## Install

```bash
pi install npm:@hkandala/pi-ponytail
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-ponytail`.

## Configuration

`~/.pi/agent/extensions/pi-ponytail.json`. The key is optional:

| Key           | Default  | Meaning                                                        |
| ------------- | -------- | -------------------------------------------------------------- |
| `defaultMode` | `"full"` | Mode each session starts in: `lite`, `full`, `ultra`, or `off` |

Run `/reload` after editing.

## Syncing with upstream

`skills/` is copied unchanged from upstream [`skills/`](https://github.com/DietrichGebert/ponytail/tree/main/skills) (v4.10.0, commit `e3ba2aa`), without `ponytail-help`. To update, copy the five folders again. The text still names upstream's commands (`/ponytail lite`, `/ponytail-review`, "stop ponytail"); the model does not run commands, so this is harmless.
