# pi-continue

Press **`ctrl+shift+enter`** to send `continue` to the agent without typing it. Whatever is in the editor stays there. If the agent is still working, the message is queued as a follow-up and sent once the agent finishes.

## Install

```bash
pi install npm:@hkandala/pi-continue
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-continue`.

`ctrl+shift+enter` needs a terminal that reports it (Kitty keyboard protocol: Ghostty, Kitty, WezTerm, recent iTerm2; tmux needs `extended-keys on`).
