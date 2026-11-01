# Remote machines

Your pane can be on a remote machine that Oriel connects to over SSH. The command, its files and herdr are
all on your machine, and the command works the same as on Oriel's Mac.

- `oriel status --json` says `"remote": true`. Your own `pbcopy` does not reach the user's Mac, so use
  `oriel copy`.
- Paths are your machine's. `oriel open ./notes.md` opens your file.
- `localhost` in a browser card is your machine. A `file://` address does not open (cards.md, Browser
  addresses).
- `plugins new`, `reload` and `install` answer `other_machine`: plugins live on the Mac. `oriel plugins` and
  `oriel open <plugin>` work. To read a card's error, run `oriel card <pane> --json`.
- A pane argument always names a pane on your machine.
- If the SSH link drops (sleep, a network change), Oriel takes no requests until it connects again (exit 3).
  Try again later, or tell the user.
