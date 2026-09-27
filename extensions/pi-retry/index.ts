/**
 * pi-retry: make pi's built-in auto-retry cover every model error, not just the ones it recognizes
 * (e.g. "Unknown error (no error details in response)", empty errors, 400s).
 * Auth errors (401/403, invalid API key, ...) are left alone so they fail immediately.
 *
 * No retry loop here: failed messages are tagged with text pi already treats as retryable, and pi's
 * native retry does the rest (attempt count, backoff, countdown UI, esc to cancel). Configure it with
 * pi's own `retry` settings in ~/.pi/agent/settings.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Matches pi's built-in retryable pattern /provider.?returned.?error/.
const TAG = "[pi-retry] provider returned error";

// Errors a retry can't fix. Status codes only count where pi and provider SDKs put them.
const AUTH_ERROR = new RegExp(
  [
    String.raw`(?:^|\(|\b(?:status|http|code)[\s:=]*)40[13]\b`,
    String.raw`unauthori[sz]ed|\bforbidden\b`,
    String.raw`authentication[_ ](?:error|failed)|invalid[_ ]authentication`,
    String.raw`permission[_ ](?:error|denied)`,
    String.raw`(?:invalid|incorrect|missing|revoked|no)[_ ](?:x-)?api[_ -]?key|api[_ -]?key (?:is )?(?:not valid|invalid|expired|revoked)`,
    String.raw`(?:oauth|access|auth) token (?:has )?(?:expired|revoked)|invalid[_ ](?:bearer[_ ])?token`,
  ].join("|"),
  "i",
);

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    // User aborted: pi won't retry, and tagging would make it look like a provider failure.
    if (ctx.signal?.aborted) return;
    const text = message.errorMessage || "Unknown error";
    if (text.includes(TAG) || AUTH_ERROR.test(text)) return;
    return { message: { ...message, errorMessage: `${text}\n\n${TAG}` } };
  });
}
