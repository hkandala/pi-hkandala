# pi-prompt-clipboard

Move prompts between pi's editor and your clipboard.

- **`ctrl+shift+s`**: copies the whole prompt to the clipboard and clears the editor. Use it to set a half-written prompt aside: send something else, then paste it back. Pasted content is copied in full, not as `[paste #1]` markers. Undo (`ctrl+-` by default) brings the prompt back if you pressed it by accident.
- **Paste twice to expand**: pi collapses long pastes (over 10 lines or 1000 characters) into a marker like `[paste #1 +40 lines]`. Paste the same text again with the cursor at that marker, and the marker becomes the full text, ready to edit. Pasting it elsewhere adds a second marker as usual. Short pastes are unchanged.

With pi on another machine in a pane that [Oriel](https://github.com/hkandala/oriel) shows, the copy lands on Oriel's Mac ([herdr/](../../herdr/README.md#oriel-copy)).

Together they round-trip a long prompt: `ctrl+shift+s` to set it aside, then paste twice to get it back editable. A clipboard manager helps, because it keeps every prompt you set aside.

pi has no API for paste handling, so this wraps pi's editor paste handler. pi's own paste logic still runs first. If pi's editor internals change, paste falls back to pi's normal behavior. It works with replacement editors built on pi's `CustomEditor`, such as [pi-footer](../pi-footer/README.md).

## Install

```bash
pi install npm:@hkandala/pi-prompt-clipboard
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-prompt-clipboard`.

## Configuration

Optional file: `~/.pi/agent/extensions/pi-prompt-clipboard.json`

```json
{ "shortcut": "ctrl+shift+s" }
```

| Key        | Values                                             | Default          |
| ---------- | -------------------------------------------------- | ---------------- |
| `shortcut` | any pi key, e.g. `"ctrl+shift+c"` (see `/hotkeys`) | `"ctrl+shift+s"` |

Run `/reload` after changing it. `ctrl+shift+` keys need a terminal that reports them (Kitty keyboard protocol: Ghostty, Kitty, WezTerm, recent iTerm2). In tmux, set `extended-keys on` and `extended-keys-format csi-u` (see pi's `docs/tmux.md`).

Most keys that pi already binds elsewhere, such as `ctrl+s` (used in pi's pickers), still work in the editor. pi lists them under "Extension issues" at every startup. pi refuses its core keys (for example `ctrl+c`, `enter`, or `alt+enter`), and the shortcut is then off.
