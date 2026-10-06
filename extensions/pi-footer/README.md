# pi-footer

A minimal one-line footer for pi, inside a rounded prompt box, that expands into a dashboard.

```
╭─── ⠋ Working ────────────────────────────────────────────────────────────────────────────────────────╮
│ fix the footer so the cache goes cold after compaction                                               │
│                                                                                                      │
│ 󰉋 pi-hkandala · 󰘬 master 󰁝2 󰁅1 · +42 -7     cold (~$0.46) · 󰫣 3 · 󰦖 2 · 󰪟 47k/200k · opus-5.5 · high │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

The box is pi's own editor, with the same keys, spinner, and autocomplete. The footer adds rounded borders and puts the footer line in the box's last row. The box is set in one column on each side, so your text lines up with the transcript's (as in [pi-content-layout](../pi-content-layout/README.md)).

- A named session (`/name`) shows its name at the right end of the top border, when pi's label on the left leaves room.
- With pi-herd, an agent in a herdr popup shows `ctrl+b q or /detach to close` as the empty prompt's dim placeholder.
- To keep pi's editor and show the footer below it, set `"promptEditor": "default"`.
- The box replaces pi's editor. It does not work together with other extensions that replace the editor (for example, vim mode).

| Piece             | Shows                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 󰉋 folder          | the folder pi runs in                                                                                                                                                                       |
| 󰊢 / 󰙅 repo        | the repo name, when it differs from the folder (󰊢) or when you are in a linked worktree (󰙅)                                                                                                 |
| 󰘬 branch `󰁝2 󰁅1`  | the git branch, and the commits to push and to pull                                                                                                                                         |
| `+42 -7`          | the line changes against HEAD, untracked files included                                                                                                                                     |
| `cold (~$0.46)`   | only while the prompt cache is cold (see [Prompt cache](#prompt-cache))                                                                                                                     |
| `󰫣 3`             | with [pi-herd](../pi-herd/README.md): the agents this session waits on                                                                                                                      |
| `󰦖 2`             | with [pi-bash-bg](../pi-bash-bg/README.md): the background jobs that run in this session                                                                                                    |
| `󰪟 47k/200k`      | the context used and the context window, hidden at 0. The pie fills in eighths. It is yellow above 75% and red above 90%. `~` marks an estimate after a compaction, until the next response |
| `opus-5.5 · high` | the model and the thinking level. With a virtual model, the model that answered last follows, as in pi's footer: `auto · high → gpt-x · medium`                                             |

The icons use the icon color (see `iconColor`). Yellow and red are the theme's `warning` and `error` colors. The dashboard's `usage` tab shows the tokens, the cost, and the cache timing.

If the terminal is narrow, the git piece goes first, then the context. The folder, cold, agents, jobs, and model pieces always stay. Statuses from other extensions show right-aligned on their own line below the footer line.

In fullscreen mode (pi's default since 1.0; make sure `"tuiMode"` isn't `"regular"`), a click on a piece opens the dashboard at its tab:

- Folder and git open `git` (in a git repo).
- Cold and context open `usage`.
- Agents open `agents`, and jobs open `jobs`.
- Model and thinking level open `session`.

A click on the rest of the line does nothing.

### Prompt cache

`cold` shows in yellow when the prompt cache expired, when you switched models, or when the session was compacted. The next message then bills the full context again. `(~$0.46)` estimates what that message costs more than with a warm cache. It shows only when the model has pricing and the amount is $0.01 or more.

The cache lifetime comes from the model's `promptCache` (`PI_CACHE_RETENTION=long` picks the long lifetime). If the model has no `promptCache`, the footer assumes 5 minutes. pi itself tracks no lifetime for such a model. Refreshes from pi's `cacheWarming` setting extend the lifetime.

With a virtual model, the lifetime, the pricing, and the model switch check use the model that answered last.

## Dashboard

To open the dashboard, press ↓ at the end of the prompt. A first ↓ moves the cursor to the end. The dashboard then has the keys. With the box editor, the prompt's cursor disappears while the dashboard has the keys.

| Key             | Does                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ↓               | at the end of the prompt: opens the dashboard, or gives the keys back to an open one. In a list: selects the next row               |
| ↑               | in a list: selects the row above. At the top row, or on a tab with no list: closes the dashboard                                    |
| Esc             | closes the dashboard                                                                                                                |
| ← / →           | switches tabs                                                                                                                       |
| Enter           | on the agents tab: opens the agent. On the jobs tab: opens the job's log viewer. Enter never sends the prompt from the dashboard    |
| `x` twice       | on the agents tab: stops an agent that this session started. On the jobs tab: kills a running job                                   |
| `e`             | on the agents or jobs tab: shows or hides the ended rows                                                                            |
| any other key   | goes to the prompt, and the prompt gets the keys back. If ↓ opened the dashboard, the dashboard also closes                         |
| `/footer [tab]` | opens the dashboard at that tab, or at the tab that ↓ picks. It stays open while you type. `/footer` alone closes an open dashboard |

In fullscreen mode, you can also click:

- A footer piece opens its tab, and the dashboard stays open while you type.
- A tab switches to it.
- A row selects it. A click on the selected row opens it, as Enter does.
- With the box editor, a click on the prompt's text closes the dashboard.

The tabs work like Claude Code's dialogs. The active tab is bold, with a background while the dashboard has the keys. ↓ and `/footer` open on the agents tab while this session waits on agents, and on the jobs tab while jobs run. Otherwise they open on the last tab you used. The dashboard keeps the height of its tallest tab, so a switch of tabs does not move anything.

```
   overview  session  usage  git  jobs   ←→ switch · ↑ close
  ──────────────────────────────────────────────────────────
   repo       pi-hkandala · master → origin/master · 7 files · +42 -7
   model      anthropic/claude-opus-5-5 · thinking high · 47k / 200k (23%)
   usage      ↑116 ↓29.6k · $1.24 total · 99% last hit · expires in 4m
   session    12 user · 51 assistant · 87 tool calls · 42m working
