# pi-content-layout

A compact, minimal transcript for pi: tool calls and thinking collapse into a summarized tree, and user messages sit in a rounded box.

```
 ╭─────────────────────────────────────────────────────────────────────────────╮
 │ add a sub function to math.js and run the tests                             │
 ╰─────────────────────────────────────────────────────────────────────────────╯

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
- **Tool rows:** name (bold), target (file, command, or pattern), and result (line or match counts, an edit's `+added -removed` and a write's `+lines`, in the diff's colors when open, duration from 1s up; with [timestamps](#timestamps) on, in their column). Long targets shorten so the result stays visible. Running calls show `running Xs` and failures are red.
- **Thinking:** a tree row, `thinking…` while it streams, then `thought for Xs`: `thought briefly` under a second, and `thought for some time` for messages loaded from history, since pi saves no thinking time. Thinking with no tool calls around it is a single `Thought for Xs` line. It opens or closes with `ctrl+t`, pi's own setting, new thinking included.
- **Assistant text:** every piece starts with a `●`.
- **User messages:** in a rounded border like [pi-footer](../pi-footer/README.md)'s prompt box, without pi's background.
- **Special messages:** compaction and branch summaries, skill invocations, and extension messages pi draws itself, in a dashed rounded border with their label in the top edge (`╭┄┄ compaction ┄┄╮`). Click a summary or skill to open it. Both boxes sit a column in on each side, so their text lines up with assistant text.
- **User bash and info panels:** `!cmd` runs and panels between horizontal rules, pi's (`/changelog`, `/hotkeys`, update notices) or an extension's (pi-header's `/loaded`), read like assistant text, a `●` and column 3, without pi's horizontal rules. The `●` is white for assistant text, pi's bash green for `!cmd` (dim for `!!cmd`, which stays out of the context), and accent for panels, like their heading.

Click a row (fullscreen TUI mode) to open or close it within the tree: its content hangs off a `└` under the row (a line lower when the row takes more than one line), followed by a blank line. Tools listed in `autoExpandedTools` (edits, by default) start open. Edits show their diff, other tools their output (live while running; write: the content), and thinking shows its text. An open row also shows its full input: a target cut off with `…` wraps in full under it (a bash command with its own line breaks). Long content lines end in `…`, or wrap with `enableWordWrap`. The input, the content, and open thinking each show up to `maxExpandedLines` (10 by default), then `↓ N more lines`: click it to show the rest, and `↑ show less` at the end to cut it again. Closed rows, thinking, and collapsed groups are muted; opened or expanded ones read in the text color, like their content. `ctrl+o` opens or closes all tool rows, clicked ones too (and cuts expanded ones again), and `ctrl+t` all thinking. Rows and text keep a 3-column margin on both sides, and a group at the end of the transcript gets an extra blank line before the prompt.

**Syntax highlighting:** read, written, and edited code is colored by pi's own highlighter (the one for code blocks in assistant text), by file extension, in the pi theme's `syntax*` colors: switch themes, or make your own (pi's themes docs), to change them. An open bash command is colored as bash; output stays plain. Edits tint added and removed lines with the theme's tool backgrounds, and when a changed line pairs with its new version, mark the changed words with a stronger tint:

```
   └ edit  math.js · +1 -1
     └   2   const total = items.length;
       - 3   if (total < max) return;
       + 3   if (total <= max) return;
         4   return items.slice(0, max);
```

| Shortcut       | Does                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ctrl+o`       | Open or close all tool rows (pi's)                                                                                           |
| `ctrl+t`       | Open or close all thinking (pi's)                                                                                            |
| `ctrl+shift+o` | Collapse or expand all groups to their summary line (saved)                                                                  |
| `ctrl+shift+t` | Cycle [timestamps](#timestamps): off → relative → absolute (saved)                                                           |
| Click          | A row, thought, or summary line: open or close just that one; a `↓ N more lines` or `↑ show less` line: show or cut the rest |

pi has no public API for restyling its own messages, so this extension patches the rendering of pi's message and tool components (restored on shutdown, and falling back to pi's own rendering on any error). It doesn't combine with other extensions that restyle the same components.

## Timestamps

`ctrl+shift+t` cycles timestamps: off → relative → absolute → off. The mode is saved to the config file, so it carries over to future sessions. Times sit in a dim column on the right, each traced to its line by a faint dotted leader (boxed messages carry theirs in the top edge):

```
 ╭───────────────────────────────────────────────────────── 14:02:31 ─╮
 │ add a sub function to math.js and run the tests                    │
 ╰────────────────────────────────────────────────────────────────────╯

   Read 2 files, ran 1 command  · · · · · · · · · · · · · ·  14:02:33
   ├ read  math.js · 3 lines  · · · · · · · · · · · · · · · · · ≤0.1s
   ├ read  README.md · 1 line · · · · · · · · · · · · · · · · · ≤0.1s
   └ bash  npm test · exit 1  · · · · · · · · · · · · · · · · ·  1.4s

 ● The test run fails on the new case.  · · · · · · · · · ·  14:02:41
```

- **Messages, summary lines, user bash:** when they happened: user and assistant messages, compaction and branch summaries, skills, extension messages pi draws itself, group summary lines, `!cmd` runs (when they finished), and info panels like `/hotkeys` and `/loaded` (when they opened; they aren't restored from history). Boxed messages carry the time in their top edge. Relative: `now`, `12m ago`, `3h ago`, `2d ago`, … Absolute: `14:02:31` today, `Sep 24 14:02` earlier this year, `Sep 24 2025` before that (`2:02:31 pm`, `Sep 24 2:02 pm` with `"timestampFormat": "12h"`).
- **Tool rows:** how long the call took. pi saves the results of parallel calls only once the whole batch finishes, so for history those rows show the batch's time as an upper bound (`≤0.1s`); single calls and live runs are exact.

While timestamps show, assistant text and `!cmd` output wrap a little narrower to leave room for the column. Status lines and notices have no saved time, so they show none.

## Install

```bash
pi install npm:@hkandala/pi-content-layout
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-content-layout`.

## Configuration

Optional file: `~/.pi/agent/extensions/pi-content-layout.json`. Every key has a default; `/reload` after editing.

```json
{
  "autoExpandedTools": ["edit"],
  "maxExpandedLines": 10,
  "enableWordWrap": false,
  "collapseGroups": false,
  "timestamps": "off",
  "timestampFormat": "24h"
}
```

| Key                 | Values                              | Default    | Notes                                                                                                     |
| ------------------- | ----------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `autoExpandedTools` | tool names                          | `["edit"]` | Tools whose rows start open, e.g. `["edit", "write"]`; `[]` for none                                      |
| `maxExpandedLines`  | a number                            | `10`       | Most lines open thinking, and an open call's input and content, each show until clicked; `0` for no limit |
| `enableWordWrap`    | `true`, `false`                     | `false`    | Wrap long lines of open content instead of ending them in `…`                                             |
| `collapseGroups`    | `true`, `false`                     | `false`    | Groups start collapsed; set by `ctrl+shift+o`                                                             |
| `timestamps`        | `"off"`, `"relative"`, `"absolute"` | `"off"`    | Set by `ctrl+shift+t`; see [Timestamps](#timestamps)                                                      |
| `timestampFormat`   | `"24h"`, `"12h"`                    | `"24h"`    | Clock for absolute timestamps                                                                             |
