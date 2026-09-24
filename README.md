# pi-hkandala

My personal [pi](https://pi.dev) extensions, packaged as a single pi package.

| Extension                                  | Description                                          |
| ------------------------------------------ | ---------------------------------------------------- |
| [pi-header](extensions/pi-header/README.md) | Minimal startup header with the official pi logo |

## Install

```bash
pi install ~/code/pi-hkandala          # local checkout, loaded in place
pi install git:github.com/<user>/pi-hkandala     # or from git, once pushed
```

Local installs aren't copied: edit files here and run `/reload` in pi. Remove with `pi remove ~/code/pi-hkandala`, or toggle single extensions with `pi config`.

## Layout

```
extensions/
  <name>/
    index.ts     # extension entry point
    README.md    # what it does + configuration
```

To add an extension, create `extensions/<name>/index.ts`. `package.json` loads everything under `extensions/`, so no other changes are needed.
