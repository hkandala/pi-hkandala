# pi-content-layout

A compact, minimal transcript for pi: tool calls and thinking collapse into a summarized tree, and user messages sit in a rounded box.

```
╭───────────────────────────────────────────────────────────────────────────────╮
│ add a sub function to math.js and run the tests                               │
╰───────────────────────────────────────────────────────────────────────────────╯

 ● Read 2 files, ran 1 command
   ├ thought for 4s
   ├ read  math.js · 3 lines
   ├ read  README.md · 1 line
   └ bash  grep -rn 'return' .

 ● Adding sub now.

 ● Edited 1 file, ran 1 command, 1 failed
   ├ edit  math.js · +4 -0
   │    3 }
   │   +4
   │   +5 export function sub(a, b) {
   │   +6   return a - b;
   │   +7 }
   └ bash  npm test · exit 1
         FAIL math.test.js › sub

 ● I added sub(a, b) after add in math.js; the test run fails on the new case.
```

- **Groups:** tool calls and thinking between two pieces of assistant text form one group: a summary line ("Read 2 files, ran 1 command", failures in red) with a tree of one-row calls under it.
- **Tool rows:** name, target (file, command, or pattern), and result (line or match counts, `+added -removed`, duration from 1s up). Edits keep their full diff, a running bash shows its last 3 output lines, and failures show the error.
- **Thinking:** a tree row, `thinking…` while it streams, then `thought for Xs` (`thought briefly` under a second; messages loaded from history show just `thought`, since pi saves no thinking time).
- **Assistant text:** every piece starts with a `●`.
- **User messages:** in a rounded border matching [pi-footer](../pi-footer/README.md)'s prompt box, without pi's background.

Click a tool row or the thinking row (fullscreen TUI mode) to open pi's full view of it, or press `ctrl+o` to expand all tool output. Rows and text keep a 3-column margin on both sides.

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

| Key     | Values          | Default | Notes                                           |
| ------- | --------------- | ------- | ----------------------------------------------- |
| `diffs` | `true`, `false` | `true`  | `false` hides edit diffs (click a row for them) |
