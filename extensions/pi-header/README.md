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
- **Click the text**: expands or collapses the header. Unlike ctrl+o, it does not change tool output. This also needs fullscreen mode.
- **`/loaded`**: prints every loaded resource with its full path into the transcript, like `/hotkeys`. pi never sends it to the model. The entry stays in the session file, but it does not show again after a restart or `/reload`.

The counts and lists leave out pi's built-in `dark` and `light` themes.

Until you send your first message, pi-header hides the info lines that pi would post under the header, so nothing sits between the header and the chat. These are pi's status lines, at startup and from shortcuts and commands (for example `Thinking level: xhigh`, `TUI mode: fullscreen`, `Tool output: expanded`), and the info notices of other extensions. Errors and warnings still show.

The logo is rendered pixel-accurately: each pixel is one row tall and exactly one cell-height wide, measured from the terminal's reported cell size. Edges are placed with 1/8-cell block characters, so pixels stay square in any font.

Set `"compact": true` for a header half the height:

```
  ▀▀█   pi v0.86.1 · esc interrupt · / commands · ! bash · ctrl+o expand
  █▀ █  2 context · 7 skills · 11 extensions · 4 themes
```

The compact logo uses half-block characters (`▀▄`): each pixel is half a row tall and as wide as that in whole cells, so pixels stay close to square.

## Install

```bash
pi install npm:@hkandala/pi-header
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-header`.

## Configuration

Optional file: `~/.pi/agent/extensions/pi-header.json`

```json
{ "logo": "color", "compact": false }
```

| Key       | Values               | Default   |
| --------- | -------------------- | --------- |
| `logo`    | `"color"`, `"white"` | `"color"` |
| `compact` | `true`, `false`      | `false`   |

Clicking the logo updates `logo` for you and keeps the other keys. If the file is not valid JSON, the click does not change it.

Recommended: hide pi's built-in resource listing so it isn't shown twice, in `~/.pi/agent/settings.json`:

```json
{ "quietStartup": true }
```
