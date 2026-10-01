# pi-footer

A minimal one-line footer for pi, inside a rounded prompt box, that expands into a dashboard.

```
 ╭── ⠋ Working ─────────────────────────────────────────────────────────────────────────────────────────╮
 │ fix the footer so the cache goes cold after compaction                                               │
 │                                                                                                      │
 │  pi-hkandala · 󰘬 master 󰁝2 󰁅1 · +42 -7          cold (~$0.46) · 󰫣 3 · 󰦖 2 · 󰪟 47k/200k · opus-5.5 · high │
 ╰──────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

The box is pi's own editor (same keys, spinner, and autocomplete) drawn with rounded borders and the footer as its last row, set a column in on each side so your text lines up with the transcript's (as in [pi-content-layout](../pi-content-layout/README.md)). A named session (`/name`) shows its name at the right end of the box's top border, when pi's label on the left leaves room. With pi-herd, an agent shown in a herdr popup gets `ctrl+b q or /detach to close` as the empty prompt's dim placeholder. Set `"promptEditor": "default"` to keep pi's editor and show the footer below it. The box replaces pi's editor, so it doesn't combine with other extensions that replace the editor (e.g. vim mode).

| Piece             | Shows                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| folder            | folder pi runs in                                                                                                                                                |
| 󰊢 / 󰙅 repo        | repo name, when it differs from the folder (󰊢) or you are in a linked worktree (󰙅)                                                                               |
| 󰘬 branch `󰁝2 󰁅1`  | git branch, commits to push / pull                                                                                                                               |
| `+42 -7`          | pending line changes vs HEAD, including untracked files                                                                                                          |
| `cold (~$0.46)`   | only while the prompt cache is cold (see below)                                                                                                                  |
| `󰫣 3`             | [pi-herd](../pi-herd/README.md) agents this session watches (the glyph in the icon color); click it for the agents tab                                           |
| `󰦖 2`             | [pi-bash-bg](../pi-bash-bg/README.md) jobs running in this session (the glyph in the icon color); click it for the jobs tab                                      |
| `󰪟 47k/200k`      | context used / window, hidden at 0; the pie fills in eighths, yellow above 75%, red above 90%; `~` marks an estimate until the first response after a compaction |
| `opus-5.5 · high` | model and thinking level                                                                                                                                         |

Tokens, cost and cache timing are in the dashboard's `usage` tab. Clicking a piece (fullscreen TUI mode) opens the dashboard at its tab: folder and git → `git`, cold and context → `usage`, agents → `agents`, jobs → `jobs`, model and effort → `session`. The rest of the line does nothing; clicking the prompt's text closes the dashboard.

**Cache:** once the prompt cache expires, you switch models, or the session is compacted, `cold` shows in yellow: the next message re-bills the full context, and `(~$0.46)` estimates what that costs (when the model has pricing). The lifetime comes from the model (`promptCache`, honoring `PI_CACHE_RETENTION=long`), else pi's 5-minute default; refreshes from pi's `cacheWarming` setting extend it.

On narrow terminals git drops first, then the context. Folder, cold, agents, jobs and model always stay. Statuses from other extensions appear right-aligned on their own line below. Yellow and red use the theme's `warning` and `error` colors.

## Dashboard

Press ↓ at the end of the prompt (a first ↓ moves the cursor there) to open the dashboard and move the keys to it; ↑ (at the top) or Esc closes it and gives the keys back. Typing also gives them back (and closes a dashboard that ↓ opened). The prompt's cursor disappears while the dashboard has the keys. To keep it open while you type, click a footer piece or run `/footer [tab]` (`/footer` alone closes an open dashboard); clicking the prompt's text closes it.

It has tabs, like Claude Code's dialogs: ←/→ or a click switches them, and the active tab is bold (with a background while the dashboard has the keys). ↓ and `/footer` open on the agents tab while watches run, the jobs tab while jobs run, else on the last tab you used. The dashboard keeps the height of its tallest tab, so switching tabs doesn't move anything.

```
   overview  session  usage  git  jobs   ←→ switch · ↑ close

   repo       pi-hkandala · master → origin/master · 7 files · +42 -7
   model      anthropic/claude-opus-5-5 · thinking high · 47k / 200k (23%)
   usage      ↑116 ↓29.6k · $1.24 total · 99% last hit · expires in 4m
   session    12 user · 51 assistant · 87 tool calls · 42m working
