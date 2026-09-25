# pi-content-layout

A compact, minimal transcript for pi: tool calls and thinking collapse into a summarized tree, and user messages sit in a rounded box.

```
╭───────────────────────────────────────────────────────────────────────────────╮
│ add a sub function to math.js and run the tests                               │
╰───────────────────────────────────────────────────────────────────────────────╯

   Read 2 files, ran 1 command
   ├ thought for 4s
   ├ read  math.js · 3 lines
   ├ read  README.md · 1 line
   └ bash  grep -rn 'return' .

 ● Adding sub now.

   Edited 1 file, ran 1 command, 1 failed
   ├ edit  math.js · +4 -0
   │ └  3 }
   │   +4
   │   +5 export function sub(a, b) {
   │   +6   return a - b;
   │   +7 }
   │
   └ bash  npm test · exit 1

 ● I added sub(a, b) after add in math.js; the test run fails on the new case.
```

- **Groups:** tool calls and thinking between two pieces of assistant text form one group: a summary line ("Read 2 files, ran 1 command", failures in red) with a tree of one-row calls under it.
- **Tool rows:** name, target (file, command, or pattern), and result (line or match counts, `+added -removed` in the diff's colors, duration from 1s up). Long targets shorten so the result stays visible. Running calls show `running Xs` and failures are red.
- **Thinking:** a tree row, `thinking…` while it streams, then `thought for Xs`: `thought briefly` under a second, and `thought for some time` for messages loaded from history, since pi saves no thinking time. Thinking with no tool calls around it is a single `Thought for Xs` line.
- **Assistant text:** every piece starts with a `●`.
- **User messages:** in a rounded border matching [pi-footer](../pi-footer/README.md)'s prompt box, without pi's background.
- **Special messages:** compaction and branch summaries, skill invocations, and extension messages pi draws itself, in a dashed rounded border with their label in the top edge (`╭┄┄ compaction ┄┄╮`). Click a summary or skill to open it.
- **User bash and info panels:** `!cmd` runs and panels between horizontal rules, pi's (`/changelog`, `/hotkeys`, update notices) or an extension's (pi-header's `/loaded`), read like assistant text, a `●` and column 3, without pi's horizontal rules. The `●` is white for assistant text, pi's bash green for `!cmd` (dim for `!!cmd`, which stays out of the context), and accent for panels, like their heading.

Click a row (fullscreen TUI mode) to open or close it within the tree: its content hangs off a `└` under the row, followed by a blank line. Edits open with their diff, other tools show their output (live while running; write: the content), and thinking shows its text. `ctrl+o` opens all tool rows and `ctrl+t` all thinking. Rows and text keep a 3-column margin on both sides, and a group at the end of the transcript gets an extra blank line before the prompt.

pi has no public API for restyling its own messages, so this extension patches the rendering of pi's message and tool components (restored on shutdown, and falling back to pi's own rendering on any error). It doesn't combine with other extensions that restyle the same components.

## Install

```bash
pi install npm:@hkandala/pi-content-layout
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-content-layout`.

## Configuration

Optional file: `~/.pi/agent/extensions/pi-content-layout.json`

```json
{ "diffs": true }
```

| Key     | Values          | Default | Notes                           |
| ------- | --------------- | ------- | ------------------------------- |
| `diffs` | `true`, `false` | `true`  | `false` starts edits closed too |
