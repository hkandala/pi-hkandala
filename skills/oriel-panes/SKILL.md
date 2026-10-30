---
name: oriel-panes
description: |
  Open a pane next to your own herdr pane, as any kind of card the Oriel app shows: a terminal (with or without a
  command), a coding agent (Claude Code, Codex, pi, OpenCode), a browser page (an HTML report, a dev server, docs),
  or a file, preview, markdown, diff or file-tree card. Use it to show the user
  something without asking them to open it. Needs herdr ($HERDR_PANE_ID is set). Works on This Mac and on the
  remote machines Oriel connects to.
---

# Oriel panes

Oriel is a macOS app for herdr. It shows each herdr pane as a card, and the pane decides the card's kind:

- A pane with the label `oriel:<kind>#<iid> <arg>` is a browser card or a plugin card. A label is herdr's name
  for a pane.
- A pane where herdr detects an agent is an agent card.
- Every other pane is a terminal card.

herdr's own TUI shows each pane as a plain pane, with its label in the border. Run the commands below on the
machine where you run. herdr sets `$HERDR_SESSION` and `$HERDR_PANE_ID` in each of its panes. Do not call
herdr's focus commands: they take the keyboard from the user.

## Make a pane beside you

Each kind starts with this split of your pane. `--no-focus` leaves the keyboard where it is.

```sh
pane=$(herdr --session "$HERDR_SESSION" pane split "$HERDR_PANE_ID" --direction right --no-focus \
  | sed -E 's/.*"pane_id":"([^"]+)".*/\1/')
```

Use `--direction down` to put it below you. Add `--cwd /some/folder` to start its shell in another folder. To
close it, run `herdr --session "$HERDR_SESSION" pane close "$pane"`.

## Terminal

The new pane is a terminal with a shell. To run a command, type it into the shell:

```sh
herdr --session "$HERDR_SESSION" pane run "$pane" "npm run dev"
```

## Agent

Oriel's New Pane chooser starts an agent: it types the agent's command and Return into the pane's shell. Do the
same with `claude`, `codex`, `pi` or `opencode`:

```sh
herdr --session "$HERDR_SESSION" pane run "$pane" claude
```

The card becomes an agent card when herdr detects the agent, a few seconds later. Then
`herdr --session "$HERDR_SESSION" pane get "$pane"` shows `"agent":"claude"`.

The chat view (Oriel's chat window over the agent) needs launch flags that Oriel makes for each launch. Do not
copy them. Your agent starts in its terminal view. When herdr knows the agent's session, the card shows a
Relaunch with Chat button. The user clicks it, and the agent starts again with chat, in the same session.

## Browser and plugin cards

A label makes the new pane a browser card or a plugin card. Run these three steps after the split:

```sh
# 1. An instance id (iid): 6 random [a-z0-9] that no pane of the session has.
while iid=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 6)
  herdr --session "$HERDR_SESSION" pane list | grep -q "#$iid"; do :; done
# 2. The label.
herdr --session "$HERDR_SESSION" pane rename "$pane" "oriel:browser#$iid http://localhost:3000"
# 3. Tell Oriel to read the layout again: herdr sends no event for a rename, but it sends one for this token.
herdr --session "$HERDR_SESSION" pane report-metadata "$pane" --source oriel-panes --token oriel-label=1 --ttl-ms 1000
```

| Kind | Argument | Example label |
|---|---|---|
| `browser` | a web address | `oriel:browser#k3x9q2 http://localhost:3000` |
| `file` | a file's absolute path, in a text editor | `oriel:file#a1b2c3 /repo/src/main.ts` |
| `preview` | a file's absolute path: image, PDF, audio or video | `oriel:preview#d4e5f6 /repo/logo.png` |
| `markdown` | a Markdown file's absolute path, to read and edit | `oriel:markdown#g7h8i9 /repo/README.md` |
| `diff` | a repository's root, a space, then `uncommitted` or a commit hash | `oriel:diff#j1k2l3 /repo uncommitted` |
| `files` | a folder, as a file tree with git | `oriel:files#m4n5o6 /repo` |

Oriel builds from `main` show the five plugin kinds. Older builds show such a pane as a terminal card.

Optional: for herdr TUI users, draw the kind, the argument and "Shown in Oriel" in the pane, and make it ignore
keys. Use the `placeholder.sh` next to this file, by its absolute path:

```sh
herdr --session "$HERDR_SESSION" pane run "$pane" "exec sh '/path/to/oriel-panes/placeholder.sh' Browser 'http://localhost:3000'"
```

The argument goes inside single quotes there. In an address, write a `'` as `%27`.

### Change what a card shows

Rename the same pane with the same iid and a new argument, then run step 3 again. A browser card loads the new
page as a new entry in its history, so Back returns to the old page. A plugin card loads again with the new
argument.

```sh
herdr --session "$HERDR_SESSION" pane rename "$pane" "oriel:browser#$iid http://localhost:3000/settings"
herdr --session "$HERDR_SESSION" pane report-metadata "$pane" --source oriel-panes --token oriel-label=1 --ttl-ms 1000
```

If you lost the pane id or the iid, run `herdr --session "$HERDR_SESSION" pane list`. It shows each pane's
`pane_id` and `label`. The iid is the 6 characters after the `#`.

### Label rules

- Write one space between the iid and the argument. Oriel reads the card from the label alone, so a pane made
  by Oriel, by you or by the TUI is the same.
- The iid is exactly 6 characters of `[a-z0-9]`, and no other pane of the session uses it. Do not change it. A
  browser card keeps its state in `~/.local/state/oriel/<session>/browser/<iid>.json`. A plugin card keeps
  none: the label is its whole state.
- The argument has at most 1024 characters and no line breaks. Otherwise Oriel shows no card.
- Put no secrets in a label (no `?token=`). Every device and the TUI see it.
- A browser address starts with `http://` or `https://`. A bare `localhost:3000` gets `http://`. `localhost`
  is the pane's machine, also on a remote machine. `file://` pages open only on This Mac (the Mac that runs
  Oriel). On a remote machine, serve the file (`python3 -m http.server 8000`) and open
  `http://localhost:8000/report.html`.
- Oriel opens `localhost`, `127.0.0.1` and This Mac's files at once. Another site in a label waits until the
  user clicks Open the first time.
- The placeholder keeps the argument it started with. The label in the TUI border shows the current one.
