---
name: oriel-panes
description: |
  Open a browser pane next to your own herdr pane, which the Oriel app shows as a web page. Use it to show the
  user an HTML report you wrote, a dev server you started (http://localhost:3000), or docs, without asking them
  to open a browser. Needs herdr ($HERDR_PANE_ID is set). Works on This Mac and on the remote machines Oriel
  connects to (a remote machine's `localhost` pages come with a later Oriel version).
---

# Oriel panes

Oriel is a macOS app for herdr. A herdr pane whose label is `oriel:browser#<iid> <url>` shows in Oriel as a
browser card with that address. herdr's own TUI shows it as a plain pane with the label in its border.

## Open a browser pane beside you

Run these four steps. They split your pane to the right, without taking the keyboard from you.

```sh
# 1. An instance id: 6 random [a-z0-9] that no pane of the session has.
while iid=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 6); herdr pane list | grep -q "#$iid"; do :; done
# 2. A new pane to the right of yours; its id.
pane=$(herdr pane split "$HERDR_PANE_ID" --direction right --no-focus | sed -E 's/.*"pane_id":"([^"]+)".*/\1/')
# 3. The label makes it a browser pane.
herdr pane rename "$pane" "oriel:browser#$iid http://localhost:3000"
# 4. Tell Oriel to read the layout again: herdr sends no event for a rename.
echo '{"id":"1","method":"pane.report_metadata","params":{"pane_id":"'"$pane"'","source":"oriel-panes","tokens":{"oriel-label":"1"},"ttl_ms":1000}}' | herdr remote-api-bridge >/dev/null
```

Optional: draw "Browser", the address and "Shown in Oriel" in the pane for herdr TUI users, and make it ignore
keys. Use the `placeholder.sh` next to this file (its absolute path):

```sh
herdr pane run "$pane" "exec sh '/path/to/oriel-panes/placeholder.sh' Browser 'http://localhost:3000'"
```

The address goes inside single quotes there: write a `'` in it as `%27`.

To close it: `herdr pane close "$pane"`.

## Change the address

Rename the same pane with the same iid and the new address, then run step 4 again. The card loads the new page
as a new entry of its history (Back returns to the old one), and asks the user first unless its site is allowed
(see Approval below).

```sh
herdr pane rename "$pane" "oriel:browser#$iid http://localhost:3000/settings"
echo '{"id":"1","method":"pane.report_metadata","params":{"pane_id":"'"$pane"'","source":"oriel-panes","tokens":{"oriel-label":"1"},"ttl_ms":1000}}' | herdr remote-api-bridge >/dev/null
```

Lost the pane id or the iid? `herdr pane list` shows every pane with its `pane_id` and `label`; the iid is the 6
characters after `oriel:browser#`. `herdr pane get "$pane"` shows one pane.

## The rules

- **Label:** `oriel:browser#<iid> <url>`, one space between the id and the address. Oriel reads the pane from
  the label alone; a pane made by Oriel, by you or by the TUI is the same.
- **iid:** exactly 6 characters of `[a-z0-9]`, not used by another pane of the session. It names the pane's
  state file (`~/.local/state/oriel/<session>/browser/<iid>.json`, which Oriel writes). Never change it.
- **Address:** `http://` or `https://`; a bare `localhost:3000` gets `http://`. At most 1024 characters, no
  line breaks. `localhost` means the pane's machine. `file://` pages open only on This Mac (the Mac that runs
  Oriel); on a remote machine, serve the file instead (`python3 -m http.server 8000`) and open
  `http://localhost:8000/report.html`.
- **No secrets** in the address (no `?token=`): every device and the TUI see the label.
- **Approval:** Oriel opens `localhost`, `127.0.0.1` and This Mac's files at once. Another site that you put in
  a label waits for the user to click Open the first time.
- The placeholder keeps the address it started with; the label (the TUI border) shows the current one.
