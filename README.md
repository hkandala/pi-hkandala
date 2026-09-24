# pi-hkandala

My [pi](https://pi.dev) resources: extensions for now, with skills and more to come. Each one is its own pi package, so you can install one or all.

## Extensions

| Extension                                   | Description                                      |
| ------------------------------------------- | ------------------------------------------------ |
| [pi-header](extensions/pi-header/README.md) | Minimal startup header with the official pi logo |

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
    index.ts          # entry point
    README.md         # what it does + configuration
    LICENSE
skills/               # later; also prompts/, themes/ (auto-discovered, no config needed)
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
