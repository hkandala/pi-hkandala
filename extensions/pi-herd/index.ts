/**
 * pi-herd: every pi session running in a herdr pane is an agent that others can list, message,
 * watch, and start and stop agents of its own (and theirs).
 *
 * Shared files: store.ts. Status comes only from herdr (its pi integration, plus the repo's patch
 * in herdr/). A message is a steer that wakes an idle agent; a watch wakes the watcher when the
 * target stops working. Tools: agent_start, agent_stop, agent_send, agent_watch, agent_read,
 * agent_list. Commands: /agents, /detach.
 * An agent without a name gets a two-word one derived from its session id (frog-thunder).
 * Config (optional): ~/.pi/agent/extensions/pi-herd.json. See docs/SPEC.md for the design.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type KeyId, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import net from "node:net";
import { join, relative, resolve } from "node:path";
import { ensureServer, HIDDEN, parseLine, PLUGIN, rpc, SESSION } from "./herdr.ts";
import {
  agentFile,
  AGENTS,
  alive,
  ATTACHED,
  cleanup,
  DAY,
  derived,
  label,
  list,
  liveAgents,
  MESSAGES,
  readAgent,
  readJson,
  readPid,
  rm,
  short,
  STAMP,
  writeAtomic,
  type Agent,
} from "./store.ts";
import {
  brief,
  itemText,
  renderer,
  tilde,
  TYPE,
  WATCHER,
  type Delivery,
  type End,
  type Item,
  type Message,
} from "./text.ts";
import { capture, findSession, KB, lastError, lastText, transcript } from "./transcript.ts";

const MESSAGE_MAX = 32 * KB;
const SPAWN_WAIT = 30_000;
const BATCH_MS = 250; // messages and watch endings this close together share one steer
const NO_STALL = {
  EDITOR: "true",
  VISUAL: "true",
  GIT_EDITOR: "true",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  CI: "1",
};
const TOOLS = [
  "agent_start",
  "agent_stop",
  "agent_send",
  "agent_watch",
  "agent_read",
  "agent_list",
];

/** herdr's status for an agent's pane, or exited (no pane, or its pi is gone). */
type Status = "working" | "idle" | "done" | "blocked" | "unknown" | "exited";
/**
 * A watch on one agent. armed: leaving working ends it. A watch on a message (awaiting: its id)
 * arms once the recipient marks it delivered (pi handed it to the model); a plain agent_watch is
 * armed from the start. ending: its ending is queued; the watch is dropped once the steer goes out.
 */
