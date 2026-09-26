/**
 * pi-continue: ctrl+shift+enter sends a "continue" prompt. While the agent is working, it is
 * queued as a follow-up instead.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+shift+enter", {
    description: 'Send "continue"',
    handler: (ctx) => {
      if (ctx.isIdle()) return pi.sendUserMessage("continue");
      pi.sendUserMessage("continue", { deliverAs: "followUp" });
      ctx.ui.notify('Queued "continue"', "info");
    },
  });
}
