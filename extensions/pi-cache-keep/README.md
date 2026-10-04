# pi-cache-keep

Keeps the system prompt stable in runs that an extension message starts, so the prompt cache survives and the model keeps its instructions.

Some extensions add a section to the system prompt when you send a prompt: [pi-ponytail](../pi-ponytail/README.md) adds `ponytail`, Meta's repo info adds `meta_workspace` and CLAUDE.md files, and pi's MCP support adds `mcp_servers`. Pi runs these additions only for a prompt. Other runs start from a message, for example a [pi-herd](../pi-herd/README.md) agent message, a [pi-bash-bg](../pi-bash-bg/README.md) job end or a [pi-continue](../pi-continue/README.md) nudge. In such a run, after the first tool call, pi records that the sections are removed. Your next prompt adds them again.

```
 what pi records                         what the model gets, without / with pi-cache-keep
 [prompt: A B ponytail meta]             A B ponytail meta     A B ponytail meta
 user: "fix the test"
 ── a job ends, the session wakes ──
 tool call
 [ponytail, meta removed]                A B  ✗ cache lost     A B ponytail meta  ✓
 user: "run lint"
 [ponytail, meta added]                  A B ponytail meta ✗   A B ponytail meta  ✓
```

When a model folds these changes into the start of the prompt, each change makes the provider read the whole conversation again without the cache. Claude through Meta's provider works this way. Between the two changes, the model also works without those sections.

## How it works

- When you send a prompt, it adds a hidden marker section. So each prompt change that pi records in such a run carries the marker. The removal that a message-started run records also removes the marker.
- Before each model call, it sends a filtered copy of the prompt changes. A change recorded while the marker is missing is held back. Your next prompt's change replaces it. If that change does not set the same section, the held change is applied then, because it was a real change.
- Changes to pi's own sections (`tools`, `rules`, `skills`, ...) apply at once, because the tool list can change in the middle of a run.
- The marker never reaches the model. The session file stays as pi wrote it. Sessions from before the extension pass through unchanged.

## Install

```bash
pi install npm:@hkandala/pi-cache-keep
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-cache-keep`.

## Configuration

None.

## Notes

- A real change to a hook section or to `project_context` that pi records in a message-started run reaches the model at your next prompt. For example: you edit AGENTS.md, run `/reload`, and a job wakes the session before you type.
- `ctx.getSystemPrompt()`, `/export` and the session file show what pi recorded, not what the model got.
- A hook that returns a whole `systemPrompt`, or a `context` handler that changes the message list, is not covered. In the second case the extension warns once.
- Check: `node extensions/pi-cache-keep/test.ts`.