```

| Tab        | Shows                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overview` | one line per area (above). The cost is the total, with the agents that this session started                                                                                                                                     |
| `session`  | the model, the messages, the times, and the speed. The speed is `n/a` until a reply streams in this pi run                                                                                                                      |
| `usage`    | after the first response: the context, the tokens, the cost (below), and the cache, with the cost of the next message                                                                                                           |
| `git`      | only in a git repo: the repo URL with the folder (`https://github.com/you/repo (~/code/repo)`), the worktrees, the branch and its sync, the last commit, and the changes: `7 files · 2 created, 4 modified, 1 deleted · +42 -7` |
| `jobs`     | with [pi-bash-bg](../pi-bash-bg/README.md), once this session has background jobs (below)                                                                                                                                       |
| `agents`   | with [pi-herd](../pi-herd/README.md), once this session started or watched agents (below). It is always the last tab                                                                                                            |

### Cost

The `usage` tab shows the cost like this: `$4.10 total · $1.24 session · $2.86 subagents (5) · $0.31 last turn`.

- The total adds this session's cost to the cost of every agent that it started. That includes agents at any depth and agents that ended. It does not include agents that this session only watched.
- The session's cost includes the requests that write compaction and branch summaries, as in pi's footer.
- If the session started no agents, the line shows only the total and the turn.
- A turn starts at a user message, or at a message from an agent or a job that woke the idle agent.

### Agents tab

This tab needs pi-herd. It lists the live agents that this session started and the agents that it watched. `e` shows or hides the agents that ended.

- The footer line shows `󰫣 3` before the jobs count while this session waits on agents. The tab label shows the same count: `agents 2`.
- The order is: working agents, then the other live agents, then the ended agents. In each group, the agents are in the order they joined it, so a newcomer goes last.
- Each row has aligned columns: the name, the status, the folder, the messages sent (`󱉱`) and received (`󱉰`), and the time. The time is last, because it grows.
- After the name, a dim `+2` counts the live agents that run below it. A dim `󱖡` marks an agent that this session did not start. A dim `󰅐` shows while this session waits on the agent.
- The column widths come from every row that `e` can show, so `e` does not move the columns. Only `working` and `blocked` have a color.
- The list shows 3 rows at a time and is always 3 rows tall. If no agents run, it shows `no running agents`, and the hint line at the bottom shows `e show ended (2)`.
- Enter opens the agent. An agent in your own herdr session doesn't open in a popup: herdr shows its pane (it switches to its workspace and tab), and the dashboard closes. An agent in the `pi-herd` session opens in a herdr popup. Inside a popup, Enter replaces what the popup shows. The popup needs the repo's herdr plugin (`herdr/plugin`, see the [pi-herd README](../pi-herd/README.md)). Without the plugin, pi-herd shows how to install it and how to attach in a terminal.

