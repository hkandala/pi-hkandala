# pi-bash-cap

Configurable output limits for pi's built-in `bash` tool.

Pi caps bash output at 2000 lines or 50KB (about 12k tokens), whichever comes first, and the limit can't be changed. This extension halves that by default (1000 lines or 25KB) and lets you set your own. The bash tool description the model sees is updated to state the configured limits. Everything else works as before: the model gets the tail of the output, the same `[Showing lines X-Y of N. Full output: /tmp/...]` notice, the full output in a temp file it can `read`, and the exit status for failed commands.

## Install

```bash
pi install npm:@hkandala/pi-bash-cap
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-bash-cap`.

## Configuration

`~/.pi/agent/extensions/pi-bash-cap.json`. Both keys are optional:

| Key        | Default | Meaning                             |
| ---------- | ------- | ----------------------------------- |
| `maxLines` | `1000`  | Most lines of output the model sees |
| `maxBytes` | `25600` | Most bytes of output the model sees |

The first limit reached wins. For reference, pi's own cap is 2000 lines / 51200 bytes, Claude Code shows about 30,000 characters (about 7.5k tokens), and Codex shows 10k tokens.

Run `/reload` after editing.

## Notes

- Limits can also go higher than pi's defaults: the rest is read back from pi's full-output file.
- While a command is running, the live preview in the TUI still uses pi's own limits. The cap applies to the final result.
- The bash tool's description (the text sent to the model that explains the tool, including "Output is truncated to last 2000 lines or 50KB") is changed to state the configured limits. The change applies only to what is sent to the model, so the session file keeps pi's original text. If another extension replaces the bash tool with its own description, that description is left as is.
