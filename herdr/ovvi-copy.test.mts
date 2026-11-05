/**
 * Checks ovviCopy against a fake herdr socket and a fake `ovvi` command.
 *
 *   node --experimental-strip-types herdr/ovvi-copy.test.mts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ovvi-copy-"));
const socket = join(dir, "herdr.sock");
const bin = join(dir, ".cache", "ovvi", "bin");
const got = join(dir, "got");
let mark: string | undefined;
const server = net.createServer((c) =>
  c.on("data", (d) => {
    const { id, params } = JSON.parse(String(d));
    const tokens = mark ? { "ovvi-shown": mark } : {};
    c.end(`${JSON.stringify({ id, result: { pane: { pane_id: params.pane_id, tokens } } })}\n`);
  }),
);
await new Promise<void>((ok) => server.listen(socket, ok));
// The fake command records its arguments and standard input, and exits with $CODE (3 at once with $EARLY).
Object.assign(process.env, { HOME: dir, HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "w1:p2" });
const { ovviCopy } = await import("./ovvi-copy.ts"); // after HOME: it names the command at load
const text = "a long prompt ✓\n".repeat(500);

// No command on this machine: pi copies as before.
mark = "remote";
assert.equal(await ovviCopy(text), false);

mkdirSync(bin, { recursive: true });
writeFileSync(
  join(bin, "ovvi"),
  `#!/bin/sh\n[ -n "$EARLY" ] && exit 3\necho "$@" >'${got}.args' && cat >'${got}.in' && exit \${CODE:-0}\n`,
  { mode: 0o755 },
);

// Not shown by Ovvi, or shown on Ovvi's own Mac (pbcopy works): no command runs.
mark = undefined;
assert.equal(await ovviCopy(text), false);
mark = "1";
assert.equal(await ovviCopy(text), false);
assert.equal(existsSync(`${got}.in`), false);

// Shown from another machine: the text goes to `ovvi copy` on standard input.
mark = "remote";
assert.equal(await ovviCopy(text), true);
assert.equal(readFileSync(`${got}.args`, "utf8"), "copy\n");
assert.equal(readFileSync(`${got}.in`, "utf8"), text);

// No Ovvi took it (exit 3): pi copies as before.
process.env.CODE = "3";
assert.equal(await ovviCopy(text), false);

// It exits before it reads a text bigger than a pipe holds: no crash on the broken pipe.
process.env.EARLY = "1";
assert.equal(await ovviCopy("x".repeat(1 << 17)), false);

// No herdr: no command.
rmSync(`${got}.in`);
delete process.env.HERDR_PANE_ID;
assert.equal(await ovviCopy(text), false);
assert.equal(existsSync(`${got}.in`), false);

server.close();
rmSync(dir, { recursive: true, force: true });
console.log("ovvi-copy: ok");
