/**
 * Checks the herdr patch against a fake herdr socket and a fake pi.
 *
 *   node --experimental-strip-types herdr/test.mts v0.9.1 [integration file]
 *
 * Applies <version>/herdr-agent-state.patch to a temp copy of the integration file (default:
 * ~/.pi/agent/extensions/herdr-agent-state.ts), then replays pi events and compares the states
 * the integration reports to herdr.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";

const version = process.argv[2] ?? "v0.9.1";
const original = process.argv[3] ?? join(homedir(), ".pi/agent/extensions/herdr-agent-state.ts");
const dir = mkdtempSync(join(tmpdir(), "herdr-patch-"));
const patched = join(dir, "patched.mts");
copyFileSync(original, patched);
execFileSync("patch", [
  "-s",
  patched,
  join(import.meta.dirname, version, "herdr-agent-state.patch"),
]);
const sock = `/tmp/herdr-sim-${process.pid}.sock`;
process.env.HERDR_ENV = "1";
process.env.HERDR_SOCKET_PATH = sock;
process.env.HERDR_PANE_ID = "w1:p1";
let log: string[] = [];
const server = net.createServer((c) =>
  c.on("data", (d) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      const r = JSON.parse(line);
      if (r.method === "pane.report_agent") log.push(r.params.state);
    }
    c.write('{"ok":true}\n');
  }),
);
await new Promise((r) => server.listen(sock, r));
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
let n = 0;
async function load() {
  const handlers: Record<string, Function[]> = {};
  const bus = new EventEmitter();
  let idle = true;
  const pi = {
    on: (e, h) => (handlers[e] ??= []).push(h),
    events: { on: (c, h) => bus.on(c, h), emit: (c, d) => bus.emit(c, d) },
  };
  const mod = await import(`${patched}?i=${n++}`);
  mod.default(pi);
  const ctx = {
    mode: "tui",
    isIdle: () => idle,
    sessionManager: { getSessionFile: () => "/tmp/s.jsonl", getSessionId: () => "s1" },
  };
  return {
    emit: (c, d) => bus.emit(c, d),
    fire: async (e, ev = {}) => {
      for (const h of handlers[e] ?? []) await h(ev, ctx);
      await tick();
    },
    setIdle: (v) => (idle = v),
  };
}
const bg = (active) => ({ source: "pi-bash-bg", active });
let failed = false;
async function scenario(name, fn, expect) {
  log = [];
  await fn();
  await tick(150);
  if (JSON.stringify(log) !== JSON.stringify(expect)) failed = true;
  console.log(
    `${JSON.stringify(log) === JSON.stringify(expect) ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(log)}${JSON.stringify(log) === JSON.stringify(expect) ? "" : " expected " + JSON.stringify(expect)}`,
  );
}
await scenario(
  "turn ends with bg jobs -> stays working until jobs end",
  async () => {
    const s = await load();
    await s.fire("session_start", { reason: "startup" });
    s.setIdle(false);
    await s.fire("agent_start");
    s.emit("herdr:working", bg(true));
    await tick();
    s.setIdle(true);
    await s.fire("agent_settled");
    s.emit("herdr:working", bg(false));
    await tick();
  },
  ["idle", "working", "idle"],
);
await scenario(
  "job end wakes agent: no idle flicker",
  async () => {
    const s = await load();
    s.emit("herdr:working", bg(true)); // factory-time emit (reload cache)
    await s.fire("session_start", { reason: "reload" });
    s.setIdle(false);
    await s.fire("agent_start"); // woken by end message
    s.emit("herdr:working", bg(false));
    await tick(); // emitted after agent_start
    s.setIdle(true);
    await s.fire("agent_settled");
  },
  ["working", "idle"],
);
await scenario(
  "reload: emit before session_start -> first report is working",
  async () => {
    const s = await load();
    s.emit("herdr:working", bg(true));
    await s.fire("session_start", { reason: "reload" });
  },
  ["working"],
);
await scenario(
  "reload: emit after session_start flashes idle (why pi-bash-bg also emits early)",
  async () => {
    const s = await load();
    await s.fire("session_start", { reason: "reload" });
    s.emit("herdr:working", bg(true));
    await tick();
  },
  ["idle", "working"],
);
await scenario(
  "blocked wins, then back to working",
  async () => {
    const s = await load();
    s.emit("herdr:working", bg(true));
    await s.fire("session_start", { reason: "startup" });
    s.emit("herdr:blocked", { active: true, label: "confirm" });
    await tick();
    s.emit("herdr:blocked", { active: false });
    await tick();
  },
  ["working", "blocked", "working"],
);
await scenario(
  "repeated emits are idempotent; two sources",
  async () => {
    const s = await load();
    await s.fire("session_start", { reason: "startup" });
    s.emit("herdr:working", bg(true));
    s.emit("herdr:working", bg(true));
    s.emit("herdr:working", { source: "other", active: true });
    await tick();
    s.emit("herdr:working", bg(false));
    await tick();
    s.emit("herdr:working", { source: "other", active: false });
    await tick();
  },
  ["idle", "working", "idle"],
);
server.close();
process.exit(failed ? 1 : 0);