pi-herd's full dashboard opens with ← on an empty prompt.

```
   overview  session  usage  git  agents 2   ←→ switch · ↑ close
  ──────────────────────────────────────────────────────────────
   ▸ reviewer +2 󰅐     working  ~/code/app  󱉱 1 󱉰 0  2m
     frog-thunder 󱖡 󰅐  working  ~/code/lib  󱉱 1 󱉰 1  3m
     docs              idle     ~/code/app  󱉱 1 󱉰 1  1m

   ↑↓ select · enter view · x stop
```

### Jobs tab

This tab needs pi-bash-bg. It lists the background jobs that run in this session. `e` shows or hides the jobs that finished.

- The footer line shows `󰦖 2` on its right, before the context, while jobs run. The tab label shows the count of running jobs: `jobs 1`.
- The running jobs come first, by start time, then the finished jobs, by end time.
- Each row shows the pid, the state, the command, the folder, and the time.
- The list shows 3 rows at a time and is always 3 rows tall. If no jobs run, it shows `no running jobs`, and the hint line at the bottom shows `e show ended (2)`.

```
   overview  session  usage  git  jobs 1   ←→ switch · ↑ close
  ────────────────────────────────────────────────────────────
   ▸ 48213  running  npm run dev                               ~/proj  4m

   ↑↓ select · enter logs · x kill · e show ended (2)
```

### Speed and time

The speed counts from the first token of each response. Streams under one second do not count, because output arrives in bursts and a short reply can arrive in one chunk. `ttft` is the time from the request to the first token. Both cover only the responses streamed since pi started or since the last `/reload`, because pi does not save first-token times in the session.

The time row shows the length of the last turn (see [Cost](#cost) for when a turn starts). While a turn runs, it shows the time so far: `… this turn`.

### Git

The git info refreshes at start, after `!` commands, after agent runs, and after branch changes. During a run, `bash`, `edit`, and `write` calls refresh it at most once every 30 seconds. When you type or press a key, it refreshes if it is older than 30 seconds, so edits made outside pi show too. Nothing runs on a timer: an agent that nobody uses runs no git.

`git fetch` runs only when you type or press a key, and only if the last fetch is older than `gitFetchPollMins`.

- Git runs only in trusted projects, with fsmonitor off.
- The fetch never asks for credentials. It adds `BatchMode=yes` to your own ssh command.
- Remote URLs show without the credentials in them.

## Works with

pi-footer works on its own. These features need another extension, and without it they do not show:

- [pi-herd](../pi-herd/README.md): the `󰫣 3` piece, the agents tab, the cost of started agents in the total, and the popup placeholder. The popup also needs the repo's herdr plugin.
- [pi-bash-bg](../pi-bash-bg/README.md): the `󰦖 2` piece and the jobs tab.

The icons are Nerd Font glyphs. Ghostty has them built in. In other terminals, use a Nerd Font.

pi draws its own footer and editor for a moment before pi-footer's replace them. Install [pi-no-flash](../pi-no-flash/README.md) to start with pi-footer's in the first frame.

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
  "gitFetchPollMins": 30
}
```

| Key                   | Values                          | Default    | Notes                                                                                                                                                                                 |
| --------------------- | ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptEditor`        | `"box"`, `"default"`            | `"box"`    | `default` keeps pi's editor, with the footer below it                                                                                                                                 |
| `disableEffortColors` | `true`, `false`                 | `true`     | keeps the prompt border gray (theme `muted`) and the footer's thinking level in `text`, instead of pi's thinking-level colors. In bash mode, the border still has the bash-mode color |
| `style`               | `"color"`, `"white"`            | `"color"`  | `white` draws the footer and the dashboard text in the theme's text color. The box border and the active tab's background keep their colors                                           |
| `iconColor`           | theme color name or `"#rrggbb"` | `"accent"` | the color of the folder, repo, branch, agents, and jobs icons. For example: `"border"`, `"mdHeading"`, `"#F05032"`                                                                    |
| `gitFetchPollMins`    | minutes                         | `30`       | the least time between two `git fetch` runs. `0` turns fetch off                                                                                                                      |
