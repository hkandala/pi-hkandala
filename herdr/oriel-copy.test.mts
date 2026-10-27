/**
 * Checks orielCopy against a fake herdr socket.
 *
 *   node --experimental-strip-types herdr/oriel-copy.test.mts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orielCopy } from "./oriel-copy.ts";

const dir = mkdtempSync(join(tmpdir(), "oriel-copy-"));
const socket = join(dir, "herdr.sock");
let mark: string | undefined;
const reports: any[] = [];
const server = net.createServer((c) =>
  c.on("data", (d) => {
    const { id, method, params } = JSON.parse(String(d));
    if (method === "pane.report_metadata") reports.push(params);
    const tokens = mark ? { "oriel-shown": mark } : {};
    c.end(`${JSON.stringify({ id, result: { pane: { pane_id: params.pane_id, tokens } } })}\n`);
  }),
);
await new Promise<void>((ok) => server.listen(socket, ok));
Object.assign(process.env, { HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "w1:p2" });
const text = "a long prompt ✓\n".repeat(500);

// Not shown by Oriel, or shown on Oriel's own Mac (pbcopy works): pi copies as before.
assert.equal(await orielCopy(text), false);
mark = "1";
assert.equal(await orielCopy(text), false);
assert.equal(reports.length, 0);

// Shown from another machine: the text in Oriel's file, its id in the token.
mark = "remote";
assert.equal(await orielCopy(text), true);
const [report] = reports;
assert.equal(report.pane_id, "w1:p2");
assert.equal(report.source, "pi-copy");
assert.match(report.tokens["oriel-copy"], /^[0-9a-f-]{36}$/);
const file = `/tmp/oriel-copy-${report.tokens["oriel-copy"]}`;
assert.equal(readFileSync(file, "utf8"), text);
assert.equal(statSync(file).mode & 0o777, 0o600);
rmSync(file);

// No herdr: no request.
delete process.env.HERDR_PANE_ID;
assert.equal(await orielCopy(text), false);
assert.equal(reports.length, 1);

server.close();
rmSync(dir, { recursive: true, force: true });
console.log("oriel-copy: ok");
