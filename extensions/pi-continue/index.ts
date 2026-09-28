/**
 * pi-continue: ctrl+shift+enter nudges the agent to continue. While the agent is working, the
 * nudge is queued as a follow-up instead.
 *
 * The nudge is a custom message: the model reads `<continue-nudge>…</continue-nudge>`, and the
 * transcript shows a dim "Nudged to continue" line in its place instead of a user message.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const TYPE = "pi-continue";

const nudge = {
  customType: TYPE,
  content: "<continue-nudge>Continue from where you stopped.</continue-nudge>",
  display: true,
};

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer(
    TYPE,
    (_message, { outputPad }, theme) =>
      new Text(theme.fg("dim", "Nudged to continue"), outputPad, 0),
  );

  pi.registerShortcut("ctrl+shift+enter", {
    description: "Nudge the agent to continue",
    handler: (ctx) => {
      if (ctx.isIdle()) return pi.sendMessage(nudge, { triggerTurn: true });
      pi.sendMessage(nudge, { triggerTurn: true, deliverAs: "followUp" });
      ctx.ui.notify("Queued: nudge to continue", "info");
    },
  });
}
