# pi-continue

Press **`ctrl+shift+enter`** to nudge the agent to continue without typing it. Whatever is in the editor stays there. If the agent is still working, the nudge is queued as a follow-up and sent once the agent finishes.

The nudge is not a user message. The model receives a hidden `<continue-nudge>Continue from where you stopped.</continue-nudge>` message, and the transcript shows a dim `Nudged to continue` line in its place.

## Install

```bash
pi install npm:@hkandala/pi-continue
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-continue`.

`ctrl+shift+enter` needs a terminal that reports it (Kitty keyboard protocol: Ghostty, Kitty, WezTerm, recent iTerm2). In tmux, set `extended-keys on` and `extended-keys-format csi-u` (see pi's `docs/tmux.md`).

## Configuration

None. The key is fixed.
