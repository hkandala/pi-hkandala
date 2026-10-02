# pi-retry

Makes pi's built-in auto-retry cover every model error, not just the ones it recognizes.

Pi only retries errors whose message matches a fixed list (overloaded, 429, 5xx, network errors, ...). Anything else, such as `Unknown error (no error details in response)`, an empty error, or a 400, ends the turn on the first failure. With this extension:

| Error                                                            | What happens                       |
| ---------------------------------------------------------------- | ---------------------------------- |
| Any model error                                                  | Retried by pi                      |
| Auth errors (401/403, invalid or missing API key, expired token) | Not retried: fails immediately     |
| Context overflow                                                 | Unchanged: pi compacts and retries |
| Quota, billing, or usage limits                                  | Unchanged: pi stops                |
| User abort (esc)                                                 | Unchanged: not retried or tagged   |

There is no separate retry loop. The extension marks failed messages as retryable, and pi's native retry handles the rest: attempt count, backoff, the `Retrying (n/N) in Xs... (esc to cancel)` countdown, and cancelling with esc.

## Install

```bash
pi install npm:@hkandala/pi-retry
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-retry`.

## Configuration

The extension has no config of its own. Retries use pi's `retry` settings in `~/.pi/agent/settings.json`:

| Key                     | Default | Meaning                                 |
| ----------------------- | ------- | --------------------------------------- |
| `retry.enabled`         | `true`  | Must stay `true`, or nothing is retried |
| `retry.maxRetries`      | `3`     | Retry attempts before the turn fails    |
| `retry.baseDelayMs`     | `2000`  | First delay; doubles on each attempt    |
| `retry.maxAgentDelayMs` | `60000` | Cap on a single delay                   |

Pi's default of 3 retries covers only ~14s of outage (2s, 4s, 8s). For long sessions, use 10 retries, as Claude Code does:

```json
{ "retry": { "maxRetries": 10 } }
```

That retries for ~6 minutes (2, 4, 8, 16, 32, then 60s each) before giving up.

Leave `retry.provider.maxRetries` at its default `0`: provider-level retries run silently inside a request, with no countdown in the UI.

## Notes

- Auth errors are detected from the error text, because pi does not give extensions the HTTP status. An unrecognized auth error is retried like any other. Press esc to stop it.
- Quota and billing errors are recognized by pi's own text patterns. An unrecognized one is retried. Press esc to stop it.
- Errors that fail the same way every time, such as a bad request, also go through the full retry schedule before the turn fails.
- Each failed message gets a `[pi-retry] provider returned error` line. This line is what makes pi retry it, so you see it in the final error. Pi does not show its `/bug` hint for these errors.
- Relies on pi treating `provider returned error` as retryable, which is one of its built-in patterns.
