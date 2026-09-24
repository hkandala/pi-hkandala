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
- **`/loaded`**: prints every loaded resource with its full path into the transcript (like `/hotkeys`). Saved in the session, never sent to the model.

The logo is rendered pixel-accurately: each pixel is one row tall and exactly one cell-height wide, measured from the terminal's reported cell size. Edges are placed with 1/8-cell block characters, so pixels stay square in any font.

## Configuration

Optional file: `~/.pi/agent/extensions/pi-header.json`

```json
{ "logo": "color" }
```

| Key    | Values              | Default   |
| ------ | ------------------- | --------- |
| `logo` | `"color"`, `"white"` | `"color"` |

Recommended: hide pi's built-in resource listing so it isn't shown twice, in `~/.pi/agent/settings.json`:

```json
{ "quietStartup": true }
```

Spacing stays the same with or without `quietStartup`.

## Notes

- Needs a truecolor terminal (Ghostty, kitty, iTerm2, WezTerm).
- Pi doesn't expose its loaded extension list, so the extension count is resolved the way pi does it: CLI `-e` paths plus settings, packages, and auto-discovery.
- Pressing `ctrl+o` before the first message would leave pi's "Tool output: …" status stuck under the header; the extension removes it while it's the chat's only content.
