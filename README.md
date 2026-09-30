# pi-hkandala

My [pi](https://pi.dev) resources. Each one is its own pi package, so you can install one or all.

## Extensions

| Extension                                                       | Description                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [pi-bash-bg](extensions/pi-bash-bg/README.md)                   | Background bash: move a running command to the background, get a message when it ends                                                |
| [pi-bash-cap](extensions/pi-bash-cap/README.md)                 | Configurable line and byte limits for bash tool output                                                                               |
| [pi-content-layout](extensions/pi-content-layout/README.md)     | Compact transcript: tool calls and thinking in collapsible summarized groups, boxed user messages, optional timestamps               |
| [pi-continue](extensions/pi-continue/README.md)                 | ctrl+shift+enter nudges the agent to continue without a user message (queued as a follow-up while it is working)                     |
| [pi-footer](extensions/pi-footer/README.md)                     | Minimal one-line footer in a rounded prompt box that expands into a dashboard                                                        |
| [pi-header](extensions/pi-header/README.md)                     | Minimal startup header with the official pi logo                                                                                     |
| [pi-ponytail](extensions/pi-ponytail/README.md)                 | Lazy-senior-dev ruleset from ponytail as a cache-friendly system prompt section, with `/ponytail` to run its skills                  |
| [pi-prompt-clipboard](extensions/pi-prompt-clipboard/README.md) | ctrl+shift+s copies the prompt to the clipboard and clears it; paste long text twice to expand it for editing                        |
| [pi-retry](extensions/pi-retry/README.md)                       | Makes pi's auto-retry cover every model error (unknown errors, 400s, ...), except auth errors                                        |
| [pi-time-sense](extensions/pi-time-sense/README.md)             | Gives the agent a sense of time: a hidden current-time marker at most once an hour, cache-friendly                                   |
| [pi-web](extensions/pi-web/README.md)                           | `web_search` and `web_fetch` tools backed by TinyFish's free APIs; fetched pages are saved to files, previewed only for a single URL |
| [pi-working](extensions/pi-working/README.md)                   | Elapsed timer in the working label, and a `✓ Worked for 4m 12s` label after each run                                                 |

## Skills

| Skill                                            | Description                                                                                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [simple-english](skills/simple-english/SKILL.md) | Plain, layman-readable English (ASD-STE100 style) for docs and replies. Copied from [AminBlg/SimpleEnglish](https://github.com/AminBlg/SimpleEnglish) (commit `79b590f`); update by copying its `skills/simple-english/` again |

Skills load with the root package only.

## herdr

[herdr/](herdr/README.md) holds optional pieces for [herdr](https://herdr.dev), shared by the extensions: a patch to herdr's pi integration that keeps a pane `working` while pending work (background jobs, agent waits) will wake the agent, and a herdr plugin with a popup that runs any command (used to attach to another pane).

## Install

**One extension** (see each extension's README for its package name):

```bash
pi install npm:@hkandala/pi-header
```

**Everything**, from a local checkout (loaded in place: edit, then `/reload`):

```bash
git clone https://github.com/hkandala/pi-hkandala ~/code/pi-hkandala
pi install ~/code/pi-hkandala                        # everything
pi install ~/code/pi-hkandala/extensions/pi-header   # or just one
```

**From git without npm**, pick extensions with a filter in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    { "source": "git:github.com/hkandala/pi-hkandala", "extensions": ["extensions/pi-header/**"] }
  ]
}
```

Remove with `pi remove <source>`, or toggle single extensions with `pi config`.

## Layout

```
package.json          # root package: loads everything below (private, not published)
extensions/
  <name>/
    package.json      # standalone pi package, publishable to npm
    index.ts          # entry point (a large one splits self-contained parts into files beside it)
    README.md         # what it does + configuration
skills/
  <name>/SKILL.md     # skills, loaded by the root package
herdr/
  patch/<version>/    # patch to herdr's pi integration, one folder per herdr version
  plugin/             # herdr plugin (one popup), installed with `herdr plugin install` or `link`
```

See [AGENTS.md](AGENTS.md) for adding and publishing extensions.

## Development

```bash
npm install
npm run fmt     # format with oxfmt
npm run check   # format check + oxlint
```

## License

[MIT](LICENSE)
