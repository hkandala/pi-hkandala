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

- **Groups:** tool calls and thinking between two pieces of assistant text form one group: a summary line ("Read 2 files, ran 1 command", failures in red) with a tree of one-row calls under it. `ctrl+shift+o` collapses all groups to their summary line, or expands them (saved to the config file, so it carries over to future sessions); click a summary line to collapse or expand just that group.
- **Tool rows:** name, target (file, command, or pattern), and result (line or match counts, `+added -removed` in the diff's colors, duration from 1s up; with [timestamps](#timestamps) on, in their column). Long targets shorten so the result stays visible. Running calls show `running Xs` and failures are red.
- **Thinking:** a tree row, `thinking…` while it streams, then `thought for Xs`: `thought briefly` under a second, and `thought for some time` for messages loaded from history, since pi saves no thinking time. Thinking with no tool calls around it is a single `Thought for Xs` line.
- **Assistant text:** every piece starts with a `●`.
- **User messages:** in a rounded border matching [pi-footer](../pi-footer/README.md)'s prompt box, without pi's background.
- **Special messages:** compaction and branch summaries, skill invocations, and extension messages pi draws itself, in a dashed rounded border with their label in the top edge (`╭┄┄ compaction ┄┄╮`). Click a summary or skill to open it.
- **User bash and info panels:** `!cmd` runs and panels between horizontal rules, pi's (`/changelog`, `/hotkeys`, update notices) or an extension's (pi-header's `/loaded`), read like assistant text, a `●` and column 3, without pi's horizontal rules. The `●` is white for assistant text, pi's bash green for `!cmd` (dim for `!!cmd`, which stays out of the context), and accent for panels, like their heading.

Click a row (fullscreen TUI mode) to open or close it within the tree: its content hangs off a `└` under the row, followed by a blank line. Edits open with their diff, other tools show their output (live while running; write: the content), and thinking shows its text. An open row also shows its full input: a target cut off with `…` wraps in full under it (a bash command with its own line breaks), and content wraps too, so nothing open is cut off. `ctrl+o` opens or closes all tool rows, clicked ones too, and `ctrl+t` all thinking. Rows and text keep a 3-column margin on both sides, and a group at the end of the transcript gets an extra blank line before the prompt.

| Shortcut       | Does                                                               |
| -------------- | ------------------------------------------------------------------ |
| `ctrl+o`       | Open or close all tool rows (pi's)                                 |
| `ctrl+t`       | Open or close all thinking (pi's)                                  |
| `ctrl+shift+o` | Collapse or expand all groups to their summary line (saved)        |
| `ctrl+shift+t` | Cycle [timestamps](#timestamps): off → relative → absolute (saved) |
| Click          | A row, thought, or summary line: open or close just that one       |

pi has no public API for restyling its own messages, so this extension patches the rendering of pi's message and tool components (restored on shutdown, and falling back to pi's own rendering on any error). It doesn't combine with other extensions that restyle the same components.

## Timestamps

`ctrl+shift+t` cycles timestamps: off → relative → absolute → off. The mode is saved to the config file, so it carries over to future sessions. Times sit in a dim column on the right, each traced to its line by a faint dotted leader (boxed messages carry theirs in the top edge):

```
╭─────────────────────────────────────────────────────────── 14:02:31 ─╮
│ add a sub function to math.js and run the tests                      │
╰──────────────────────────────────────────────────────────────────────╯

   Read 2 files, ran 1 command  · · · · · · · · · · · · · ·  14:02:33
   ├ read  math.js · 3 lines  · · · · · · · · · · · · · · · · · ≤0.1s
   ├ read  README.md · 1 line · · · · · · · · · · · · · · · · · ≤0.1s
   └ bash  npm test · exit 1  · · · · · · · · · · · · · · · · ·  1.4s

 ● The test run fails on the new case.  · · · · · · · · · ·  14:02:41
```

- **Messages, summary lines, user bash:** when they happened: user and assistant messages, compaction and branch summaries, skills, extension messages pi draws itself, group summary lines, `!cmd` runs (when they finished), and info panels like `/hotkeys` and `/loaded` (when they opened; they aren't restored from history). Boxed messages carry the time in their top edge. Relative: `now`, `12m ago`, `3h ago`, `2d ago`, … Absolute: `14:02:31` today, `Sep 24 14:02` earlier this year, `Sep 24 2025` before that.
- **Tool rows:** how long the call took. pi saves the results of parallel calls only once the whole batch finishes, so for history those rows show the batch's time as an upper bound (`≤0.1s`); single calls and live runs are exact.

While timestamps show, assistant text and `!cmd` output wrap a little narrower to leave room for the column. Status lines and notices have no saved time, so they show none.

## Install

```bash
pi install npm:@hkandala/pi-content-layout
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-content-layout`.

## Configuration

Optional file: `~/.pi/agent/extensions/pi-content-layout.json`

```json
{ "diffs": true, "timestamps": "off", "collapseGroups": false }
```

| Key              | Values                              | Default | Notes                                                |
| ---------------- | ----------------------------------- | ------- | ---------------------------------------------------- |
| `diffs`          | `true`, `false`                     | `true`  | `false` starts edits closed too                      |
| `collapseGroups` | `true`, `false`                     | `false` | Set by `ctrl+shift+o`                                |
| `timestamps`     | `"off"`, `"relative"`, `"absolute"` | `"off"` | Set by `ctrl+shift+t`; see [Timestamps](#timestamps) |
