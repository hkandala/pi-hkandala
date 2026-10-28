# AGENTS.md

Personal pi resources. Each `extensions/<name>/` is a standalone pi package (except that the ones that copy import `herdr/oriel-copy.ts`, so they load from the repo); the root package loads everything and is never published.

The root `package.json` intentionally has no `pi` manifest: pi then auto-discovers top-level `extensions/`, `skills/`, `prompts/`, and `themes/`. Adding a manifest would stop new folders from loading.

## Adding an extension

- Create `extensions/<name>/` with `index.ts`, `README.md`, and a `package.json` modeled on `extensions/pi-header/package.json` (npm name `@hkandala/<name>`).
- Add a row to the table in the root `README.md`.
- Each extension README covers what it does, install, and configuration.

## Skills

`skills/<name>/` holds skills copied unchanged from upstream repos, and our own (`oriel-panes`). Add a row to the Skills table in the root `README.md`; for a copied skill, name the source and commit, so it can be re-synced.

## herdr

`herdr/` holds what extensions share for herdr: `patch/<version>/` patches herdr's pi integration (one patch covering every extension's needs, with `patch/test.mts`), `oriel-copy.ts` copies through Oriel (every extension that copies calls it before pi's `copyToClipboard`), and `plugin/` is a herdr plugin (a manifest only) with popup panes that run `POPUP_COMMAND` (the caller shows how to close a popup; herdr requires each pane to have a non-blank title). Extensions must work without either. Extend the existing patch or plugin rather than adding one per extension.

## Rules

- Import pi APIs from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (and TypeBox's `Type`/`StringEnum` from `@earendil-works/pi-ai`). Pi provides them at runtime: list them only as `peerDependencies` (`"*"`), never as dependencies.
- Runtime npm dependencies go in the extension's own `package.json`. The root holds dev tooling only.
- No build step: pi loads `.ts` directly.
- Extension config lives in `~/.pi/agent/extensions/<name>.json`, is optional, and every key has a default.
- Guard TUI-only UI with `ctx.mode === "tui"`.
- Keep extensions small and simple; prefer one `index.ts`. Move a self-contained part (no shared state) into a file beside it only when `index.ts` grows long; `"files": ["*.ts", "README.md"]` publishes it.

## Workflow

- The repo is installed locally with `pi install ~/code/pi-hkandala`; test changes with `/reload` in pi.
- Before committing: `npm run fmt && npm run check` (oxfmt + oxlint).
- Publish one extension: bump its `version`, then `cd extensions/<name> && npm publish`.