```

| Tab        | Shows                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overview` | one line per area (above); the cost is the total, with the agents this session started                                                                                                                      |
| `session`  | model, messages, times, and speed (`n/a` before the first reply)                                                                                                                                            |
| `usage`    | after the first response: context, tokens, cost (below), and cache (with the next message's cost)                                                                                                           |
| `git`      | only in a git repo: the repo URL with the folder (`https://github.com/you/repo (~/code/repo)`), worktrees, branch and sync, last commit, and changes: `7 files · 2 created, 4 modified, 1 deleted · +42 -7` |
| `jobs`     | with [pi-bash-bg](../pi-bash-bg/README.md), once this session has background jobs (below)                                                                                                                   |
| `agents`   | with [pi-herd](../pi-herd/README.md), once this session has started or watched agents (below); always the last tab                                                                                          |

**Cost** (the `usage` tab): `$4.10 total · $1.24 session · $2.86 subagents (5) · $0.31 last turn`. The total adds this session's cost to what every agent it started cost (at any depth, ended ones too; not agents it only watched); with no such agents it is just `total` and the turn. A turn runs from a user message, or from an agent's or job's message that woke the idle agent.

**Agents** (with pi-herd): the footer line shows `󰫣 3` before the jobs count while this session watches agents; it never drops on narrow terminals, and a click on it opens the agents tab. The tab (labeled with how many agents this session waits on, `agents 2`) lists the live agents this session started and the ones it has watched (`e` shows or hides the ones that ended): working ones first, then other live ones, then ended ones, each group in the order its agents entered it (a newcomer goes last). Each row shows, in aligned columns, the name with how many live agents run below it (dim, `reviewer +2`) and its dim markers (`󱖡` an agent this session didn't start, `󰅐` while this session waits on it), status, folder, messages sent `󱉱` and received `󱉰`, and time (last: it grows). Widths come from every row `e` can show, so toggling it doesn't move the columns. Only `working` and `blocked` are colored. 3 rows at a time, always 3 rows tall (when none run: `no running agents`, with `e show ended (2)` on the hint line at the bottom): ↑/↓ select, Enter opens the agent in a herdr popup (inside a popup: replaces what it shows), `x` twice stops an agent this session started, `e` shows or hides ended ones. A click selects an agent, and a click on the selected agent opens it. pi-herd's full dashboard opens with ← on an empty prompt.

```
   overview  session  usage  git  agents 2   ←→ switch · ↑ close

   ▸ reviewer +2 󰅐     working  ~/code/app  󱉱 1 󱉰 0  2m
     frog-thunder 󱖡 󰅐  working  ~/code/lib  󱉱 1 󱉰 0  3m
     docs              idle     ~/code/app  󱉱 1 󱉰 1  1m

   ↑↓ select · enter view · x stop
```

**Jobs** (with pi-bash-bg): the footer line shows `󰦖 2` on its right, before the context, while this session has background jobs running; it never drops on narrow terminals, and a click on it opens the jobs tab. The tab (`jobs 1`: the running count) shows the running jobs (`e` shows or hides finished ones), 3 at a time and always 3 rows tall (when none run: `no running jobs`, with `e show ended (2)` on the hint line at the bottom), running ones by start time, then finished ones by end time: ↑/↓ select, Enter opens the job's log viewer, `x` twice kills a running one. A click selects a job, and a click on the selected job opens its log.

```
   overview  session  usage  git  jobs 1   ←→ switch · ↑ close

   ▸ 48213  running  4m      npm run dev                               ~/proj

   ↑↓ select · enter logs · x kill · e show ended (2)
```

Speed counts from each response's first token (skipping streams under a second: output arrives in bursts, so a short reply can land in one chunk), and `ttft` is the time from sending the request to that first token; both cover only responses streamed since pi started (first-token times aren't saved in the session).

The time row shows the last turn's length (a user message to its reply's end) or, while a turn runs, its time so far (`… this turn`).

Git info refreshes one second after tool calls, `!` commands, agent runs, and branch changes, plus on a poll; `git fetch` runs on its own poll (and at start when the last fetch is older than that). Git only runs in trusted projects, with fsmonitor off, and fetch never prompts for credentials. Remote URLs are shown without any embedded credentials.

Icons are Nerd Font glyphs (built into Ghostty; otherwise use a Nerd Font).

## Install

```bash
pi install npm:@hkandala/pi-footer
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-footer`.

## Configuration

Optional file: `~/.pi/agent/extensions/pi-footer.json`

```json
{
  "promptEditor": "box",
  "disableEffortColors": true,
  "style": "color",
  "iconColor": "accent",
  "gitStatusPollMins": 0.5,
  "gitFetchPollMins": 30
}
```

| Key                   | Values                          | Default    | Notes                                                                                                                                                            |
| --------------------- | ------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptEditor`        | `"box"`, `"default"`            | `"box"`    | `default` keeps pi's editor with the footer below it                                                                                                             |
| `disableEffortColors` | `true`, `false`                 | `true`     | keep the prompt border gray (theme `muted`) and the footer's thinking level in `text`, instead of pi's thinking-level colors (bash mode still colors the border) |
| `style`               | `"color"`, `"white"`            | `"color"`  | `white` draws everything in the theme's text color                                                                                                               |
| `iconColor`           | theme color name or `"#rrggbb"` | `"accent"` | color of the folder, repo, and branch icons; e.g. `"border"`, `"mdHeading"`, `"#F05032"`                                                                         |
| `gitStatusPollMins`   | minutes                         | `0.5`      | line-change poll; `0` disables                                                                                                                                   |
| `gitFetchPollMins`    | minutes                         | `30`       | `git fetch` poll; `0` disables                                                                                                                                   |
