/**
 * Checks orielCopy against a fake herdr socket.
 *
 *   node --experimental-strip-types herdr/oriel-copy.test.mts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orielCopy } from "./oriel-copy.ts";

const dir = mkdtempSync(join(tmpdir(), "oriel-copy-"));
const socket = join(dir, "herdr.sock");
let shown = false;
const reports: any[] = [];
const server = net.createServer((c) =>
  c.on("data", (d) => {
    const { id, method, params } = JSON.parse(String(d));
    if (method === "pane.report_metadata") reports.push(params);
    const tokens = shown ? { "oriel-shown": "1" } : {};
    c.end(`${JSON.stringify({ id, result: { pane: { pane_id: params.pane_id, tokens } } })}\n`);
  }),
);
await new Promise<void>((ok) => server.listen(socket, ok));
Object.assign(process.env, { HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "w1:p2" });
const text = "a long prompt ✓\n".repeat(500);

// Not shown by Oriel: pi copies as before.
process.env.SSH_CONNECTION = "10.0.0.1 1 10.0.0.2 22";
assert.equal(await orielCopy(text), false);

// Shown, on another machine: the text in Oriel's file, its id in the token.
shown = true;
assert.equal(await orielCopy(text), true);
const [report] = reports;
assert.equal(report.pane_id, "w1:p2");
assert.equal(report.source, "pi-copy");
assert.match(report.tokens["oriel-copy"], /^[0-9a-f-]{36}$/);
const file = `/tmp/oriel-copy-${report.tokens["oriel-copy"]}`;
assert.equal(readFileSync(file, "utf8"), text);
assert.equal(statSync(file).mode & 0o777, 0o600);
rmSync(file);

// On this Mac (no SSH): pbcopy works, so no request.
if (process.platform === "darwin") {
  delete process.env.SSH_CONNECTION;
  assert.equal(await orielCopy(text), false);
  assert.equal(reports.length, 1);
}

// No herdr: no request.
process.env.SSH_CONNECTION = "10.0.0.1 1 10.0.0.2 22";
delete process.env.HERDR_PANE_ID;
assert.equal(await orielCopy(text), false);
assert.equal(existsSync(file), false);

server.close();
rmSync(dir, { recursive: true, force: true });
console.log("oriel-copy: ok");
