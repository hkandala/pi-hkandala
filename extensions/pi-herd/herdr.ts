/**
 * The herdr socket API, the dedicated herdr session that runs agents started hidden, and the
 * herdr side of starting an agent, following its status, and showing it in a popup.
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const SESSION = "pi-herd"; // the dedicated herdr session for agents started hidden
export const HIDDEN = join(homedir(), ".config", "herdr", "sessions", SESSION, "herdr.sock");
export const PLUGIN = "pi-hkandala"; // the repo's herdr plugin (herdr/plugin/)

/** `s` quoted for sh. */
export const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export const parseLine = (line: string) => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** One request to a herdr socket; resolves with its result, rejects with herdr's error. */
export function rpc(socket: string, method: string, params: object = {}): Promise<any> {
  return new Promise((ok, fail) => {
    const s = net.createConnection(socket);
    let buf = "";
    const done = (err?: Error, result?: unknown) => {
      clearTimeout(timer);
      s.destroy();
      if (err) fail(err);
      else ok(result);
    };
    const timer = setTimeout(() => done(new Error(`herdr ${method}: timed out`)), 5000);
    s.on("connect", () => s.write(`${JSON.stringify({ id: "pi-herd", method, params })}\n`));
    s.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const res = parseLine(buf.slice(0, buf.indexOf("\n")));
      if (!res) return done(new Error(`herdr ${method}: bad response`));
      if (!res.error) return done(undefined, res.result);
      done(Object.assign(new Error(res.error.message), { code: res.error.code }));
    });
    s.on("error", (err) => done(err));
  });
}

/** Starts the dedicated herdr session's server if it isn't running (spec section 7). */
export async function ensureServer() {
  if (await rpc(HIDDEN, "ping").then(Boolean, () => false)) return;
  const env: NodeJS.ProcessEnv = {};
  for (const k of ["HOME", "USER", "PATH", "SHELL", "TERM", "LANG", "TMPDIR"])
    if (process.env[k]) env[k] = process.env[k];
  spawn("herdr", ["--session", SESSION, "server"], {
    detached: true,
    stdio: "ignore",
    env,
  })
    .on("error", () => {}) // herdr not on PATH: the ping loop below reports it
    .unref();
  for (let t = Date.now(); Date.now() - t < 5000; await new Promise((r) => setTimeout(r, 100)))
    if (await rpc(HIDDEN, "ping").then(Boolean, () => false)) return;
  throw new Error(`herdr session ${SESSION} didn't start within 5 s`);
}

/**
 * Follows a pane's agent status: one events.subscribe connection, reconnecting a second after it
 * closes while `retry()` says so. Returns a function that stops it.
 */
export function subscribePane(
  socket: string,
  pane: string,
  h: {
    open: () => void; // (re)connected
    status: (s: string | undefined) => void; // pane.agent_status_changed
    gone: () => void; // the pane exited or closed
    retry: () => boolean; // on close: reconnect?
  },
) {
  let stopped = false;
  let sock: net.Socket | undefined;
  const connect = () => {
    if (stopped) return;
    let buf = "";
    sock = net.createConnection(socket);
    sock.on("connect", () => {
      sock!.write(
        `${JSON.stringify({
          id: "pi-herd",
          method: "events.subscribe",
          params: {
            subscriptions: [
              { type: "pane.agent_status_changed", pane_id: pane },
              { type: "pane.closed" },
              { type: "pane.exited" },
            ],
          },
        })}\n`,
      );
      h.open();
    });
    sock.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const ev = parseLine(line);
        if (ev?.data?.pane_id !== pane) continue;
        // herdr 0.9.3 names these pane.agent_status_changed but pane_exited / pane_closed.
        const kind = String(ev.event).replace(".", "_");
        if (kind === "pane_exited" || kind === "pane_closed") h.gone();
        else if (kind === "pane_agent_status_changed") h.status(ev.data.agent_status);
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      if (!stopped && h.retry()) setTimeout(connect, 1000);
    });
  };
  connect();
  return () => {
    stopped = true;
    sock?.destroy();
  };
}

/**
 * A pane agent_start runs an agent in: on `sock`; `created` when pi-herd made it (pi is exec'd
 * there, so it closes with pi); `rename`, a new workspace's tab still to name.
 */
export type Placed = { sock: string; target: string; created: boolean; rename?: string };

/**
 * agent_start's pane for `where`: "hidden" (a new tab in the dedicated session's workspace for its
 * folder, or a new workspace), "tab" (a new tab in the caller's workspace), or a given pane, which
 * must be an idle shell in the caller's session.
 */
