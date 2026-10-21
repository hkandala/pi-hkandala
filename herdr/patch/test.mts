/**
 * Checks the herdr patch against a fake herdr socket and a fake pi.
 *
 *   node --experimental-strip-types herdr/patch/test.mts v0.9.1 [integration file]
 *
 * Applies <version>/herdr-agent-state.patch to a temp copy of an unpatched integration file
 * (default: a fresh one from `herdr integration install pi` in a temp HOME), then replays pi
 * events and compares the states the integration reports to herdr.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";

const version = process.argv[2] ?? "v0.9.1";
const dir = mkdtempSync(join(tmpdir(), "herdr-patch-"));
const patched = join(dir, "patched.mts");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const fail = (message: string) => {
  console.error(message);
  process.exit(2);
};
let original = process.argv[3];
if (!original) {
  mkdirSync(join(dir, ".pi/agent/extensions"), { recursive: true });
  try {
    execFileSync("herdr", ["integration", "install", "pi"], {
      env: { ...process.env, HOME: dir },
      stdio: "ignore",
    });
  } catch {
    fail("`herdr integration install pi` failed: pass an unpatched integration file.");
  }
  original = join(dir, ".pi/agent/extensions/herdr-agent-state.ts");
}
copyFileSync(original, patched);
try {
  // -N: fail on an already patched file instead of reversing the patch.
  execFileSync("patch", [
    "-N",
    "-s",
    patched,
    join(import.meta.dirname, version, "herdr-agent-state.patch"),
  ]);
} catch {
  fail(`The patch doesn't apply to ${original} (already patched?).`);
}
const sock = join(dir, "herdr.sock");
process.env.HERDR_ENV = "1";
process.env.HERDR_SOCKET_PATH = sock;
process.env.HERDR_PANE_ID = "w1:p1";
let log: string[] = [];
let resume: unknown; // resume_argv of the last state report
const server = net.createServer((c) =>
  c.on("data", (d) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      const r = JSON.parse(line);
      if (r.method === "pane.report_agent") {
        log.push(r.params.state);
        resume = r.params.resume_argv;
      }
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
  const pi = { on: (e, h) => (handlers[e] ??= []).push(h), events: bus };
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
    mark: (m) => log.push(`|${m}`), // orders a report before or after a step
  };
}
const bg = (active) => ({ source: "pi-bash-bg", active });
let failed = false;
async function scenario(name, fn, expect) {
  log = [];
  await fn();
  await tick(150);
  const got = JSON.stringify(log);
  const want = JSON.stringify(expect);
  if (got !== want) failed = true;
  console.log(
    `${got === want ? "PASS" : "FAIL"} ${name}: ${got}${got === want ? "" : ` expected ${want}`}`,
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
    s.mark("settled");
    s.emit("herdr:working", bg(false));
    await tick();
  },
  ["idle", "working", "|settled", "idle"],
);
await scenario(
  "reload: emit before session_start; job end wakes agent: no idle flicker",
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
  "reload: emit after session_start flashes idle (why the extensions also emit early)",
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
await scenario(
  "turn settles while pi still compacts -> idle once pi is idle",
  async () => {
    const s = await load();
    await s.fire("session_start", { reason: "startup" });
    s.setIdle(false);
    await s.fire("agent_start");
    await s.fire("agent_settled"); // still compacting: isIdle() is false
    await tick(200);
    s.mark("compacted");
    s.setIdle(true);
  },
  ["idle", "working", "|compacted", "idle"],
);
await scenario(
  "compaction during a run stays working",
  async () => {
    const s = await load();
    await s.fire("session_start", { reason: "startup" });
    s.setIdle(false);
    await s.fire("agent_start");
    await s.fire("session_compact");
    await tick(200);
    s.mark("run ends");
    s.setIdle(true);
    await s.fire("agent_settled");
  },
  ["idle", "working", "|run ends", "idle"],
);
async function resumes(name, argv, expect) {
  process.argv = [process.argv[0], "pi", ...argv];
  resume = undefined;
  await (await load()).fire("session_start", { reason: "startup" });
  const got = JSON.stringify(resume ?? null);
  const want = JSON.stringify(expect);
  if (got !== want) failed = true;
  console.log(
    `${got === want ? "PASS" : "FAIL"} ${name}: ${got}${got === want ? "" : ` expected ${want}`}`,
  );
}
const argv = process.argv;
await resumes(
  "started with -ne -> resumes with its own flags, not its old session",
  ["-ne", "-e", "/ext", "--session", "/old.jsonl", "--name", "a", "-c"],
  ["pi", "-ne", "-e", "/ext", "--name", "a", "--session", "/tmp/s.jsonl"],
);
await resumes("started without -ne -> herdr's default resume", ["--name", "a"], null);
process.argv = argv;
server.close();
process.exit(failed ? 1 : 0);
