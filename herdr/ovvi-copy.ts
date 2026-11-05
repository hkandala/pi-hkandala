/**
 * Copy through Ovvi (a native herdr client for macOS) when pi runs on another machine: pi's own
 * copy there is OSC 52, which herdr hands only to its own TUI, so it never reaches Ovvi's Mac.
 *
 * When Ovvi shows this pane from another machine (its token `ovvi-shown` = `remote`; `1` means
 * Ovvi's own Mac, where pbcopy works), the text goes to `ovvi copy` on standard input: Ovvi's
 * command, which Ovvi writes on each machine where it opens a session.
 *
 *   if (!(await ovviCopy(text))) await copyToClipboard(text);
 */

import { execFile } from "node:child_process";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const OVVI = join(homedir(), ".cache", "ovvi", "bin", "ovvi");

/** Resolves true when Ovvi takes the copy; false to copy as before (Ovvi's Mac, no herdr, no Ovvi). */
export async function ovviCopy(text: string): Promise<boolean> {
  const { HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: pane } = process.env;
  if (!socket || !pane) return false;
  const got = await rpc(socket, "pane.get", { pane_id: pane }).catch(() => undefined);
  if (got?.pane?.tokens?.["ovvi-shown"] !== "remote") return false;
  return new Promise((ok) => {
    const child = execFile(OVVI, ["copy"], { timeout: 15_000 }, (e) => ok(!e));
    child.stdin?.on("error", () => {}); // no command, or it ended early: the callback says false
    child.stdin?.end(text);
  });
}

/** One request to a herdr socket: its result, or a rejection with herdr's error. */
const rpc = (socket: string, method: string, params: object) =>
  new Promise<any>((ok, fail) => {
    const s = net.createConnection(socket);
    let buf = "";
    s.setTimeout(2000, () => s.destroy(new Error(`herdr ${method}: timed out`)));
    s.on("error", fail);
    s.on("close", () => fail(new Error(`herdr ${method}: no reply`))); // no-op after a reply
    s.on("connect", () => s.write(`${JSON.stringify({ id: "pi-copy", method, params })}\n`));
    s.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      s.destroy();
      try {
        const reply = JSON.parse(buf.slice(0, buf.indexOf("\n")));
        if (reply.error) fail(new Error(reply.error.message));
        else ok(reply.result);
      } catch (e) {
        fail(e);
      }
    });
  });