export async function openPane(
  where: string,
  o: {
    socket: string; // the caller's session
    pane: string; // the caller's pane
    cwd: string;
    folder: string; // the workspace label for cwd
    name?: string;
    env: Record<string, string>;
  },
): Promise<Placed> {
  const { cwd, name, env } = o;
  let sock = o.socket;
  /** A new tab in a workspace of `sock`, unfocused: its pane. */
  const newTab = async (workspace_id: string): Promise<string> =>
    (await rpc(sock, "tab.create", { workspace_id, cwd, label: name, env, focus: false })).root_pane
      .pane_id;
  if (where === "hidden") {
    await ensureServer();
    sock = HIDDEN;
    const { workspaces } = await rpc(sock, "workspace.list");
    const ws = (workspaces as { workspace_id: string; label: string }[]).find(
      (w) => w.label === o.folder,
    );
    if (ws) return { sock, target: await newTab(ws.workspace_id), created: true };
    const r = await rpc(sock, "workspace.create", { cwd, label: o.folder, env, focus: false });
    return { sock, target: r.root_pane.pane_id, created: true, rename: r.tab.tab_id };
  }
  if (where === "tab") {
    const { pane: mine } = await rpc(sock, "pane.get", { pane_id: o.pane });
    return { sock, target: await newTab(mine.workspace_id), created: true };
  }
  const target = where;
  const info = await rpc(sock, "pane.get", { pane_id: target }).catch(() => undefined);
  if (!info) throw new Error(`No pane ${target} in your herdr session.`);
  if (info.pane.agent) throw new Error(`Pane ${target} already runs ${info.pane.agent}.`);
  const { process_info: p } = await rpc(sock, "pane.process_info", { pane_id: target });
  if (p.foreground_process_group_id !== p.shell_pid)
    throw new Error(
      `Pane ${target} is busy (${p.foreground_processes?.[0]?.name ?? "a command"} is running).`,
    );
  return { sock, target, created: false };
}

/**
 * A launcher's own flags, when `parent` (its argv) is a program named `pi` that runs the real pi
 * (`own`: our argv): its args that we didn't get, the ones it consumed. Ours are split on spaces
 * too, as ps splits the parent's (so a prompt with spaces isn't taken for flags).
 */
export const launcherFlags = (parent: string[], own: string[]) => {
  if (basename(parent[0] ?? "") !== "pi") return [];
  const ours = new Set(own.flatMap((a) => a.split(/\s+/)));
  return parent.slice(1).filter((t) => !ours.has(t));
};
let launcher: string | undefined;
/**
 * The launcher's flags (launcherFlags), quoted for sh, each followed by a space; read once. Not
 * when this pi is itself named `pi` (then a parent `pi` is another pi, not a launcher). Linux reads
 * the parent's exact argv; macOS has only ps's, joined with spaces: a launcher flag's value with a
 * space in it comes out split.
 */
const launcherArgs = () =>
  (launcher ??= (() => {
    if (basename(process.execPath) === "pi") return "";
    try {
      const parent =
        process.platform === "linux"
          ? readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0").filter(Boolean)
          : execFileSync("ps", ["-ww", "-o", "args=", "-p", String(process.ppid)], {
              encoding: "utf8",
            })
              .trim()
              .split(/\s+/);
      return launcherFlags(parent, process.argv)
        .map((t) => `${q(t)} `)
        .join("");
    } catch {
      return "";
    }
  })());

/**
 * The line that starts pi in a placed pane: `exec pi …` in a created one; in a given one the env
 * goes on pi's command (the shell stays), after a `cd` when `cd` is given. A launcher's flags (the
 * `pi` that started this pi, see launcherArgs) come first, so agents start as this pi did.
 */
export const launchCommand = (
  p: Placed,
  flags: string,
  env: Record<string, string>,
  cd?: string,
) =>
  p.created
    ? `exec pi ${launcherArgs()}${flags}`
    : `${cd ? `cd ${q(cd)} && ` : ""}${Object.entries(env)
        .map(([k, v]) => `${k}=${q(v)}`)
        .join(" ")} pi ${launcherArgs()}${flags}`;

/** After a failed start: closes a created pane, or ends what runs in a given one (its shell stays). */
export async function releasePane(p: Placed) {
  if (p.created)
    return void (await rpc(p.sock, "pane.close", { pane_id: p.target }).catch(() => {}));
  const { process_info: info } = await rpc(p.sock, "pane.process_info", {
    pane_id: p.target,
  }).catch(() => ({}) as any);
  for (const proc of info?.foreground_processes ?? [])
    if (proc.pid !== info.shell_pid)
      try {
        process.kill(proc.pid, "SIGTERM");
      } catch {}
}

/**
 * The popup's shell command. Its marker (`markers`/<its pid>) names the agent it shows (id, socket,
 * pane, name), then the agent that opened it (the loop reads only the first four lines). It
 * attaches to the agent the marker names, again after a switch (a new agent there); when an attach
 * ends any other way (detach, the agent exits), the popup closes. Before each attach it sizes the
 * agent's pane to the popup (herdr keeps the size after a release) and gives pi 200 ms to redraw,
 * behind an "opening …" line: the attach then shows a settled screen instead of a redraw at the new
 * size. A signal exits through the EXIT trap (dash runs it only so) to remove the marker.
 */
export const popupCommand = (
  markers: string,
  a: { id: string; socket: string; pane: string; name: string; opener: string },
) =>
  `M=${q(markers)}/$$; trap 'rm -f "$M"' EXIT; trap 'exit 1' HUP INT TERM; ` +
  `printf '%s\\n' ${q(a.id)} ${q(a.socket)} ${q(a.pane)} ${q(a.name)} ${q(a.opener)} > "$M"; ` +
  `while { read -r ID; read -r S; read -r P; read -r N; } < "$M" && [ -n "$P" ]; do ` +
  `printf '\\033[2J\\033[H\\n  \\033[2mopening %s…\\033[0m' "$N"; set -- $(stty size); ` +
  `{ sleep 0.2; echo '{"type":"terminal.release"}'; } | HERDR_SOCKET_PATH="$S" ` +
  `herdr terminal session control "$P" --takeover --rows "$1" --cols "$2" >/dev/null 2>&1; ` +
  `HERDR_SOCKET_PATH="$S" herdr agent attach "$P" --takeover; ` +
  `{ read -r NEXT; } < "$M"; [ "$NEXT" != "$ID" ] || break; done`;
