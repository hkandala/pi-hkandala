# pi-content-layout

A compact, minimal transcript for pi: tool calls and thinking sit in a summarized tree of one-line rows, and user messages sit in a rounded box.

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

- **Groups:** tool calls and thinking between two pieces of assistant text form one group. A summary line sits on top ("Read 2 files, ran 1 command", failures in red), with a tree of one-row calls under it. Calls of other extensions' tools read:
  - [pi-web](../pi-web/README.md): "searched the web 3 times, fetched 7 web pages".
  - [pi-bash-bg](../pi-bash-bg/README.md): `bash_list` and `bash_watch` count as commands.
  - [pi-herd](../pi-herd/README.md): "started 2 agents, talked to 3 agents, checked agents, stopped 2 agents", counting the agents each call names. An open `agent_start` or `agent_send` call shows its message as highlighted markdown.

  `ctrl+shift+o` collapses all groups to their summary line, or expands them. The choice is saved to the config file, so it carries over to future sessions. Click a summary line to collapse or expand just that group.

- **Tool rows:** each row shows:
  - the name, in bold italic;
  - the target: a file, command, or pattern;
  - the other params the call passed, dim: `key value`, or `key` for true (`bash  npm run dev · background · timeout 600`, `grep  TODO in src · glob *.ts · ignoreCase`). Edits and writes show theirs as the diff or the code;
  - the result: line or match counts, an edit's `+added -removed`, or a write's `+lines` (in the diff's colors when open), and the duration from 1s up. Parallel calls loaded from history show no duration here (see [Timestamps](#timestamps)). With timestamps on, the duration sits in their column.

  Long targets shorten so the result stays visible, and the params give way first. Param values over 40 characters or on several lines show just their name. Running calls show `running Xs`, and failures are red.

- **Codemode calls:** the tools a `codemode` script calls hang off its row as rows of their own, like any other call: name, target, params, result counts, and duration. Click one to open it (`autoExpandedTools` ones start open), and `ctrl+o` opens them all:

  ```
     Read 2 files, ran 2 commands, edited 1 file, 1 failed
     └ codemode  console.log(await tools.read({ path: "a.txt" })); …  · 2.9s
       ├ read  a.txt · 2 lines
       ├ bash  echo hi && sleep 2 · 2.1s
       ├ edit  a.txt · +1 -1
       │ └  1 hello
       │   -2 world
       │   +2 there
       │
       └ read  missing.txt · error
  ```

  The codemode row shows its last 5 calls under a `… N earlier calls` line: click it to show them all, and click `↑ show less` in its place to cut them again. Open, the codemode row shows its script, and its output after the calls (without the `Script completed`, `Wall time`, `Output:` lines it starts with). The summary line counts each codemode call as a command, and its script's calls as their own ("Read 2 files, ran 2 commands"), and the script's failed calls as failures.

  pi passes extensions each call's args and result while it runs, but never saves the results. For history (after a restart or `/reload`), the calls show their target, params, how they ended, and their duration, with no counts or output. They don't open, except failed ones, which show their error. To save memory, only the last 100 calls that ended keep their results. Older calls that succeeded then read the same way as calls from history.

- **Background hint:** with [pi-bash-bg](../pi-bash-bg/README.md), the last running bash call gets a dim `ctrl+shift+b to run in background` line under it once it has run 30s. The key moves all running calls, so one hint is enough.
- **Pulse:** in fullscreen TUI mode, what's still running pulses gently: a closed call's whole row, an open call's name, `thinking…`, or a collapsed group's summary line. A summary line pulses from the group's start until text or a message ends the group, or the agent stops, so it keeps going between calls. Closed ones go from muted a little toward bright, open ones from bright a little toward muted.
- **Thinking:** a tree row, `thinking…` while it streams, then `thought for Xs`: `thought briefly` under a second, and `thought for some time` for messages loaded from history, since pi saves no thinking time. Thinking with no tool calls around it is a single `Thought for Xs` line. It opens or closes with `ctrl+t`, pi's own setting, new thinking included.
- **Assistant text:** every piece starts with a `●`; click it to copy the reply (see [Copying](#copying)).
- **Status lines:** pi's status lines, notices, warnings, and errors sit at column 3, lined up with assistant text, without a `●`. These include setting changes, cache warnings, `Operation aborted`, an extension's notifications, and extension messages drawn as a plain line, like pi-continue's `Nudged to continue`. Queued steering and follow-up messages above the prompt sit at column 3 too (inside [pi-footer](../pi-footer/README.md)'s prompt box edges, when you use it).
- **User messages:** in a rounded border like [pi-footer](../pi-footer/README.md)'s prompt box, without pi's background.
- **Special messages:** compaction and branch summaries, skill invocations, and extension messages sit in a dashed rounded border, with their label in the top edge (`╭┄┄ compaction ┄┄╮`). Extension messages get it when they use pi's default look or an extension's own background box (like [pi-bash-bg](../pi-bash-bg/README.md)'s `background job` end messages). Click a summary, a skill, or an extension's box to open it; their `(ctrl+o to expand)` is dim. Both kinds of box sit a column in on each side, so their text lines up with assistant text.
- **User bash and info panels:** `!cmd` runs and panels between horizontal rules read like assistant text: a `●` and column 3, without pi's horizontal rules. Panels are pi's (`/changelog`, `/hotkeys`, update notices) or an extension's (pi-header's `/loaded`). The `●` takes the theme's text color for assistant text, pi's bash color for `!cmd` (dim for `!!cmd`, which stays out of the context), and the accent color for panels, like their heading.

## Open rows

- **Open or close:** click a row (fullscreen TUI mode) to open or close it within the tree. Tools listed in `autoExpandedTools` (edits and writes, by default) start open. `ctrl+o` opens or closes all tool rows, clicked ones and `autoExpandedTools` ones too (and cuts expanded ones again), and `ctrl+t` all thinking.
- **Content:** it hangs off a `└` under the row (a line lower when the row takes more than one line), followed by a blank line. Edits show their diff, reads and writes their code with line numbers (a read's from its offset), and other tools their output (live while running). Thinking shows its text.
- **Input:** an open row also shows its full input. A target cut off with `…` wraps in full under it (a bash command with its own line breaks), with every param whole.
- **Long lines:** long lines of open content (a read, a write, a diff, bash or other output) end in `…`, or wrap with `ctrl+shift+w`. Numbered code wraps under its code, not its number. A call's full input (a bash command), thinking, and a pi-herd message always wrap.
- **Line limit:** the input, the content, and open thinking each show up to `maxExpandedLines` (10 by default), then `↓ N more lines`. Click it to show the rest, and click `↑ show less` at the end to cut it again.
- **Colors:** closed rows, thinking, and collapsed groups are muted. Opened or expanded ones read in the text color, like their content.
- **Margins:** rows and text keep a 3-column margin on both sides. The transcript always ends one blank line further from the prompt, whatever comes last.

## Syntax highlighting

Read, written, and edited code is colored by pi's own highlighter (the one for code blocks in assistant text), by file extension, in the pi theme's `syntax*` colors: switch themes, or make your own (pi's themes docs), to change them. An open bash command is colored as bash, and an open codemode script as JavaScript (red when it failed); output stays plain. Edits tint added and removed lines with the theme's tool backgrounds, and when a changed line pairs with its new version, mark the changed words with a stronger tint:

```
   └ edit  math.js · +1 -1
     └   2   const total = items.length;
       - 3   if (total < max) return;
       + 3   if (total <= max) return;
         4   return items.slice(0, max);
```

## Shortcuts

| Shortcut       | Does                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctrl+o`       | Open or close all tool rows (pi's)                                                                                                                                                              |
| `ctrl+t`       | Open or close all thinking (pi's)                                                                                                                                                               |
| `ctrl+shift+o` | Collapse or expand all groups to their summary line (saved)                                                                                                                                     |
| `ctrl+shift+t` | Cycle [timestamps](#timestamps): off → relative → absolute (saved)                                                                                                                              |
| `ctrl+shift+w` | Wrap long lines of open tool content, or end them in `…` (saved)                                                                                                                                |
| Click          | Fullscreen TUI mode. A row, thought, or summary line: open or close just that one; a `↓ N more lines`, `… N earlier calls`, or `↑ show less` line: show or cut the rest; a reply's `●`: copy it |

## Compatibility

pi has no public API for restyling its own messages, so this extension patches the rendering of pi's message and tool components (restored on shutdown, and falling back to pi's own rendering on any error). It doesn't combine with other extensions that restyle the same components.

pi draws its own UI for a moment at startup, before extensions start. Install [pi-no-flash](../pi-no-flash/README.md) to start with every extension's UI, pi-content-layout's included, in the first frame.

## Copying

In fullscreen TUI mode, click a reply's `●` to copy the reply as written, in markdown; it shows `✓` for a moment.

In fullscreen TUI mode, selecting text copies it without the layout's decoration: box edges and sides, tree lines, bullets, timestamps, and `↓`/`↑` lines. Text wrapped to fit (assistant text, boxes, thinking on its own) joins back into its original lines. Tool output and code keep their lines, dedented to column 0: a read or write copies without its line numbers, a diff as its code after the edit (no line numbers, `+`/`-`, or removed lines), wherever the selection starts and with wrapped lines joined back, and a code block in assistant text without its extra indent. Lines cut off with `…` copy as shown (`ctrl+shift+w` wraps them to show them whole).

With pi on another machine in a pane that [Oriel](https://github.com/hkandala/oriel) shows, the copy lands on Oriel's Mac ([herdr/](../../herdr/README.md#oriel-copy)).

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

- **Messages, summary lines, user bash:** when they happened: user and assistant messages, compaction and branch summaries, skills, boxed extension messages, group summary lines, `!cmd` runs (when they finished), and info panels like `/hotkeys` and `/loaded` (when they opened; they aren't restored from history). Boxed messages carry the time in their top edge. Relative: `now`, `12m ago`, `3h ago`, `2d ago`, … Absolute: `14:02:31` today, `Sep 24 14:02` earlier this year, `Sep 24 2025` before that (`2:02:31 pm`, `Sep 24 2:02 pm` with `"timestampFormat": "12h"`).
- **Tool rows:** how long the call took. pi saves the results of parallel calls only once the whole batch finishes, so for history those rows show the batch's time as an upper bound (`≤0.1s`), unless the tool reports its own `durationMs` in its result details (pi-bash-bg's bash does); single calls and live runs are exact.

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
  "autoExpandedTools": ["edit", "write"],
  "maxExpandedLines": 10,
  "enableWordWrap": false,
  "collapseGroups": false,
  "timestamps": "off",
  "timestampFormat": "24h"
}
```

| Key                 | Values                              | Default             | Notes                                                                                                                  |
| ------------------- | ----------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `autoExpandedTools` | tool names                          | `["edit", "write"]` | Tools whose rows start open, e.g. `["edit", "write", "read"]`; `[]` for none                                           |
| `maxExpandedLines`  | a number                            | `10`                | Most lines open thinking, and an open call's input and content, each show until clicked; `0` for no limit              |
| `enableWordWrap`    | `true`, `false`                     | `false`             | Wrap long lines of open tool content (read, write, diffs, output) instead of ending them in `…`; set by `ctrl+shift+w` |
| `collapseGroups`    | `true`, `false`                     | `false`             | Groups start collapsed; set by `ctrl+shift+o`                                                                          |
| `timestamps`        | `"off"`, `"relative"`, `"absolute"` | `"off"`             | Set by `ctrl+shift+t`; see [Timestamps](#timestamps)                                                                   |
| `timestampFormat`   | `"24h"`, `"12h"`                    | `"24h"`             | Clock for absolute timestamps                                                                                          |