type Watch = {
  agent: Agent;
  minutes: number;
  deadline: number; // 0: none
  armed: boolean;
  awaiting?: string;
  since: number; // when it was armed
  ending?: boolean;
};
// Survives /reload: the messages taken in, the watches, and the last herdr:working value.
const g = ((globalThis as { __piHerd?: unknown }).__piHerd ??= {}) as {
  me?: string;
  queued?: Set<string>;
  watches?: Map<string, Watch>;
  counts?: Map<string, { sent: number; received: number }>; // messages with each agent
  // The footer's agents, in the order they were first listed: this session's children and the
  // agents it has watched. Ended ones stay: when they ended, and whether this session stopped them.
  listed?: Map<string, Agent>;
  watched?: Set<string>;
  ended?: Map<string, { at: number; stopped: boolean }>;
  stopped?: Set<string>; // agents this session stopped (they may still be shutting down)
  since?: Map<string, number>; // when each followed agent's status last changed (for the footer)
  herdr?: boolean;
};

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const inside = (dir: string, p: string) => !relative(dir, p).startsWith("..");
const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m`;
};

/** An agent's status, from herdr (section 3 of the spec). */
async function status(a: Agent): Promise<Status> {
  if (!alive(a.pid)) return "exited";
  try {
    const { pane } = await rpc(a.herdr.socket, "pane.get", { pane_id: a.herdr.pane });
    return pane.agent_status ?? "unknown"; // whether pi runs there: the pid check above
  } catch (err) {
    return (err as { code?: string }).code === "pane_not_found" ? "exited" : "unknown";
  }
}

export default function (pi: ExtensionAPI) {
  // herdr only: inert without a herdr pane (spec: "herdr only").
  const socket = process.env.HERDR_SOCKET_PATH;
  const pane = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !pane || !socket) return;
  const parentId = process.env.PI_HERD_PARENT || undefined;

  const config = {
    placement: "hidden",
    model: null as string | null,
    thinking: null as string | null,
    args: [] as string[],
    watchTimeoutMinutes: 30,
    transcriptMessages: 20,
    captureLines: 100,
    detachKey: "ctrl+shift+q",
    ...readJson<object>(join(getAgentDir(), "extensions", "pi-herd.json")),
  };

  let ctx: ExtensionContext | undefined;
  let me: Agent | undefined; // this agent's record, while registered
  let busy = false; // an agent run is going
  let waking: ReturnType<typeof setTimeout> | undefined; // a steer is waking this idle agent
  let afterSettle: Item[] = []; // immediate messages, delivered once the aborted turn settles
  let outbox: Item[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let parentTimer: ReturnType<typeof setInterval> | undefined;
  let watchers: FSWatcher[] = [];
  let warned = false;
  let popupPid: number | undefined; // the popup shell showing this agent
  let lastUpdate = "";
  const waiters = new Set<() => void>(); // agent_start waits for a registration
  /** herdr status of children and watched agents, from one event subscription each. */
  const follows = new Map<
    string,
    { agent: Agent; status: Status; since: number; stop: () => void }
  >();

  const watches = () => (g.watches ??= new Map());
  const counts = () => (g.counts ??= new Map());
  const ended = () => (g.ended ??= new Map());
  const listed = () => (g.listed ??= new Map());
  const watched = () => (g.watched ??= new Set());
  const stopped = () => (g.stopped ??= new Set());
  const count = (id: string, key: "sent" | "received") => {
    const c = counts().get(id) ?? { sent: 0, received: 0 };
    c[key]++;
    counts().set(id, c);
  };
  const queued = () => (g.queued ??= new Set());
  const children = (agents = liveAgents()) => agents.filter((a) => me && a.parent === me.id);
  /** The agents below this one in the tree of agents started with agent_start, at any depth. */
  const descendants = (agents = liveAgents()) => {
    const byId = new Map(agents.map((x) => [x.id, x]));
    const below = (a: Agent) => {
      for (let p = a.parent, n = 0; p && n < 100; p = byId.get(p)?.parent, n++)
        if (p === me?.id) return true;
      return false;
    };
    return agents.filter(below);
  };

  // herdr (optional patch, see herdr/README.md): working while watches run. herdr plays "done" on
  // every working → idle change, so it must never see a gap.
  const emitHerdr = (active: boolean) => {
    g.herdr = active;
    pi.events.emit("herdr:working", { source: "pi-herd", active });
  };
  if (g.herdr) emitHerdr(true); // /reload: before herdr's new runtime publishes its first state

  /** Tells herdr, pi-footer and pi-working; starts and stops follows. */
  const refresh = () => {
    if (!me) return;
    // The agents this one started and the ones it has watched; listed ones that are gone stay
    // listed, as stopped or done (like finished jobs).
    const live = new Map(
      liveAgents()
        .filter((a) => a.parent === me!.id || watched().has(a.id))
        .map((a) => [a.id, a]),
    );
    for (const a of live.values()) {
      listed().set(a.id, a);
      if (ended().delete(a.id)) stopped().delete(a.id); // resumed
    }
    for (const id of listed().keys())
      if (!live.has(id) && !ended().has(id))
        ended().set(id, { at: Date.now(), stopped: stopped().has(id) });
    for (const [id, f] of follows)
      if (!live.has(id)) {
        f.stop();
        follows.delete(id);
      }
    for (const a of live.values()) if (!follows.has(a.id)) follow(a);
    const n = [...watches().values()].filter((w) => !w.ending).length;
    const update = {
      agents: [...listed().values()].map((a) => {
        const f = follows.get(a.id);
        const e = ended().get(a.id);
        return {
          id: a.id,
          name: label(a),
          // herdr's done is idle the user hasn't looked at; here done means the agent ended.
          state: e
            ? e.stopped
              ? "stopped"
              : "done"
            : f?.status === "done"
              ? "idle"
              : (f?.status ?? "unknown"),
          since: e?.at ?? f?.since ?? a.startedAt,
          live: !e,
          cwd: a.cwd,
          mine: a.parent === me!.id,
          watched: watches().has(a.id),
          sent: counts().get(a.id)?.sent ?? 0,
          received: counts().get(a.id)?.received ?? 0,
        };
      }),
      watching: n,
      waiting: busy ? 0 : n,
    };
    const json = JSON.stringify(update);
    if (json !== lastUpdate) pi.events.emit("herd:update", update);
    lastUpdate = json;
    // Working while watches run, also during the turn (herdr publishes idle when the turn settles,
    // before this could say otherwise) and while an ending waits for its steer (watches().size
    // still counts it): an agent watching this one would take any idle as finished.
    const active = watches().size > 0 || !!waking;
    if (active !== g.herdr) emitHerdr(active);
  };

  /** Follows an agent's herdr status: one events.subscribe connection, reconnecting until stopped. */
  const follow = (a: Agent) => {
    let stopped = false;
    let sock: net.Socket | undefined;
    const since = (g.since ??= new Map());
    const f = {
      agent: a,
      status: "unknown" as Status,
      since: since.get(a.id) ?? Date.now(),
      stop: () => {},
    };
    let known = false; // the first status after a (re)load keeps the kept time
    const set = (s: Status) => {
      if (stopped) return;
      if (s !== "exited" && !alive(a.pid)) s = "exited";
      if (s !== f.status && (known || !since.has(a.id))) since.set(a.id, (f.since = Date.now()));
      known = true;
      f.status = s;
      onStatus(a, s);
      refresh();
    };
    const connect = () => {
      if (stopped) return;
      let buf = "";
      sock = net.createConnection(a.herdr.socket);
      sock.on("connect", () => {
        sock!.write(
          `${JSON.stringify({
            id: "pi-herd",
            method: "events.subscribe",
            params: {
              subscriptions: [
                { type: "pane.agent_status_changed", pane_id: a.herdr.pane },
                { type: "pane.closed" },
                { type: "pane.exited" },
              ],
            },
          })}\n`,
        );
        void status(a).then(set); // (re)connected: read the status again
      });
      sock.on("data", (d) => {
        buf += d;
        for (let i; (i = buf.indexOf("\n")) >= 0;) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const ev = parseLine(line);
          if (ev?.data?.pane_id !== a.herdr.pane) continue;
          // herdr 0.9.3 names these pane.agent_status_changed but pane_exited / pane_closed.
          const kind = String(ev.event).replace(".", "_");
          if (kind === "pane_exited" || kind === "pane_closed") set("exited");
          // The pid check in set() says whether pi still runs there; herdr may not have named
          // the pane's agent yet when its first status arrives.
          else if (kind === "pane_agent_status_changed") set(ev.data.agent_status ?? "unknown");
        }
      });
      sock.on("error", () => {});
      sock.on("close", () => {
        if (stopped) return;
        if (!alive(a.pid)) return set("exited");
        setTimeout(connect, 1000);
      });
    };
    // Its message folder, for the delivered markers it writes (see checkDelivered).
    const dir = join(MESSAGES, a.id);
    mkdirSync(dir, { recursive: true });
    let marks: FSWatcher | undefined;
    try {
      marks = watch(dir, () => checkDelivered(a));
    } catch {}
    f.stop = () => {
      stopped = true;
      sock?.destroy();
      marks?.close();
    };
    follows.set(a.id, f);
    connect();
    checkDelivered(a);
  };

  /**
   * A watch on a message arms once the recipient marks the message delivered. Its turn may already
   * be over by then (a quick reply): if herdr still says idle a second later, the watch ends (the
   * second is for herdr's report of the new turn, which can arrive after the marker).
   */
  const checkDelivered = (a: Agent) => {
    const w = watches().get(a.id);
    if (!w?.awaiting || w.ending) return;
    if (!existsSync(join(MESSAGES, a.id, `${w.awaiting}.delivered`))) return;
    Object.assign(w, { awaiting: undefined, armed: true, since: Date.now() });
    const idle = (s: Status) => s === "idle" || s === "done";
    void status(a).then(async (s) => {
      if (!idle(s)) return;
      await new Promise((r) => setTimeout(r, 1000));
      if (idle(await status(a))) void end(w, "idle");
    });
  };
  /** A followed agent's status changed: may end its watch (spec section 6). */
  const onStatus = (a: Agent, s: Status) => {
    const w = watches().get(a.id);
    if (!w || w.ending) return;
    if (s === "exited") void endExited(a.id);
    else if (s === "blocked") void end(w, "blocked");
    else if (w.armed && (s === "idle" || s === "done")) void end(w, "idle");
  };

  /** Queues a steer item; items within BATCH_MS share one steer. */
  const post = (it: Item) => {
    outbox.push(it);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, BATCH_MS);
  };
  const flush = () => {
    const items = outbox;
    outbox = [];
    for (const [id, w] of watches()) if (w.ending) watches().delete(id);
    if (!items.length || !me) return;
    // Messages go by their delivery; watch endings on their own, in an "agent watcher" box.
    const groups = new Map<string, Item[]>();
    for (const it of items) {
      const key = it.kind === "message" ? (it.msg.delivery ?? "steer") : WATCHER;
      groups.set(key, [...(groups.get(key) ?? []), it]);
    }
    for (const [key, group] of groups) {
      const message = {
        customType: key === WATCHER ? WATCHER : TYPE,
        content: group.map(itemText).join("\n\n"),
        display: true as const,
        details: { items: group },
      };
      if (key === "immediate" && busy) {
        // Abort the running turn, then deliver once pi has settled.
        afterSettle.push(...group);
        ctx?.abort();
      } else deliver(message, key === "followUp" ? "followUp" : "steer");
    }
    refresh();
  };
  const deliver = (
    message: { customType: string; content: string; display: true; details: unknown },
    deliverAs: "steer" | "followUp",
  ) => {
    if (!busy) {
      // Keep herdr working until the woken run starts.
      clearTimeout(waking);
      waking = setTimeout(() => {
        waking = undefined;
        refresh();
      }, 2000);
    }
    void pi.sendMessage(message, { deliverAs, triggerTurn: true });
  };

  /** Ends a watch with an event, gathering what that ending carries. */
  const end = async (w: Watch, event: Exclude<End, "message">) => {
    if (w.ending || watches().get(w.agent.id) !== w) return;
    w.ending = true;
    armDeadline();
    refresh();
    const a = w.agent;
    const it: Item = { kind: "watch", event, agent: { id: a.id, name: a.name } };
    if (event === "idle") {
      it.worked = duration(Date.now() - w.since);
      it.text = await lastText(a, config.captureLines);
      it.error = lastError(a);
      if (!it.text) it.transcript = await transcript(a, 5, config.captureLines);
    }
    if (event === "exited") it.text = await lastText(a, config.captureLines);
    if (event === "blocked")
      it.screen = await capture(a.herdr.socket, a.herdr.pane, config.captureLines);
    if (event === "timeout") {
      it.status = follows.get(a.id)?.status ?? (await status(a));
      it.after = duration(w.minutes * 60_000);
      it.transcript = await transcript(a, config.transcriptMessages, config.captureLines);
    }
    if (watches().get(a.id) === w) post(it); // not when agent_stop dropped it meanwhile
  };
  /** Exited: scan the inbox first, so a final message still in flight ends the watch as `message`. */
  const endExited = async (id: string) => {
    scan();
    const w = watches().get(id);
    if (w) await end(w, "exited");
  };

  /** One timer for the earliest deadline; deadlines passed together end in one steer. */
  const armDeadline = () => {
    clearTimeout(deadlineTimer);
    const next = Math.min(
      ...[...watches().values()].map((w) => (!w.ending && w.deadline) || Infinity),
    );
    if (next === Infinity) return;
    deadlineTimer = setTimeout(
      () => {
        for (const w of watches().values())
          if (w.deadline && w.deadline <= Date.now()) void end(w, "timeout");
        armDeadline();
      },
      Math.min(2 ** 31 - 1, Math.max(0, next - Date.now())),
    );
  };

  /**
   * Starts (or restarts the deadline of) a watch. awaiting: the id of a message just sent to it;
   * the watch arms once that message is delivered. Without it, only a working agent is watched.
   * Returns its status.
   */
  const startWatch = async (a: Agent, awaiting?: string, minutes = config.watchTimeoutMinutes) => {
    const deadline = minutes > 0 ? Date.now() + minutes * 60_000 : 0;
    const old = watches().get(a.id);
    if (old && !old.ending) {
      // A new message: wait for its delivery again, so an earlier turn's end doesn't count.
      Object.assign(old, { minutes, deadline }, awaiting && { awaiting, armed: false });
      armDeadline();
      checkDelivered(a);
      return follows.get(a.id)?.status ?? "working";
    }
    const s = follows.get(a.id)?.status ?? (await status(a));
    if (s === "exited") return s;
    if (!awaiting && s !== "working") return s;
    const w: Watch = { agent: a, minutes, deadline, armed: !awaiting, awaiting, since: Date.now() };
    watches().set(a.id, w);
    watched().add(a.id);
    armDeadline();
    refresh();
    checkDelivered(a);
    if (s === "blocked") void end(w, "blocked");
    return s;
  };

  /** Takes in new messages from this agent's folder (spec section 4, Receiving). */
  const scan = () => {
    if (!me) return;
    const dir = join(MESSAGES, me.id);
    const fresh = list(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => f.slice(0, -5))
      .filter((id) => parseInt(id) >= me!.startedAt && !queued().has(id))
      .sort();
    for (const id of fresh) {
      const msg = readJson<Message>(join(dir, `${id}.json`));
      if (!msg) continue;
      queued().add(id);
      count(msg.from.id, "received");
      const w = watches().get(msg.from.id);
      const ends = !!w && !w.ending;
      if (ends) w.ending = true;
      post({
        kind: "message",
        msg,
        endsWatch: ends,
        original: msg.replyTo ? join(MESSAGES, msg.from.id, `${msg.replyTo}.json`) : undefined,
      });
    }
    if (!fresh.length) return;
    armDeadline();
    refresh();
  };

  /** The agents/ folder changed: parent death, exited targets, spawn waiters, the update. */
  const onAgents = () => {
    if (!me) return;
    if (!parentAlive()) return die();
    for (const id of watches().keys()) if (!alive(readAgent(id)?.pid ?? 0)) void endExited(id);
    for (const w of waiters) w();
    refresh();
  };
  const parentAlive = () => !parentId || alive(readAgent(parentId)?.pid ?? 0);
  /** Agents die with the agent that started them: SIGTERM ourselves so pi shuts down cleanly. */
  let dying = false;
  const die = () => {
    if (dying) return;
    dying = true;
    process.kill(process.pid, "SIGTERM");
  };

  /** A popup opened by /agents shows this agent while attached/<id> holds a live pid. */
  const onAttached = () => {
    if (!me || !ctx) return;
    const file = join(ATTACHED, me.id);
    const pid = readPid(file);
    if (existsSync(file) && !alive(pid)) rm(file);
    popupPid = alive(pid) ? pid : undefined;
    // Right-aligned above the prompt, in the margin pi-footer's box uses.
    ctx.ui.setWidget(
      "pi-herd",
      popupPid
        ? (_tui, theme) => ({
            invalidate() {},
            render: (width: number) => {
              const hint = theme.fg("warning", "ctrl+b q or /detach to close");
              return [" ".repeat(Math.max(0, width - visibleWidth(hint) - 3)) + hint];
            },
          })
        : undefined,
    );
  };
  const detach = () => {
    if (!popupPid) return ctx?.ui.notify("Not shown in a pi-herd popup.", "info");
    execFile("pkill", ["-TERM", "-P", String(popupPid)], () => {});
  };

  const watchDir = (dir: string, fn: () => void, debounce = 50) => {
    mkdirSync(dir, { recursive: true });
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      watchers.push(
        watch(dir, () => {
          clearTimeout(t);
          t = setTimeout(fn, debounce);
        }),
      );
    } catch (err) {
      if (!warned) ctx?.ui.notify(`pi-herd: can't watch ${tilde(dir)}: ${err}`, "warning");
      warned = true;
    }
  };

  /** Resolves ids, 8-char suffixes or names to live agents; any miss fails the whole call. */
  const resolveAll = (refs: string[], pool = liveAgents()) =>
    refs.map((ref) => {
      const found = pool.filter(
        (a) =>
          a.id === ref ||
          short(a.id) === ref ||
          (ref.length >= 4 && a.id.endsWith(ref)) ||
          label(a) === ref,
      );
      if (found.length === 1) return found[0]!;
      const known = pool.map((a) => `${short(a.id)} ${label(a)}`).join(", ") || "none";
      if (found.length > 1)
        throw new Error(`"${ref}" matches ${found.map((a) => short(a.id)).join(", ")}; use an id.`);
      throw new Error(`No live agent "${ref}". Live agents: ${known}.`);
    });
  const refs = (to: string | string[]) => (Array.isArray(to) ? to : [to]);

  /** Writes one message file per recipient; with needsReply, watches it. Returns the ids. */
  const send = async (
    targets: Agent[],
    m: { text: string; delivery?: Delivery; needsReply?: boolean },
    replyTo?: string,
  ) => {
    if (Buffer.byteLength(m.text) > MESSAGE_MAX)
      throw new Error("Message over 32 KB: write it to a file and send the path.");
    if (targets.some((t) => t.id === me!.id)) throw new Error("Can't message yourself.");
    const ids: string[] = [];
    for (const t of targets) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const msg: Message = {
        id,
        from: { id: me!.id, name: me!.name },
        text: m.text,
        replyTo: replyTo ?? null,
        needsReply: !!m.needsReply,
        delivery: m.delivery ?? "steer",
        sentAt: Date.now(),
      };
      const dir = join(MESSAGES, t.id);
      mkdirSync(dir, { recursive: true });
      writeAtomic(dir, `${id}.json`, msg);
      ids.push(id);
      count(t.id, "sent");
      if (m.needsReply) await startWatch(t, id);
    }
    return ids;
  };

  /**
   * Stops a child: SIGTERM, then SIGKILL after 5 s (a created pane closes with its pi). Its watch
   * is dropped first: an `exited` ending would only wake us for what we just did.
   */
  const stop = (a: Agent) => {
    stopped().add(a.id);
    watches().delete(a.id);
    armDeadline();
    refresh();
    try {
      process.kill(a.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      if (readAgent(a.id)?.pid === a.pid && alive(a.pid))
        try {
          process.kill(a.pid, "SIGKILL");
        } catch {}
    }, 5000).unref();
  };

  /** Opens a popup attached to another session's agent; an agent in this herdr session is focused. */
  const attach = async (a: Agent) => {
    if (!ctx || !me) return;
    if (a.herdr.socket === me.herdr.socket)
      return rpc(socket, "pane.focus", { pane_id: a.herdr.pane }).catch((err) =>
        ctx?.ui.notify(`herdr: ${err.message}`, "error"),
      );
    const marker = join(ATTACHED, a.id);
    const command =
      `M=${q(marker)}; trap 'rm -f "$M"' EXIT; echo $$ > "$M"; ` +
      `HERDR_SOCKET_PATH=${q(a.herdr.socket)} herdr agent attach ${q(a.herdr.pane)} --takeover`;
    try {
      await rpc(socket, "plugin.pane.open", {
        plugin_id: PLUGIN,
        entrypoint: "attach",
        env: { POPUP_COMMAND: command },
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code !== "plugin_not_found") return ctx.ui.notify(`herdr: ${e.message}`, "error");
      ctx.ui.notify(
        `The herdr plugin ${PLUGIN} isn't installed. Install it with:\n  herdr plugin install hkandala/pi-hkandala/herdr/plugin\n` +
          `Or attach in a terminal:\n  HERDR_SOCKET_PATH=${q(a.herdr.socket)} herdr agent attach ${a.herdr.pane}`,
        "warning",
      );
    }
  };

  // ---- Tools ----

  const text = (t: string) => ({
    content: [{ type: "text" as const, text: t }],
    details: undefined,
  });
  const ToList = Type.Union([Type.String(), Type.Array(Type.String())], {
    description: "An agent id (or its last 8 characters) or name, or a list of them",
  });
  const MessageParam = (needsReply: boolean, description: string) =>
    Type.Object(
      {
        text: Type.String({ description: "The message (up to 32 KB; send paths for more)" }),
        needsReply: Type.Optional(
          Type.Boolean({
            description: `You want an answer: it's asked to reply, and you're woken when it replies or stops working (default ${needsReply})`,
          }),
        ),
        delivery: Type.Optional(
          StringEnum(["steer", "followUp", "immediate"], {
            description:
              '"steer" (default): at its next tool call. "followUp": after its current turn. "immediate": aborts its current turn first.',
          }),
        ),
      },
      { description },
    );

  const line = async (a: Agent) => {
    const f = follows.get(a.id);
    const s = f?.status ?? (await status(a));
    return [
      short(a.id),
      label(a),
      f ? `${s} ${duration(Date.now() - f.since)}` : s,
      tilde(a.cwd),
      a.parent === me?.id && "child",
      watches().has(a.id) && "watched",
    ]
      .filter(Boolean)
      .join("  ");
  };
  // Registered in this order, the order of the tools list in the system prompt.
  pi.registerTool({
    name: "agent_start",
    label: "agent start",
    description:
      "Start a pi agent in its own herdr pane and send it a message, or resume a stopped one by its session id. Returns at once; you are woken when it replies or stops working.",
    promptSnippet: "Start or resume a pi agent",
    executionMode: "sequential",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description: "A unique name, e.g. reviewer. Required unless you resume a session.",
        }),
      ),
      session: Type.Optional(
        Type.String({ description: "A session id to resume (agent_stop prints it)" }),
      ),
      message: Type.Optional(
        MessageParam(
          true,
          "What to tell it: everything it needs, in your own words. For a resumed agent, the next message. Required unless you resume a session.",
        ),
      ),
      model: Type.Optional(
        Type.String({
          description: `provider/model (default: ${config.model ?? "your current model"}). Only when the user names one.`,
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: `Thinking level (default: ${config.thinking ?? "yours"}). Only when the user names one.`,
        }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working directory (default: yours, or the session's)" }),
      ),
      placement: Type.Optional(
        Type.String({
          description: `Where it runs (default ${config.placement}). Leave unset: "hidden" is a separate herdr session, out of the user's way. "tab" only when the user wants it as a tab in their herdr session; a pane id (e.g. w1:p3) only when the user names a pane.`,
        }),
      ),
    }),
    async execute(_id, params, signal, _u, c) {
      if (!me) throw new Error("pi-herd isn't registered in this session.");
      const resumed = params.session ? findSession(params.session) : undefined;
      if (!resumed && (!params.name || !params.message))
        throw new Error("name and message are required unless you resume a session.");
      const agents = liveAgents();
      if (resumed && agents.some((a) => a.id === resumed.id))
        throw new Error(`Session ${resumed.id} is already live.`);
      if (params.name && agents.some((a) => label(a) === params.name))
        throw new Error(`An agent named "${params.name}" is live; pick another name.`);
      const cwd = resolve(c.cwd, params.cwd ?? resumed?.cwd ?? ".");
      if (!existsSync(cwd)) throw new Error(`No such directory: ${cwd}`);
      const name = params.name ?? (resumed && (resumed.name || derived(resumed.id)));
      const where = params.placement ?? config.placement;
      // A resumed session keeps its own model and thinking level unless the call names them.
      const model =
        params.model ??
        (resumed ? undefined : (config.model ?? (c.model && `${c.model.provider}/${c.model.id}`)));
      const thinking =
        params.thinking ?? (resumed ? undefined : (config.thinking ?? pi.getThinkingLevel()));
      const env = { PI_HERD_PARENT: me.id, PI_HERD_NAME: name!, ...NO_STALL };
      const flags = [
        ...(resumed ? ["--session", resumed.file] : []),
        ...(params.name ? ["--name", params.name] : []),
        // Trust only what the user already trusts: a folder inside this trusted project.
        ...(inside(c.cwd, cwd) && c.isProjectTrusted() ? ["--approve"] : []),
        ...(model ? ["--model", model] : []),
        ...(thinking ? ["--thinking", thinking] : []),
        ...config.args,
      ]
        .map(q)
        .join(" ");

      // 1. The pane.
      let sock = socket;
      let target: string;
      let created = true;
      if (where === "hidden") {
        await ensureServer();
        sock = HIDDEN;
        const { workspaces } = await rpc(sock, "workspace.list");
        const ws = (workspaces as { workspace_id: string; label: string }[]).find(
          (w) => w.label === tilde(cwd),
        );
        if (ws) {
          const r = await rpc(sock, "tab.create", {
            workspace_id: ws.workspace_id,
            cwd,
            label: name,
            env,
            focus: false,
          });
          target = r.root_pane.pane_id;
        } else {
          const r = await rpc(sock, "workspace.create", {
            cwd,
            label: tilde(cwd),
            env,
            focus: false,
          });
          await rpc(sock, "tab.rename", { tab_id: r.tab.tab_id, label: name });
          target = r.root_pane.pane_id;
        }
      } else if (where === "tab") {
        const { pane: mine } = await rpc(sock, "pane.get", { pane_id: pane });
        const r = await rpc(sock, "tab.create", {
          workspace_id: mine.workspace_id,
          cwd,
          label: name,
          env,
          focus: false,
        });
        target = r.root_pane.pane_id;
      } else {
        created = false;
        target = where;
        const info = await rpc(sock, "pane.get", { pane_id: target }).catch(() => undefined);
        if (!info) throw new Error(`No pane ${target} in your herdr session.`);
        if (info.pane.agent) throw new Error(`Pane ${target} already runs ${info.pane.agent}.`);
        const { process_info: p } = await rpc(sock, "pane.process_info", { pane_id: target });
        if (p.foreground_process_group_id !== p.shell_pid)
          throw new Error(
            `Pane ${target} is busy (${p.foreground_processes?.[0]?.name ?? "a command"} is running).`,
          );
      }

      // 2. Start pi: exec in a pane we created (it closes with pi); in a given pane the shell stays.
      const cmd = created
        ? `exec pi ${flags}`
        : `${params.cwd || resumed ? `cd ${q(cwd)} && ` : ""}${Object.entries(env)
            .map(([k, v]) => `${k}=${q(v)}`)
            .join(" ")} pi ${flags}`;
      const fail = async (why: string) => {
        const screen = await capture(sock, target, config.captureLines);
        if (created) await rpc(sock, "pane.close", { pane_id: target }).catch(() => {});
        else {
          const { process_info: p } = await rpc(sock, "pane.process_info", {
            pane_id: target,
          }).catch(() => ({}) as any);
          for (const proc of p?.foreground_processes ?? [])
            if (proc.pid !== p.shell_pid)
              try {
                process.kill(proc.pid, "SIGTERM");
              } catch {}
        }
        return new Error(`${why}${screen ? `\nScreen:\n${screen}` : ""}`);
      };
      try {
        await rpc(sock, "pane.send_input", { pane_id: target, text: cmd, keys: ["enter"] });
      } catch (err) {
        throw await fail(`herdr: ${(err as Error).message}`);
      }

      // 3. Wait for its registration: that is real readiness.
      const child = await new Promise<Agent | undefined>((done) => {
        const check = () => {
          const a = liveAgents().find((x) => x.herdr.pane === target && x.herdr.socket === sock);
          if (a) finish(a);
        };
        const finish = (a?: Agent) => {
          waiters.delete(check);
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          done(a);
        };
        const onAbort = () => finish();
        const timer = setTimeout(finish, SPAWN_WAIT);
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.add(check);
        check();
      });
      if (!child)
        throw await fail(
          signal?.aborted
            ? "Aborted."
            : `${name} didn't register within 30 s (a trust dialog, or pi-herd not loaded).`,
        );

      // 4. The first message, watched.
      const m = params.message;
      if (m) await send([child], { ...m, needsReply: m.needsReply ?? true });
      const at = where === "hidden" ? `herdr session ${SESSION}, pane ${target}` : `pane ${target}`;
      return text(
        `${resumed ? "Resumed" : "Started"} ${label(child)} (${short(child.id)}) in ${at}.` +
          (!m
            ? " Message it with agent_send."
            : (m.needsReply ?? true)
              ? " You'll be woken when it replies or stops working; don't poll."
              : " No reply was asked for, so you won't be woken."),
      );
    },
  });

  pi.registerTool({
    name: "agent_stop",
    label: "agent stop",
    description:
      "Stop agents you started, or that they started. Prints each one's session id, to resume it with agent_start. Other agents can only be messaged.",
    promptSnippet: "Stop agents you started",
    parameters: Type.Object({
      ids: Type.Union([Type.Literal("all"), ToList], {
        description: 'Agent ids or names, or "all" (every agent you started)',
      }),
    }),
    async execute(_id, { ids }) {
      if (!me) throw new Error("pi-herd isn't registered in this session.");
      // "all": the agents this one started; theirs stop with them.
      const targets = ids === "all" ? children() : resolveAll(refs(ids), descendants());
      targets.forEach(stop);
      const lines = targets.map(
        (a) =>
          `Stopped ${label(a)}.` +
          (a.session && existsSync(a.session)
            ? ` To resume it: agent_start({ session: "${a.id}" })`
            : " It has no saved session to resume."),
      );
      return {
        content: [{ type: "text" as const, text: lines.join("\n") || "No agents to stop." }],
        details: { stopped: targets.length },
      };
    },
  });

  pi.registerTool({
    name: "agent_send",
    label: "agent send",
    description:
      "Send a message to other pi agents. With message.needsReply, you're woken when they reply or stop working.",
    promptSnippet: "Message other pi agents",
    promptGuidelines: [brief(config.watchTimeoutMinutes)],
    parameters: Type.Object({
      to: ToList,
      message: MessageParam(false, "The message"),
      replyTo: Type.Optional(Type.String({ description: "The id of the message this answers" })),
    }),
    async execute(_id, { to, message, replyTo }) {
      if (!me) throw new Error("pi-herd isn't registered in this session.");
      const ids = await send(resolveAll(refs(to)), message, replyTo);
      return text(
        `Sent: ${ids.join(", ")}.` +
          (message.needsReply
            ? " You'll be woken when it replies or stops working; don't poll."
            : ""),
      );
    },
  });

  pi.registerTool({
    name: "agent_watch",
    label: "agent watch",
    description:
      "Wake me when agents stop working, message me, or exit. Returns at once; an agent that isn't working isn't watched.",
    promptSnippet: "Watch other pi agents until they stop working",
    parameters: Type.Object({
      to: ToList,
      timeout: Type.Optional(
        Type.Number({ description: `Minutes (default ${config.watchTimeoutMinutes}; 0: none)` }),
      ),
    }),
    async execute(_id, { to, timeout }) {
      if (!me) throw new Error("pi-herd isn't registered in this session.");
      const out: string[] = [];
      for (const a of resolveAll(refs(to))) {
        if (a.id === me.id) throw new Error("Can't watch yourself.");
        const s = await startWatch(a, undefined, timeout ?? config.watchTimeoutMinutes);
        out.push(
          s === "working"
            ? `Watching ${label(a)}. You'll be woken when it stops working; don't poll.`
            : `${label(a)} is ${s}, not watched. Last text:\n${await lastText(a, config.captureLines)}`,
        );
      }
      return text(out.join("\n\n"));
    },
  });

  pi.registerTool({
    name: "agent_read",
    label: "agent read",
    description:
      "Read what an agent has been doing: its recent transcript (default), or what its pane shows now (screen), plus its status, parent, cwd and pane.",
    promptSnippet: "Read what pi agents are doing",
    parameters: Type.Object({
      ids: ToList,
      transcript: Type.Optional(
        Type.Boolean({
          description:
            "Its recent messages and tool calls (default true; false: just its last text)",
        }),
      ),
      screen: Type.Optional(
        Type.Boolean({
          description: "What its herdr pane shows now, e.g. a dialog it waits on (default false)",
        }),
      ),
    }),
    async execute(_id, { ids, transcript: withTranscript = true, screen }) {
      const out: string[] = [];
      for (const a of resolveAll(refs(ids))) {
        const p = a.parent ? readAgent(a.parent) : undefined;
        const parts = [
          await line(a),
          `parent: ${a.parent ? `${p ? label(p) : "gone"} (${short(a.parent)})` : "none"}`,
          `pane: ${a.herdr.pane}${a.herdr.socket === HIDDEN ? ` (herdr session ${SESSION})` : ""}`,
        ];
        // The transcript ends with the last text; without it, the last text alone.
        if (!withTranscript)
          parts.push(`last text:\n${(await lastText(a, config.captureLines, KB)) || "(none)"}`);
        if (withTranscript)
          parts.push(
            `transcript:\n${await transcript(a, config.transcriptMessages, config.captureLines)}`,
          );
        if (screen)
          parts.push(
            `screen:\n${(await capture(a.herdr.socket, a.herdr.pane, config.captureLines)) || "(empty)"}`,
          );
        out.push(parts.join("\n"));
      }
      return text(out.join("\n\n"));
    },
  });

  pi.registerTool({
    name: "agent_list",
    label: "agent list",
    description: "List live pi agents, newest first: id, name, status, cwd.",
    promptSnippet: "List pi agents",
    parameters: Type.Object({
      scope: Type.Optional(
        StringEnum(["children", "cwd", "all"], {
          description:
            '"children" (default): the agents you started; what you want almost always. "cwd": agents in this folder or below. "all": every agent, also other sessions\' (rarely needed).',
        }),
      ),
    }),
    async execute(_id, { scope = "children" }, _s, _u, c) {
      if (!me) throw new Error("pi-herd isn't registered in this session.");
      const others = liveAgents().filter((a) => a.id !== me!.id);
      const shown =
        scope === "all"
          ? others
          : scope === "cwd"
            ? others.filter((a) => inside(c.cwd, a.cwd))
            : children(others);
      const rows = [`${short(me.id)}  ${label(me)}  (you)  ${tilde(me.cwd)}`];
      rows.push(...(await Promise.all(shown.map(line))));
      if (scope === "children" && !shown.length)
        rows.push('No children; use scope "cwd" or "all".');
      return text(rows.join("\n"));
    },
  });

  pi.registerMessageRenderer(TYPE, renderer);
  pi.registerMessageRenderer(WATCHER, renderer);

  // ---- Commands ----

  pi.registerCommand("agents", {
    description: "List pi agents; pick one to attach to it in a herdr popup",
    handler: async (_args, c) => {
      if (!me) return c.ui.notify("pi-herd isn't registered in this session.", "info");
      const others = liveAgents().filter((a) => a.id !== me!.id);
      if (!others.length) return c.ui.notify("No other agents.", "info");
      const rows = await Promise.all(others.map(line));
      const choice = await c.ui.select("Agents", rows);
      const a = others[rows.indexOf(choice ?? "")];
      if (a) await attach(a);
    },
  });
  pi.registerCommand("detach", {
    description: "Close the herdr popup showing this agent (it keeps running)",
    handler: async () => detach(),
  });
  pi.registerShortcut(config.detachKey as KeyId, {
    description: "Close the herdr popup showing this agent",
    handler: () => detach(),
  });

  // From pi-footer's agents tab.
  pi.events.on("herd:attach", (data) => {
    const a = readAgent((data as { id: string }).id);
    if (a && alive(a.pid)) void attach(a);
  });
  pi.events.on("herd:stop", (data) => {
    const a = descendants().find((x) => x.id === (data as { id: string }).id);
    if (a) stop(a);
  });

  // ---- Lifecycle ----

  pi.on("session_start", (event, c) => {
    ctx = c;
    if (c.mode !== "tui") {
      pi.setActiveTools(pi.getActiveTools().filter((t) => !TOOLS.includes(t)));
      return;
    }
    const id = c.sessionManager.getSessionId();
    const old = readAgent(id);
    if (old && old.pid !== process.pid && alive(old.pid)) {
      pi.setActiveTools(pi.getActiveTools().filter((t) => !TOOLS.includes(t)));
      return c.ui.notify(
        `pi-herd is off: this session is already live as pid ${old.pid}.`,
        "warning",
      );
    }
    if (g.me !== id || event.reason !== "reload") {
      g.queued = new Set();
      g.watches = new Map();
      g.counts = new Map();
      g.ended = new Map();
      g.stopped = new Set();
      g.listed = new Map();
      g.watched = new Set();
      g.since = new Map();
    }
    // Endings queued when the old runtime stopped weren't sent: let them fire again.
    for (const w of watches().values()) w.ending = false;
    g.me = id;
    mkdirSync(AGENTS, { recursive: true });
    me = {
      id,
      name: pi.getSessionName(),
      pid: process.pid,
      cwd: c.cwd,
      startedAt: old?.pid === process.pid ? old.startedAt : Date.now(),
      parent: parentId,
      herdr: { socket, pane },
      session: c.sessionManager.getSessionFile(),
    };
    writeAtomic(AGENTS, `${id}.json`, me);
    busy = !c.isIdle();
    g.herdr = undefined; // refresh() emits the current value
    lastUpdate = "";
    watchDir(join(MESSAGES, id), () => scan(), BATCH_MS);
    watchDir(AGENTS, onAgents);
    watchDir(ATTACHED, onAttached);
    // A crashed parent leaves its record, and fs.watch can't see a process die.
    if (parentId) parentTimer = setInterval(() => parentAlive() || die(), 2000);
    scan();
    onAgents();
    onAttached();
    armDeadline();
    // At most once a day, whoever starts first: the stamp is written before the cleanup runs.
    let last = 0;
    try {
      last = statSync(STAMP).mtimeMs;
    } catch {}
    if (Date.now() - last > DAY) {
      writeFileSync(STAMP, "");
      void cleanup().catch(() => {});
    }
  });

  pi.on("session_info_changed", (event) => {
    if (!me || me.name === event.name) return;
    me.name = event.name;
    writeAtomic(AGENTS, `${me.id}.json`, me);
  });

  pi.on("agent_start", () => {
    busy = true;
    clearTimeout(waking);
    waking = undefined;
    refresh();
  });
  pi.on("agent_settled", () => {
    busy = false;
    const items = afterSettle;
    afterSettle = [];
    if (items.length)
      deliver(
        {
          customType: TYPE,
          content: items.map(itemText).join("\n\n"),
          display: true,
          details: { items },
        },
        "steer",
      );
    refresh();
  });

  // A message reaching the model: mark it delivered, so its sender's watch arms (checkDelivered).
  pi.on("message_start", (event) => {
    const m = event.message as { role?: string; customType?: string; details?: { items?: Item[] } };
    if (!me || m.role !== "custom" || m.customType !== TYPE) return;
    for (const it of m.details?.items ?? [])
      if (it.kind === "message")
        try {
          writeFileSync(join(MESSAGES, me.id, `${it.msg.id}.delivered`), "");
        } catch {}
  });

  pi.on("session_shutdown", (event) => {
    for (const w of watchers) w.close();
    watchers = [];
    for (const f of follows.values()) f.stop();
    follows.clear();
    waiters.clear();
    clearTimeout(flushTimer);
    // Messages not yet delivered are taken in again by the next runtime.
    for (const it of [...outbox, ...afterSettle])
      if (it.kind === "message") queued().delete(it.msg.id);
    outbox = [];
    afterSettle = [];
    clearTimeout(deadlineTimer);
    clearTimeout(waking);
    clearInterval(parentTimer);
    waking = undefined;
    if (me && event.reason !== "reload") {
      if (readAgent(me.id)?.pid === process.pid) rm(agentFile(me.id));
      g.watches = new Map();
      g.queued = new Set();
      g.counts = new Map();
      g.ended = new Map();
      g.stopped = new Set();
      g.listed = new Map();
      g.watched = new Set();
      g.since = new Map();
      g.me = undefined;
    }
    me = ctx = undefined;
  });
}
