# pi-prompt-clipboard

Move prompts between pi's editor and your clipboard.

- **`ctrl+shift+s`**: copies the whole prompt to the clipboard and clears the editor. Handy for setting a half-written prompt aside: send something else, then paste it back. Pasted content is copied in full, not as `[paste #1]` markers. `ctrl+-` (undo) brings the prompt back if you pressed it by accident.
- **Paste twice to expand**: pi collapses long pastes (over 10 lines or 1000 characters) into a marker like `[paste #1 +40 lines]`. Paste the same text again with the cursor at that marker, and the marker becomes the full text, ready to edit. Pasting it elsewhere adds a second marker as usual; short pastes are unchanged.

Together they round-trip a long prompt: `ctrl+shift+s` to set it aside, then paste twice to get it back editable. Pairs well with a clipboard manager, which keeps every prompt you've set aside.

pi has no API for paste handling, so this wraps pi's editor paste handler. pi's own paste logic still runs first, and the wrapper steps aside if pi's editor internals change. Works with extensions that replace the editor (such as [pi-footer](../pi-footer/README.md)).

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

Run `/reload` after changing it. `ctrl+shift+` keys need a terminal that reports them (Kitty keyboard protocol: Ghostty, Kitty, WezTerm, recent iTerm2; tmux needs `extended-keys on`). Keys pi already binds elsewhere, such as `ctrl+s` (used in pi's pickers), still work in the editor, but pi lists them under "Extension issues" at every startup.
