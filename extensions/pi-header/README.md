# pi-header

A minimal startup header for pi with pi's own logo.

```
   ▀▀█    v1.0.0
   █▀ █   2 context · 7 skills · 11 extensions · 4 themes
```

- **Collapsed** (default): shows the version and resource counts.
- **`ctrl+o`**: expands to list the context files, skills, prompts, extensions, and themes by name:

  ```
     context    ~/AGENTS.md · AGENTS.md
     skills     find-skills · meta-cli · simple-english
     extensions pi-content-layout · pi-footer · pi-header · …

     /hotkeys for all shortcuts · /loaded for full paths
  ```

- **Click the logo**: plays pi's own 3D logo animation, the same one its built-in header plays. Requires pi's fullscreen TUI mode (`"tuiMode": "fullscreen"`; in regular mode the terminal owns the mouse) and a `quietStartup` other than `true` (see below). pi does not play it in Apple Terminal.
- **Click the text**: expands or collapses the header. Unlike ctrl+o, it does not change tool output. This also needs fullscreen mode.
- **`/loaded`**: prints every loaded resource with its full path into the transcript, like `/hotkeys`. pi never sends it to the model. The entry stays in the session file, but it does not show again after a restart or `/reload`.

The counts and lists leave out pi's built-in `dark` and `light` themes.

Until you send your first message, pi-header hides the `Tool output: expanded` (or `collapsed`) line that pi posts for `ctrl+o`: the header expanding or collapsing already shows the change, and the line would sit between the header and the chat. All other status lines and notices still show, for example `Thinking level: xhigh`, `Switched to <model>`, `/login` results, and other extensions' notices.

The logo is pi's own, in pi's colors, so pi's logo animation starts from it.

pi draws its own header for a moment before pi-header's replaces it. Install [pi-no-flash](../pi-no-flash/README.md) to start with pi-header's header in the first frame.

## Install

```bash
pi install npm:@hkandala/pi-header
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-header`.

## Configuration

Recommended: hide pi's built-in resource listing so it isn't shown twice, in `~/.pi/agent/settings.json`:

```json
{ "quietStartup": "header" }
```

pi does not export the logo animation, so pi-header borrows it from pi's built-in header. With `"quietStartup": true` pi creates no built-in header, and clicking the logo does nothing.
