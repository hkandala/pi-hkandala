---
name: oriel
description: |
  Drive Oriel, the macOS app that shows herdr panes as cards, from your herdr pane: open a browser page, a
  file, a folder, a Git diff or any plugin card beside you, float a pane in its own window, point the user at
  a pane, send a Mac notification, copy to the Mac's clipboard, start an agent with Oriel's chat view, or list,
  make and reload Oriel plugins. Use it to show the user something (a report, a dev server, a diff) without
  asking them to open it, or to learn whether Oriel shows your pane. Needs herdr ($HERDR_PANE_ID is set).
  Works on This Mac and on the remote machines that Oriel connects to.
---

# Oriel

Oriel is a macOS app for herdr. It shows each herdr pane as a card: a terminal, an agent, a browser page, or
a plugin card (a file, a folder, a Git diff). Oriel runs on the user's Mac. Your pane is on that Mac or on a
remote machine that Oriel connects to.

Oriel's command is `~/.cache/oriel/bin/oriel`. Oriel writes it on each machine where it opens a session. It
is not on `PATH`, so run it by its full path. In these files, `oriel` means that path.

## Does Oriel show me?

```sh
~/.cache/oriel/bin/oriel status
```

- `Shown in Oriel`: a person sees your pane now.
- `Open in Oriel, not shown`: an Oriel follows your session, but your pane is out of view. Commands work.
- `Not in Oriel` (exit 3), or no file at that path: no Oriel follows your session. Use herdr alone, and tell
  the user where to look.

## The commands you use most

```sh
oriel open browser ./report.html          # a page in a browser card, beside you (cards.md)
oriel float w1:p3                         # a pane in its own window
oriel reveal w1:p3                        # points the user at a pane: a flash, or a notice with Show
oriel notify "Tests pass" "412 passed"    # a Mac notification. A click shows your pane
git diff | oriel copy                     # the Mac's clipboard, at most 1 MiB
```

- `oriel help` and `oriel help <command>` print the exact syntax of the Oriel that answers. If they differ
  from these files, trust them.
- Add `--json` to any command for one JSON value, also for an error: `{"error":{"code":…,"message":…}}`.
- `--pane <id>` (ask from another pane of your session) and `--timeout <seconds>` go before the command:
  `oriel --timeout 60 open …`. After the command, an option belongs to that command.
- A pane is `w1:p3` in your session, or `<session>/<pane>` of another session on your machine.
- Exit codes: 0 done, 1 failed (the message says why), 2 usage, 3 no Oriel took the request, 4 no answer in
  time (10 seconds by default), 5 not in a herdr pane, or herdr does not know your own pane.
- If herdr does not know your own pane (exit 5), herdr gave it a new id after a move. Find its current id
  with herdr (the herdr skill) and pass `--pane <id>`.

## Rules

- Oriel never moves the user's view for you. A card goes beside you, or in a tab the user does not see with
  a notice that offers Show. Do not call herdr's focus commands: they move the user's view.
- Put no secrets in an argument (no `?token=`). Every device that follows the session sees it.
- `notify` sends at most one notification per pane every 10 seconds (`rate_limited`). It answers
  `"notified": false` when the user turned off Oriel ▸ Notifications ▸ From Agents. A click on it brings Oriel to
  the front and shows your pane, or the pane of `oriel notify <title> [<body>] --pane <pane>`.

## When you need more

- [cards.md](cards.md): `open` in each place, reuse, replace, browser addresses, `float`, `card`, `shown`.
- [plugins.md](plugins.md): list, make, reload and install plugins.
- [agents.md](agents.md): start an agent with the chat view, relaunch an agent with chat.
- [remote.md](remote.md): what is different on a remote machine.
- Every command, option and answer: https://oriel-docs.vercel.app/docs/agent-control/cli
- herdr (tabs, splits, terminals, running a command, reading output, agent status): the herdr skill. Run
  `herdr --skill` to print it.
