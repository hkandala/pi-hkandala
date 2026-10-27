/**
 * Copy through Oriel (a native herdr client for macOS) when pi runs on another machine: pi's own
 * copy there is OSC 52, which herdr hands only to its own TUI, so it never reaches Oriel's Mac.
 *
 * When Oriel shows this pane from another machine (its token `oriel-shown` = `remote`; `1` means
 * Oriel's own Mac, where pbcopy works), the text goes in `/tmp/oriel-copy-<uuid>`
 * (herdr cuts a token value at 80 characters) and the uuid in the token `oriel-copy`. Oriel reads it
 * off herdr's `pane.updated` event, reads and deletes the file, and sets the Mac's clipboard.
 *
 *   if (!(await orielCopy(text))) await copyToClipboard(text);
 */

import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import net from "node:net";

/** Resolves true when Oriel takes the copy; false to copy as before (Oriel's Mac, no herdr, no Oriel). */
export async function orielCopy(text: string): Promise<boolean> {
  const { HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: pane } = process.env;
  if (!socket || !pane) return false;
  const got = await rpc(socket, "pane.get", { pane_id: pane }).catch(() => undefined);
  if (got?.pane?.tokens?.["oriel-shown"] !== "remote") return false;
  const id = randomUUID();
  const file = `/tmp/oriel-copy-${id}`;
  try {
    writeFileSync(file, text, { mode: 0o600, flag: "wx" });
    await rpc(socket, "pane.report_metadata", {
      pane_id: pane,
      source: "pi-copy",
      ttl_ms: 1000,
      tokens: { "oriel-copy": id },
    });
  } catch {
    rmSync(file, { force: true });
    return false;
  }
  // Oriel deletes it within a second; this is for an Oriel that missed the request (force: no throw).
  setTimeout(() => rmSync(file, { force: true }), 30_000).unref();
  return true;
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
