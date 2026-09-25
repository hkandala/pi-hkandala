# pi-footer

A minimal one-line footer for pi, inside a rounded prompt box, that expands into a dashboard.

```
╭── ⠋ Working ─────────────────────────────────────────────────────────────────────────────────────────╮
│ fix the footer so the cache goes cold after compaction                                               │
│                                                                                                      │
│  pi-hkandala · 󰘬 master 󰁝2 󰁅1 · +42 -7   ↑116 ↓29.6k (99% · 4m) · $1.24 · 󰪟 47k/200k · opus-5.5 · high │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

The box is pi's own editor (same keys, spinner, and autocomplete) drawn with rounded borders and the footer as its last row. Set `"promptEditor": "default"` to keep pi's editor and show the footer below it. The box replaces pi's editor, so it doesn't combine with other extensions that replace the editor (e.g. vim mode).

| Piece                    | Shows                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| folder                   | folder pi runs in                                                                                                                                                |
| 󰊢 / 󰙅 repo               | repo name, when it differs from the folder (󰊢) or you are in a linked worktree (󰙅)                                                                               |
| 󰘬 branch `󰁝2 󰁅1`         | git branch, commits to push / pull                                                                                                                               |
| `+42 -7`                 | pending line changes vs HEAD, including untracked files                                                                                                          |
| `↑116 ↓29.6k (99% · 4m)` | session input / output tokens, cache hit rate and time left (see below)                                                                                          |
| `$1.24`                  | session cost, hidden at $0                                                                                                                                       |
| `󰪟 47k/200k`             | context used / window, hidden at 0; the pie fills in eighths, yellow above 75%, red above 90%; `~` marks an estimate until the first response after a compaction |
| `opus-5.5 · high`        | model and thinking level                                                                                                                                         |

**Cache:** `(99% · 4m)` is the last response's cache hit rate (yellow below 90%) and the time until the prompt cache expires. Once it expires, you switch models, or the session is compacted, it shows `(cold · ~$0.46)` with `cold` in yellow: the next message re-bills the full context (the estimate appears when the model has pricing). The lifetime comes from the model (`promptCache`, honoring `PI_CACHE_RETENTION=long`), else pi's 5-minute default; refreshes from pi's `cacheWarming` setting extend it.

On narrow terminals whole sections drop in this order: usage, cost, git, context. Folder and model always stay. Statuses from other extensions appear right-aligned on their own line below. Yellow and red use the theme's `warning` and `error` colors.

## Dashboard

Click the footer (fullscreen TUI mode) or run `/dashboard` to expand or collapse it. It opens below the box:

```
  path       ~/code/pi-hkandala
  repo       https://github.com/hkandala/pi-hkandala
  worktree   pi-hkandala (main) · 1 other: fix-footer
  branch     master → origin/master · 2 to push · fetched 12m ago
  commit     8252543 pi-header: toggle logo color on click… · 3 hours ago
  changes    7 files · +42 -7
             M  extensions/pi-footer/index.ts   +30 -5
             …
             +2 more

  model      anthropic/claude-opus-5-5 · thinking high
  context    47k / 200k (23%) · compacted 2×
  tokens     ↑116 input · ↓29.6k output · cache 2.7M read, 249k write · $1.24
  cache      99% last hit · expires in 4m · next message ~$0.05
  speed      58 t/s last · 61 t/s avg

  session    fix footer · 12 user · 51 assistant · 87 tool calls
  time       42m working · 2h 10m since start
```

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

| Key                   | Values                          | Default    | Notes                                                                                                         |
| --------------------- | ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `promptEditor`        | `"box"`, `"default"`            | `"box"`    | `default` keeps pi's editor with the footer below it                                                          |
| `disableEffortColors` | `true`, `false`                 | `true`     | keep the prompt border gray (theme `muted`) instead of pi's thinking-level colors (bash mode still colors it) |
| `style`               | `"color"`, `"white"`            | `"color"`  | `white` draws everything in the theme's text color                                                            |
| `iconColor`           | theme color name or `"#rrggbb"` | `"accent"` | color of the folder, repo, and branch icons; e.g. `"border"`, `"mdHeading"`, `"#F05032"`                      |
| `gitStatusPollMins`   | minutes                         | `0.5`      | line-change poll; `0` disables                                                                                |
| `gitFetchPollMins`    | minutes                         | `30`       | `git fetch` poll; `0` disables                                                                                |
