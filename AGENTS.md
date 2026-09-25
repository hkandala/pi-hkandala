# AGENTS.md

Personal pi resources. Each `extensions/<name>/` is a standalone pi package; the root package loads everything and is never published.

The root `package.json` intentionally has no `pi` manifest: pi then auto-discovers top-level `extensions/`, `skills/`, `prompts/`, and `themes/`. Adding a manifest would stop new folders from loading.

## Adding an extension

- Create `extensions/<name>/` with `index.ts`, `README.md`, and a `package.json` modeled on `extensions/pi-header/package.json` (npm name `@hkandala/<name>`).
- Add a row to the table in the root `README.md`.
- Each extension README covers what it does, install, and configuration.

## Rules

- Import pi APIs from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`. Pi provides them at runtime: list them only as `peerDependencies` (`"*"`), never as dependencies.
- Runtime npm dependencies go in the extension's own `package.json`. The root holds dev tooling only.
- No build step: pi loads `.ts` directly.
- Extension config lives in `~/.pi/agent/extensions/<name>.json`, is optional, and every key has a default.
- Guard TUI-only UI with `ctx.mode === "tui"`.
- Keep extensions small and simple; prefer one `index.ts`.

## Workflow

- The repo is installed locally with `pi install ~/code/pi-hkandala`; test changes with `/reload` in pi.
- Before committing: `npm run fmt && npm run check` (oxfmt + oxlint).
- Publish one extension: bump its `version`, then `cd extensions/<name> && npm publish`.
