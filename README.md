# pi-hkandala

My [pi](https://pi.dev) extensions. Each extension is its own pi package, so you can install one or all.

| Extension                                  | Description                                      |
| ------------------------------------------ | ------------------------------------------------ |
| [pi-header](extensions/pi-header/README.md) | Minimal startup header with the official pi logo |

## Install

**One extension** (see each extension's README for its package name):

```bash
pi install npm:@hkandala/pi-header
```

**Everything**, from a local checkout (loaded in place: edit, then `/reload`):

```bash
git clone <repo-url> ~/code/pi-hkandala
pi install ~/code/pi-hkandala                        # all extensions
pi install ~/code/pi-hkandala/extensions/pi-header   # or just one
```

**From git without npm**, pick extensions with a filter in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    { "source": "git:github.com/<user>/pi-hkandala", "extensions": ["extensions/pi-header/**"] }
  ]
}
```

Remove with `pi remove <source>`, or toggle single extensions with `pi config`.

## Layout

```
package.json          # root package: loads every extension (private, not published)
extensions/
  <name>/
    package.json      # standalone pi package, publishable to npm
    index.ts          # entry point
    README.md         # what it does + configuration
```

**Add an extension:** copy `extensions/pi-header/package.json` into `extensions/<name>/`, change `name` and `description`, add `index.ts` and `README.md`. The root package picks it up automatically.

**Publish one:** `cd extensions/<name> && npm publish`.
