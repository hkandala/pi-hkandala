# pi-header

A minimal startup header for pi with the official pi logo.

```
   ██████     pi v0.86.1
   ██  ██     esc interrupt · / commands · ! bash · ctrl+o expand
   ████  ██
   ██    ██   2 context · 7 skills · 11 extensions · 4 themes
```

- **Collapsed** (default): shows resource counts.
- **`ctrl+o`**: expands to list context files, skills, prompts, extensions, and themes by name.
- **Click the logo**: toggles between color and white. The choice is saved to the config file below, so it carries over to future sessions. Requires pi's fullscreen TUI mode (`"tuiMode": "fullscreen"`); in regular mode the terminal owns the mouse.
- **Click the text**: expands or collapses the header, like ctrl+o (fullscreen mode too).
- **`/loaded`**: prints every loaded resource with its full path into the transcript (like `/hotkeys`). Never sent to the model, and gone after a restart or `/reload`, like `/hotkeys`.

Status lines pi would post under the header before your first message (e.g. `Thinking level: xhigh`, `TUI mode: fullscreen`, `Tool output: expanded`) are hidden, so nothing sits between the header and the chat. Errors and warnings still show.

The logo is rendered pixel-accurately: each pixel is one row tall and exactly one cell-height wide, measured from the terminal's reported cell size. Edges are placed with 1/8-cell block characters, so pixels stay square in any font.

## Install

```bash
pi install npm:@hkandala/pi-header
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-header`.

## Configuration

Optional file: `~/.pi/agent/extensions/pi-header.json`

```json
{ "logo": "color" }
```

| Key    | Values               | Default   |
| ------ | -------------------- | --------- |
| `logo` | `"color"`, `"white"` | `"color"` |

Clicking the logo updates `logo` for you; other keys are preserved.

Recommended: hide pi's built-in resource listing so it isn't shown twice, in `~/.pi/agent/settings.json`:

```json
{ "quietStartup": true }
```
