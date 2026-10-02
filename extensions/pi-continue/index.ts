/**
 * pi-continue: ctrl+shift+enter nudges the agent to continue. While the agent is working, the
 * nudge is queued as a follow-up instead, and during a compaction with no run (a manual /compact)
 * it waits for the compaction to end. One nudge at a time: another press while one waits only says so.
 *
 * The nudge is a custom message: the model reads `<continue-nudge>…</continue-nudge>`, and the
 * transcript shows a dim "Nudged to continue" line in its place instead of a user message.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const TYPE = "pi-continue";

const nudge = {
  customType: TYPE,
  content: "<continue-nudge>Continue from where you stopped.</continue-nudge>",
  display: true,
};

export default function (pi: ExtensionAPI) {
  let queued = false; // a nudge sent but not delivered yet
  let pending: ReturnType<typeof setInterval> | undefined;
  const stopPending = () => {
    clearInterval(pending);
    pending = undefined;
  };

  /**
   * During a compaction with no run (a manual /compact), pi would start a run beside it for a custom
   * message, and refuses a prompt. Then `send` waits until it ends (checked every 100 ms) and this
   * returns true; one waits at a time.
   */
  function afterCompaction(ctx: ExtensionContext, send: () => void): boolean {
    const compacting = () => !ctx.isIdle() && !ctx.signal;
    if (!compacting()) return false;
    stopPending();
    ctx.ui.notify("Queued until compaction ends", "info");
    pending = setInterval(() => {
      try {
        if (compacting()) return;
        stopPending();
        send();
      } catch {
        stopPending(); // the session was replaced: ctx is stale
      }
    }, 100);
    return true;
  }

  pi.registerMessageRenderer(
    TYPE,
    (_message, { outputPad }, theme) =>
      new Text(theme.fg("dim", "Nudged to continue"), outputPad, 0),
  );

  const send = (ctx: ExtensionContext) => {
    const idle = ctx.isIdle(); // read first: sending while idle starts the run at once
    queued = true;
    // When idle, pi ignores deliverAs and starts a turn.
    pi.sendMessage(nudge, { triggerTurn: true, deliverAs: "followUp" });
    if (!idle) ctx.ui.notify("Queued: nudge to continue", "info");
  };

  pi.registerShortcut("ctrl+shift+enter", {
    description: "Nudge the agent to continue",
    handler: (ctx) => {
      if (queued || pending) return ctx.ui.notify("Nudge already queued", "info");
      if (!afterCompaction(ctx, () => send(ctx))) send(ctx);
    },
  });

  pi.on("message_start", ({ message }) => {
    if (message.role === "custom" && message.customType === TYPE) queued = false;
  });
  // The run is over: a queued nudge went out, or esc dropped it with pi's queue.
  pi.on("agent_settled", () => {
    queued = false;
  });
  pi.on("session_shutdown", () => {
    queued = false;
    stopPending();
  });
}
