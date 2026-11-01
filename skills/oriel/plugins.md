# Plugins

A plugin is a package that adds a kind of card to Oriel. The kinds that come with Oriel are `browser`,
`explorer` (File Explorer) and `git`.

```sh
oriel plugins --json                      # id, name, opens, source, version, or the error of one that did not load
oriel plugins --for ./data.csv            # only the plugins that open it, the default first
```

## Make a plugin

This works only from a pane on Oriel's Mac. A remote pane gets `other_machine`.

```sh
oriel --timeout 300 plugins new "CSV Table" --json   # the template, installed, built and trusted: id, folder, log
# edit the files in the folder, then:
oriel --timeout 120 plugins reload csv-table --json  # {"id":"csv-table","built":true,"ms":412,"cards":1}
oriel open csv-table ./data.csv
tail -f <log>                             # the plugin's log
```

- If the build fails, `reload` exits 1 with `build_failed` and prints the last 20 lines of the build. Open cards
  keep running the last good build.
- If a card of the plugin has unsaved edits, `reload` stops with `dirty` and names the pane. Ask the user to
  save. Oriel never discards edits.
- `new` and `reload` install and build, so pass a long `--timeout`.
- `oriel plugins reload` with no id reloads every plugin that has an open card.
- `reload <id>` of a plugin the user did not trust yet is `failed`: its card asks the user first.
- The manifest, the API and the template: https://oriel-docs.vercel.app/docs/plugins/building

## Install a plugin

This works only from a pane on Oriel's Mac.

```sh
oriel --timeout 600 plugins install npm:@acme/oriel-csv   # or git:<url>, or a folder: ./my-plugin, /path
```

- Oriel asks the user on the Mac to trust it. If the user clicks Cancel, the answer is `declined`.
- The answer comes after the install and the build, so pass a long `--timeout`. Exit 4 means that the wait
  ended and the install goes on. `oriel plugins` shows the plugin when it is ready.
- The user removes and updates plugins in Oriel's Plugins panel. A source already installed is `bad_argument`.
