/**
 * Checks orielCopy against a fake herdr socket and a fake `oriel` command.
 *
 *   node --experimental-strip-types herdr/oriel-copy.test.mts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oriel-copy-"));
const socket = join(dir, "herdr.sock");
const bin = join(dir, ".cache", "oriel", "bin");
const got = join(dir, "got");
let mark: string | undefined;
const server = net.createServer((c) =>
  c.on("data", (d) => {
    const { id, params } = JSON.parse(String(d));
    const tokens = mark ? { "oriel-shown": mark } : {};
    c.end(`${JSON.stringify({ id, result: { pane: { pane_id: params.pane_id, tokens } } })}\n`);
  }),
);
await new Promise<void>((ok) => server.listen(socket, ok));
// The fake command records its arguments and standard input, and exits with $CODE (3 at once with $EARLY).
Object.assign(process.env, { HOME: dir, HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "w1:p2" });
const { orielCopy } = await import("./oriel-copy.ts"); // after HOME: it names the command at load
const text = "a long prompt ✓\n".repeat(500);

// No command on this machine: pi copies as before.
mark = "remote";
assert.equal(await orielCopy(text), false);

mkdirSync(bin, { recursive: true });
writeFileSync(
  join(bin, "oriel"),
  `#!/bin/sh\n[ -n "$EARLY" ] && exit 3\necho "$@" >'${got}.args' && cat >'${got}.in' && exit \${CODE:-0}\n`,
  { mode: 0o755 },
);

// Not shown by Oriel, or shown on Oriel's own Mac (pbcopy works): no command runs.
mark = undefined;
assert.equal(await orielCopy(text), false);
mark = "1";
assert.equal(await orielCopy(text), false);
assert.equal(existsSync(`${got}.in`), false);

// Shown from another machine: the text goes to `oriel copy` on standard input.
mark = "remote";
assert.equal(await orielCopy(text), true);
assert.equal(readFileSync(`${got}.args`, "utf8"), "copy\n");
assert.equal(readFileSync(`${got}.in`, "utf8"), text);

// No Oriel took it (exit 3): pi copies as before.
process.env.CODE = "3";
assert.equal(await orielCopy(text), false);

// It exits before it reads a text bigger than a pipe holds: no crash on the broken pipe.
process.env.EARLY = "1";
assert.equal(await orielCopy("x".repeat(1 << 17)), false);

// No herdr: no command.
rmSync(`${got}.in`);
delete process.env.HERDR_PANE_ID;
assert.equal(await orielCopy(text), false);
assert.equal(existsSync(`${got}.in`), false);

server.close();
rmSync(dir, { recursive: true, force: true });
console.log("oriel-copy: ok");
