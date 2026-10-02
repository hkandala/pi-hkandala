/**
 * pi-herd: every pi session running in a herdr pane is an agent that others can list, message,
 * watch, and start and stop agents of its own (and theirs).
 *
 * Files: store.ts (the shared folder), herdr.ts (its socket API), transcript.ts, text.ts (what
 * agents read, and its renderer), dashboard.ts (/agents dashboard). Status comes only from herdr (its pi integration, plus the repo's patch
 * in herdr/). A message is a steer that wakes an idle agent; a watch wakes the watcher when the
 * target stops working. Tools: agent_start, agent_stop, agent_send, agent_watch, agent_read,
 * agent_list. Commands: /agents, /detach.
 * An agent without a name gets a two-word one derived from its session id (frog-thunder).
 * Config (optional): ~/.pi/agent/extensions/pi-herd.json. See docs/SPEC.md for the design.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  isKeyRelease,
  Key,
  type KeyId,
  matchesKey,
  Spacer,
  Text,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { AgentsDashboard, FULL_SCREEN, type Row } from "./dashboard.ts";
import { execFile } from "node:child_process";
import {
  existsSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import net from "node:net";
import { join, relative, resolve } from "node:path";
import { ensureServer, HIDDEN, parseLine, PLUGIN, rpc, SESSION } from "./herdr.ts";
import {
  AGENTS,
  alive,
  allAgents,
  ATTACHED,
  cleanup,
  DAY,
  derived,
  isLive,
  label,
  list,
  liveAgents,
  MESSAGES,
  readAgent,
  readJson,
  rm,
  SESSIONS,
  short,
  STAMP,
  STOPPED,
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
const checkSize = (text: string) => {
  if (Buffer.byteLength(text) > MESSAGE_MAX)
    throw new Error("Message over 32 KB: write it to a file and send the path.");
};
const SPAWN_WAIT = 30_000;
const BATCH_MS = 250; // messages and watch endings this close together share one steer
const CLOSE_HINT = "ctrl+b q or /detach to close"; // in a popup
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
  // agents it has watched, and below them the agents they started. Ended ones stay: when they
  // ended, and whether they were stopped (a stopped/<id> marker).
  listed?: Map<string, Agent>;
  watched?: Set<string>;
  ended?: Map<string, { at: number; stopped: boolean }>;
  since?: Map<string, number>; // when each followed agent's status last changed (for the footer)
  grouped?: Map<string, { group: number; at: number }>; // when each listed agent entered its group
  herdr?: boolean;
  removedTools?: string[]; // the agent tools this process removed (a session where pi-herd is off)
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
  };
  // Each key the user sets, when it has the default's type (model, thinking: a string or null;
  // args: strings); otherwise the default.
  const user = readJson<Record<string, unknown>>(join(getAgentDir(), "extensions", "pi-herd.json"));
  for (const [k, d] of Object.entries(config)) {
    const v = user?.[k];
    if (
      d === null
        ? v === null || typeof v === "string"
        : Array.isArray(d)
          ? Array.isArray(v) && v.every((x) => typeof x === "string")
          : typeof v === typeof d
    )
      Object.assign(config, { [k]: v });
  }

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
  let tui: TUI | undefined; // pi's TUI, from the widget (for ← on an empty prompt)
  let boxed = false; // pi-footer's prompt box is up: it shows the popup's hint as its placeholder
  let stopInput: (() => void) | undefined;
  let lastUpdate = "";
  let rows: Row[] = []; // the listed agents in first-listed order, for the dashboard
  let dashboard: (() => void) | undefined; // redraws the open dashboard
  let closeDashboard: (() => void) | undefined; // closes it (on shutdown: its timers stop)
  const waiters = new Set<() => void>(); // agent_start waits for a registration
  /** herdr status of children and watched agents, from one event subscription each. */
  const follows = new Map<
    string,
    { agent: Agent; status: Status; since: number; stop: () => void }
  >();

  /**
   * herd:update's order (pi-footer's agents tab): working, then any other live status, then ended;
   * in each group, by when the agent entered it (a newcomer goes last; g.grouped keeps the times).
   */
  const byGroup = (list: Row[]) => {
    const entered = (g.grouped ??= new Map());
    const group = (st: string) =>
      st === "working" ? 0 : st === "stopped" || st === "exited" ? 2 : 1;
    const now = Date.now();
    for (const a of list)
      // A new follow starts `unknown` (after /reload too): that isn't a move between groups.
      if (
        !(a.state === "unknown" && entered.has(a.id)) &&
        entered.get(a.id)?.group !== group(a.state)
      )
        entered.set(a.id, { group: group(a.state), at: now });
    const key = (a: Row) => entered.get(a.id)!;
    return [...list].sort((x, y) => key(x).group - key(y).group || key(x).at - key(y).at);
  };

  /** A new session's state (not on /reload, which keeps it). */
  const reset = () =>
    Object.assign(g, {
      queued: new Set(),
      watches: new Map(),
      counts: new Map(),
      ended: new Map(),
      listed: new Map(),
      watched: new Set(),
      since: new Map(),
      grouped: new Map(),
    });
  const watches = () => (g.watches ??= new Map());
  const counts = () => (g.counts ??= new Map());
  const ended = () => (g.ended ??= new Map());
  const listed = () => (g.listed ??= new Map());
  const watched = () => (g.watched ??= new Set());
  const count = (id: string, key: "sent" | "received") => {
    const c = counts().get(id) ?? { sent: 0, received: 0 };
    c[key]++;
    counts().set(id, c);
  };
  const queued = () => (g.queued ??= new Set());
  const children = (agents = liveAgents()) => agents.filter((a) => me && a.parent === me.id);
  /** Whether `a` is below this agent in the tree of agents started with agent_start (byId: the tree). */
  const below = (a: Agent, byId: Map<string, Agent>) => {
    for (let p = a.parent, n = 0; p && n < 100; p = byId.get(p)?.parent, n++)
      if (p === me?.id) return true;
    return false;
  };
  const descendants = () => {
    const agents = liveAgents();
    const byId = new Map(agents.map((x) => [x.id, x]));
    return agents.filter((a) => below(a, byId));
  };

  /** This session's cost so far, counted as pi-footer does: every response and usage entry. */
  const ownCost = (c: ExtensionContext) => {
    type Usage = { cost?: { total?: number } };
    type E = { type: string; usage?: Usage; message?: { role: string; usage?: Usage } };
    let sum = 0;
    for (const e of c.sessionManager.getEntries() as E[]) {
      const m = e.type === "message" && e.message?.role !== "user" ? e.message : undefined;
      sum += (e.type === "usage" ? e.usage : m?.usage)?.cost?.total ?? 0;
    }
    return sum;
  };
  /** Puts this session's cost in its record, for the agents above it to add up. */
  const publishCost = (c: ExtensionContext) => {
    const cost = ownCost(c);
    if (!me || cost === me.cost) return;
    me.cost = cost;
    writeAtomic(AGENTS, `${me.id}.json`, me);
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
    // The agents this one started and the ones it has watched, and below them the agents they
    // started (any depth). Listed ones that are gone stay listed, as stopped or done (like
    // finished jobs).
    const all = allAgents();
    const agents = all.filter(isLive);
    // Every agent started below this one (any depth), live or ended: their costs add to this one's.
    const byId = new Map(all.map((a) => [a.id, a]));
    const subs = all.filter((a) => below(a, byId));
    const live = new Map(
      agents.filter((a) => a.parent === me!.id || watched().has(a.id)).map((a) => [a.id, a]),
    );
    // Ended ones this process never saw (the session was resumed): from their records.
    for (const a of subs.filter((x) => x.ended && !listed().has(x.id)).reverse()) {
      listed().set(a.id, a);
      ended().set(a.id, { at: a.ended!, stopped: existsSync(join(STOPPED, a.id)) });
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const a of agents)
        // Also under a listed agent that ended: until its own record goes (by then it has marked
        // itself stopped), an agent whose parent just ended is still live.
        if (!live.has(a.id) && a.parent && (live.has(a.parent) || listed().has(a.parent))) {
          live.set(a.id, a);
          grew = true;
        }
    }
    // New ones are listed in the order they started (liveAgents() is newest first).
    for (const a of [...live.values()].sort((x, y) => x.startedAt - y.startedAt)) {
      listed().set(a.id, a);
      ended().delete(a.id); // resumed
    }
    for (const id of listed().keys())
      if (!live.has(id) && !ended().has(id)) {
        const at = byId.get(id)?.ended ?? Date.now();
        ended().set(id, { at, stopped: existsSync(join(STOPPED, id)) });
      }
    for (const [id, f] of follows)
      if (!live.has(id)) {
        f.stop();
        follows.delete(id);
      }
    for (const a of live.values()) if (!follows.has(a.id)) follow(a);
    const n = [...watches().values()].filter((w) => !w.ending).length;
    // In first-listed order for the dashboard; herd:update sends them grouped (pi-footer's order).
    rows = [...listed().values()].map((a) => {
      const f = follows.get(a.id);
      const e = ended().get(a.id);
      return {
        id: a.id,
        name: label(a),
        // herdr's status while it is live; once it ended, stopped or exited.
        state: e ? (e.stopped ? "stopped" : "exited") : (f?.status ?? "unknown"),
        since: e?.at ?? f?.since ?? a.startedAt,
        live: !e,
        cwd: a.cwd,
        parent: a.parent,
        mine: below(a, listed()), // started by this agent, at any depth
        watched: watches().has(a.id),
        sent: counts().get(a.id)?.sent ?? 0,
        received: counts().get(a.id)?.received ?? 0,
      };
    });
    const update = {
      agents: byGroup(rows),
      watching: n,
      waiting: busy ? 0 : n,
      // The agents below this one, ended ones too: what they cost, and how many.
      subagents: {
        cost: subs.reduce((sum, a) => sum + (typeof a.cost === "number" ? a.cost : 0), 0),
        count: subs.length,
      },
      // While a popup shows this agent: pi-footer's prompt box shows it as its placeholder.
      placeholder: inPopup() ? CLOSE_HINT : undefined,
    };
    const json = JSON.stringify(update);
    if (json !== lastUpdate) pi.events.emit("herd:update", update);
    lastUpdate = json;
    dashboard?.();
    // Working while watches run, also during the turn (herdr publishes idle when the turn settles,
    // before this could say otherwise), and while a message or an ending waits for its steer (an
    // ending's watch stays in watches() until then): an agent watching this one would take any
    // idle as finished.
    const active = watches().size > 0 || !!waking || afterSettle.length > 0 || outbox.length > 0;
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
      // Not when a newer message re-armed it meanwhile (it waits for that one's delivery).
      if (w.armed && !w.awaiting && idle(await status(a))) void end(w, "idle");
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

  /** An agent's status: its follow's, unless that hasn't heard from herdr yet (after /reload). */
  const statusOf = async (a: Agent) => {
    const s = follows.get(a.id)?.status;
    return s && s !== "unknown" ? s : status(a);
  };

  /** Queues a steer item; items within BATCH_MS share one steer. */
  const post = (it: Item) => {
    if (!me) return; // an old runtime's late ending, after /reload
    outbox.push(it);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, BATCH_MS);
  };
  const flush = () => {
    if (!me) return;
    const items = outbox;
    outbox = [];
    // Drop the watches this steer ends; others marked ending may still be gathering their ending.
    for (const it of items) {
      const id = it.kind === "watch" ? it.agent.id : it.endsWatch ? it.msg.from.id : undefined;
      if (id && watches().get(id)?.ending) watches().delete(id);
    }
    if (!items.length) return;
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
    if (!me || w.ending || watches().get(w.agent.id) !== w) return;
    w.ending = true;
    armDeadline();
    refresh();
    const a = w.agent;
    const it: Item = { kind: "watch", event, agent: { id: a.id, name: a.name } };
    try {
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
        it.status = await statusOf(a);
        it.after = duration(w.minutes * 60_000);
        it.transcript = await transcript(a, config.transcriptMessages, config.captureLines);
      }
    } catch {} // a broken session file: the ending goes out with what was read
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
      return "working"; // watched (agent_watch reports it so)
    }
    const s = await statusOf(a);
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
      if (typeof msg.text !== "string" || typeof msg.from?.id !== "string") continue; // broken
      msg.id = id; // the file's name: its .delivered marker and replies use it
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
    for (const id of watches().keys()) if (!isLive(readAgent(id))) void endExited(id);
    for (const w of waiters) w();
    refresh();
  };
  const parentAlive = () => !parentId || isLive(readAgent(parentId));
  /** A stopped/<id> marker: lists show the agent as stopped once it ends. Never blocks a stop. */
  const markStopped = (id: string) => {
    try {
      writeFileSync(join(STOPPED, id), "");
    } catch {}
  };
  /** Agents die with the agent that started them: SIGTERM ourselves so pi shuts down cleanly. */
  let dying = false;
  const die = () => {
    if (dying) return;
    dying = true;
    if (me) markStopped(me.id); // ends as stopped
    process.kill(process.pid, "SIGTERM");
  };

  /**
   * A popup shows this agent while a live popup shell's marker, attached/<its pid>, names it (its
   * first line; then the socket and pane it attaches to). Dead shells' markers are removed.
   */
  const onAttached = () => {
    if (!me || !ctx) return;
    popupPid = undefined;
    for (const f of list(ATTACHED)) {
      const pid = parseInt(f);
      if (!alive(pid)) rm(join(ATTACHED, f));
      else if (markerAgent(join(ATTACHED, f)) === me.id) popupPid = pid;
    }
    refresh(); // the placeholder
    tui?.requestRender();
  };
  /** A popup shows this agent (its shell is alive: a SIGKILLed one leaves its marker behind). */
  const inPopup = () => !!popupPid && alive(popupPid);
  /** ← on an empty prompt opens the dashboard: only when the prompt has the keys, outside a popup. */
  const onKey = (data: string) => {
    if (isKeyRelease(data) || !matchesKey(data, Key.left) || !tui || tui.hasOverlay()) return;
    if (inPopup()) return;
    // Not a selector or another dialog (getFocusedComponent: on pi's TUI, not in its type).
    const focused = (
      tui as { getFocusedComponent?: () => { getText?: () => string } | null }
    ).getFocusedComponent?.();
    if (typeof focused?.getText !== "function" || focused.getText() !== "") return;
    void openDashboard().catch(() => {}); // a shutdown meanwhile
    return { consume: true };
  };
  /** A marker's first line: the agent the popup shows. */
  const markerAgent = (path: string) => {
    try {
      return readFileSync(path, "utf8").split("\n")[0];
    } catch {
      return undefined;
    }
  };
  const detach = () => {
    if (!inPopup()) return ctx?.ui.notify("Not shown in a pi-herd popup.", "info");
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
    checkSize(m.text);
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
    markStopped(a.id); // so every list shows it as stopped
    watches().delete(a.id);
    armDeadline();
    refresh();
    try {
      process.kill(a.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      if (alive(a.pid))
        // pi-herd's record may already be gone while pi hangs
        try {
          process.kill(a.pid, "SIGKILL");
        } catch {}
    }, 5000).unref();
  };

  /**
   * Views an agent: in a popup showing this agent, that popup switches to it (the marker names it,
   * and ending the current attach makes the popup's loop attach it); otherwise it opens a popup,
   * whichever herdr session the agent is in.
   */
  const attach = async (a: Agent) => {
    if (!ctx || !me) return;
    if (inPopup()) {
      try {
        writeFileSync(
          join(ATTACHED, String(popupPid)),
          `${a.id}\n${a.herdr.socket}\n${a.herdr.pane}\n${label(a)}\n`,
        );
      } catch {
        return ctx.ui.notify("Can't switch the popup to that agent.", "warning");
      }
      execFile("pkill", ["-TERM", "-P", String(popupPid)], () => {});
      return;
    }
    // The shell attaches to the agent its marker names, again after a switch (a new agent there);
    // when an attach ends any other way (detach, the agent exits), the popup closes. Before each
    // attach it sizes the agent's pane to the popup (herdr keeps the size after a release) and
    // gives pi 200 ms to redraw, behind an "opening …" line: the attach then shows a settled
    // screen instead of a redraw at the new size. A signal exits through the EXIT trap (dash runs
    // it only so) to remove the marker.
    const command =
      `M=${q(ATTACHED)}/$$; trap 'rm -f "$M"' EXIT; trap 'exit 1' HUP INT TERM; ` +
      `printf '%s\\n' ${q(a.id)} ${q(a.herdr.socket)} ${q(a.herdr.pane)} ${q(label(a))} > "$M"; ` +
      `while { read -r ID; read -r S; read -r P; read -r N; } < "$M" && [ -n "$P" ]; do ` +
      `printf '\\033[2J\\033[H\\n  \\033[2mopening %s…\\033[0m' "$N"; set -- $(stty size); ` +
      `{ sleep 0.2; echo '{"type":"terminal.release"}'; } | HERDR_SOCKET_PATH="$S" ` +
      `herdr terminal session control "$P" --takeover --rows "$1" --cols "$2" >/dev/null 2>&1; ` +
      `HERDR_SOCKET_PATH="$S" herdr agent attach "$P" --takeover; ` +
      `{ read -r NEXT; } < "$M"; [ "$NEXT" != "$ID" ] || break; done`;
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

  /** Live agents other than this one: its children (default), in `cwd` or below, or all. */
  const scoped = (scope: string, cwd: string) => {
    const others = liveAgents().filter((a) => a.id !== me?.id);
    if (scope === "all") return others;
    return scope === "cwd" ? others.filter((a) => inside(cwd, a.cwd)) : children(others);
  };
  /** agent_stop and /agents stop: "all" is this agent's children (theirs stop with them). */
  const stopMany = (ids: "all" | string[]) => {
    const targets = ids === "all" ? children() : resolveAll(ids, descendants());
    targets.forEach(stop);
    const lines = targets.map(
      (a) =>
        `Stopped ${label(a)}.` +
        (a.session && existsSync(a.session)
          ? ` To resume it: agent_start({ session: "${a.id}" })`
          : " It has no saved session to resume."),
    );
    return { lines, stopped: targets.length };
  };

  /** Views or stops an agent by id (pi-footer's tab, the dashboard). */
  const attachId = (id: string) => {
    const a = readAgent(id);
    if (isLive(a)) void attach(a);
  };
  const stopId = (id: string) => {
    const a = descendants().find((x) => x.id === id);
    if (a) stop(a);
  };
  /** An agent's status, and how long it has had it when followed (`working 3m12s`). */
  const statusText = async (a: Agent) => {
    const f = follows.get(a.id);
    const s = await statusOf(a);
    return f ? `${s} ${duration(Date.now() - f.since)}` : s;
  };
  /** How this agent relates to `a`: it started it, it watches it. */
  const tags = (a: Agent) =>
    [a.parent === me?.id && "child", watches().has(a.id) && "watched"].filter(Boolean) as string[];

  /** The /agents dashboard, over the whole screen until esc. */
  const openDashboard = async () => {
    if (!ctx || ctx.mode !== "tui" || !me || dashboard) return;
    if (inPopup()) return ctx.ui.notify(`Close the popup first: ${CLOSE_HINT}.`, "info");
    dashboard = () => {}; // open: a second ← during the first read below does nothing
    // Other sessions' live agents aren't followed: their status is read every 2 s while open.
    const statuses = new Map<string, Status>();
    // Read with the statuses, not per frame (it reads every agent's file). Other agents: the live
    // ones, and the ended ones below them (like ended agents of yours, shown with e).
    let others: Agent[] = [];
    const ended = new Map<string, Status | "stopped">(); // the ended ones among them
    let polling = false;
    const poll = async () => {
      if (polling) return; // a slow herdr: skip, don't pile up
      polling = true;
      const all = allAgents().filter((a) => a.id !== me?.id && !listed().has(a.id));
      const list = all.filter(isLive);
      const shown = new Set(list.map((a) => a.id));
      for (let grew = true; grew;) {
        grew = false;
        for (const a of all)
          if (!shown.has(a.id) && a.parent && shown.has(a.parent)) {
            shown.add(a.id);
            grew = true;
          }
      }
      others = all.filter((a) => shown.has(a.id));
      ended.clear();
      for (const a of others)
        if (!isLive(a)) ended.set(a.id, existsSync(join(STOPPED, a.id)) ? "stopped" : "exited");
      const read = await Promise.all(list.map(status));
      list.forEach((a, i) => statuses.set(a.id, read[i]!));
      polling = false;
      dashboard?.();
    };
    const timer = setInterval(poll, 2000);
    try {
      // The first read before the page shows (at most 300 ms): otherwise it opens with them all
      // `unknown`, and the counts and statuses change a moment later.
      await Promise.race([poll(), new Promise((r) => setTimeout(r, 300))]);
      if (!ctx || !me) return; // shut down meanwhile
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        dashboard = () => tui.requestRender();
        closeDashboard = done;
        return new AgentsDashboard(
          tui,
          theme,
          () => ({
            self: {
              id: me!.id,
              name: label(me!),
              state: busy || g.herdr ? "working" : "idle", // as herdr shows it
              since: 0,
              live: true,
              cwd: me!.cwd,
              mine: false,
              watched: false,
              self: true,
              sent: 0,
              received: 0,
            },
            agents: rows,
            // Oldest first, like the agents above (liveAgents() is newest first).
            others: others
              .filter((a) => !listed().has(a.id)) // listed since the last read
              .reverse()
              .map((a) => ({
                id: a.id,
                name: label(a),
                state: ended.get(a.id) ?? statuses.get(a.id) ?? "unknown",
                since: 0, // only your agents show a time
                live: !ended.has(a.id),
                cwd: a.cwd,
                parent: a.parent,
                mine: false,
                watched: false,
                sent: counts().get(a.id)?.sent ?? 0,
                received: counts().get(a.id)?.received ?? 0,
              })),
          }),
          { attach: attachId, stop: stopId },
          done,
        );
      }, FULL_SCREEN);
    } finally {
      clearInterval(timer);
      dashboard = closeDashboard = undefined;
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

  const line = async (a: Agent) =>
    [short(a.id), label(a), await statusText(a), tilde(a.cwd), ...tags(a)].join("  ");
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
          description:
            "A unique name that says what it works on: 2 to 4 words in kebab-case, e.g. auth-test-fixer. Required unless you resume a session.",
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
      if (params.message) checkSize(params.message.text); // before anything starts
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
      const env = { PI_HERD_PARENT: me.id, ...NO_STALL };
      // Trust only what the user already trusts: a folder inside this trusted project (real
      // paths, so a symlink out of it doesn't count).
      const trusted = () => {
        try {
          return inside(realpathSync(c.cwd), realpathSync(cwd)) && c.isProjectTrusted();
        } catch {
          return false;
        }
      };
      const flags = [
        // Its sessions (also a /new in it) go to pi-herd's folder: out of the user's /resume list.
        "--session-dir",
        SESSIONS,
        ...(resumed ? ["--session", resumed.file] : []),
        ...(params.name ? ["--name", params.name] : []),
        ...(trusted() ? ["--approve"] : []),
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
      let rename: string | undefined; // a new workspace's tab
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
          rename = r.tab.tab_id; // named with the launch below: a failure there closes the pane
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
        if (rename) await rpc(sock, "tab.rename", { tab_id: rename, label: name });
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
        if (signal?.aborted) finish(); // aborted before the wait started
        else check();
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
      const { lines, stopped } = stopMany(ids === "all" ? "all" : refs(ids));
      return {
        content: [{ type: "text" as const, text: lines.join("\n") || "No agents to stop." }],
        details: { stopped },
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
      const targets = resolveAll(refs(to));
      if (targets.some((a) => a.id === me!.id)) throw new Error("Can't watch yourself.");
      for (const a of targets) {
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
      const shown = scoped(scope, c.cwd);
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

  // /agents list prints agents like /background list does jobs: a framed entry, not sent to the model.
  const loadedAt = Date.now();
  pi.registerEntryRenderer<{ title: string; rows: string[][] }>(
    "pi-herd-list",
    (entry, _o, theme) => {
      if (Date.parse(entry.timestamp) < loadedAt) return undefined;
      const dim = (s: string) => theme.fg("dim", s);
      const { title, rows: list = [] } = entry.data!;
      const lines = list.map(
        ([name, id, state, cwd, tags]) =>
          `${dim("•")} ${theme.fg("accent", name!)} ${dim(id!)} ${theme.fg("text", `· ${state} · ${cwd}`)}` +
          (tags ? ` ${theme.fg("accent", `· ${tags}`)}` : ""),
      );
      const box = new Container();
      box.addChild(new DynamicBorder());
      box.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
      box.addChild(new Spacer(1));
      box.addChild(new Text(lines.join("\n") || dim("No matching agents."), 1, 0));
      box.addChild(new DynamicBorder());
      return box;
    },
  );

  const SCOPES = ["children", "cwd", "all"];
  const USAGE = "Usage: /agents [list [children|cwd|all] | stop <id|name ...|all> | dashboard]";
  pi.registerCommand("agents", {
    description: "List pi agents, stop yours, or open the agents dashboard",
    getArgumentCompletions: (prefix) => {
      const [sub = "", ...rest] = prefix.split(/\s+/);
      const options = (head: string, last: string, all: string[]) => {
        const items = all.filter((o) => o.startsWith(last));
        return items.length ? items.map((o) => ({ value: `${head}${o}`, label: o })) : null;
      };
      if (!rest.length) return options("", sub, ["list", "stop", "dashboard"]);
      if (sub === "list" && rest.length === 1) return options("list ", rest[0]!, SCOPES);
      if (sub === "stop")
        return options(
          `stop ${rest
            .slice(0, -1)
            .map((r) => `${r} `)
            .join("")}`,
          rest.at(-1)!,
          [...descendants().map(label), "all"],
        );
      return null;
    },
    handler: async (args, c) => {
      if (!me) return c.ui.notify("pi-herd isn't registered in this session.", "info");
      const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === "dashboard") return openDashboard();
      if (sub === "stop") {
        if (!rest.length) return c.ui.notify(USAGE, "warning");
        try {
          const { lines } = stopMany(rest[0] === "all" ? "all" : rest);
          return c.ui.notify(lines.join("\n") || "No agents to stop.", "info");
        } catch (err) {
          return c.ui.notify((err as Error).message, "warning");
        }
      }
      if (sub !== "list" || (rest[0] && !SCOPES.includes(rest[0])))
        return c.ui.notify(USAGE, "warning");
      const scope = rest[0] ?? "children";
      const shown = scoped(scope, c.cwd);
      pi.appendEntry("pi-herd-list", {
        title: `Agents · ${scope === "children" ? "started by this session" : scope === "cwd" ? "in this folder" : "all"}`,
        rows: await Promise.all(
          shown.map(async (a) => [
            label(a),
            short(a.id),
            await statusText(a),
            tilde(a.cwd),
            tags(a).join(" · "),
          ]),
        ),
      });
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

  pi.events.on("footer:box", () => (boxed = true));
  // From pi-footer's agents tab.
  pi.events.on("herd:attach", (data) => attachId((data as { id: string }).id));
  pi.events.on("herd:stop", (data) => stopId((data as { id: string }).id));

  // ---- Lifecycle ----

  /** Off in this session: no tools, and herdr hears no pending work from here. */
  const off = () => {
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => !TOOLS.includes(t)));
    g.removedTools = [
      ...new Set([...(g.removedTools ?? []), ...active.filter((t) => TOOLS.includes(t))]),
    ];
    if (g.herdr) emitHerdr(false);
    // pi-footer and pi-working drop the last session's agents.
    pi.events.emit("herd:update", {
      agents: [],
      watching: 0,
      waiting: 0,
      subagents: { cost: 0, count: 0 },
    });
  };
  pi.on("session_start", (event, c) => {
    ctx = c;
    if (c.mode !== "tui") return off();
    const id = c.sessionManager.getSessionId();
    const old = readAgent(id);
    if (isLive(old) && old.pid !== process.pid) {
      off();
      return c.ui.notify(
        `pi-herd is off: this session is already live as pid ${old.pid}.`,
        "warning",
      );
    }
    // Back on (after a session that was off in this process): the tools again.
    if (g.removedTools) {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...g.removedTools])]);
      g.removedTools = undefined;
    }
    if (g.me !== id || event.reason !== "reload") reset();
    // Endings queued when the old runtime stopped weren't sent: let them fire again.
    for (const w of watches().values()) w.ending = false;
    g.me = id;
    mkdirSync(AGENTS, { recursive: true });
    mkdirSync(STOPPED, { recursive: true });
    rm(join(STOPPED, id)); // live again (resumed)
    me = {
      id,
      name: pi.getSessionName(),
      pid: process.pid,
      cwd: c.cwd,
      startedAt: old?.pid === process.pid && !old.ended ? old.startedAt : Date.now(),
      parent: parentId,
      herdr: { socket, pane },
      session: c.sessionManager.getSessionFile(),
      cost: ownCost(c),
    };
    writeAtomic(AGENTS, `${id}.json`, me);
    busy = !c.isIdle();
    g.herdr = undefined; // refresh() emits the current value
    lastUpdate = "";
    watchDir(join(MESSAGES, id), () => scan(), BATCH_MS);
    watchDir(AGENTS, onAgents);
    watchDir(ATTACHED, onAttached);
    // Right-aligned above the prompt while a popup shows this agent; it also hands over pi's TUI
    // (taken once per session: after pi's TUI-mode switch in /settings, /reload brings ← back).
    c.ui.setWidget("pi-herd", (t, theme) => {
      tui = t;
      return {
        invalidate() {},
        render: (width: number) => {
          if (!inPopup() || boxed) return []; // pi-footer's box shows it as the placeholder
          const hint = theme.fg("warning", CLOSE_HINT);
          return [" ".repeat(Math.max(0, width - visibleWidth(hint) - 3)) + hint];
        },
      };
    });
    // After the other extensions' listeners (pi-footer's tabs use ← while they have the keys).
    // That holds while they register synchronously in session_start, as pi-footer does.
    setTimeout(() => {
      if (me?.id === id) stopInput = c.ui.onTerminalInput(onKey);
    });
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
    // A woken run: stay working one macrotask more, until herdr's integration (which may load
    // after pi-herd) has heard agent_start too.
    if (waking)
      waking = setTimeout(() => {
        waking = undefined;
        refresh();
      });
    refresh();
  });
  pi.on("turn_end", (_e, c) => publishCost(c));
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

  pi.on("session_shutdown", (event, c) => {
    closeDashboard?.();
    stopInput?.();
    stopInput = undefined;
    for (const w of watchers) w.close();
    watchers = [];
    for (const f of follows.values()) f.stop();
    follows.clear();
    waiters.clear();
    clearTimeout(flushTimer);
    // Messages not yet delivered are taken in again by the next runtime.
    for (const it of [...outbox, ...afterSettle])
      if (it.kind === "message") {
        queued().delete(it.msg.id);
        const c = counts().get(it.msg.from.id);
        if (c) c.received--; // counted again when taken in again
      }
    outbox = [];
    afterSettle = [];
    clearTimeout(deadlineTimer);
    clearTimeout(waking);
    clearInterval(parentTimer);
    waking = undefined;
    if (me && event.reason !== "reload") {
      // The record stays, ended: the agents above it still list it and count its cost.
      if (readAgent(me.id)?.pid === process.pid)
        writeAtomic(AGENTS, `${me.id}.json`, { ...me, cost: ownCost(c), ended: Date.now() });
      reset();
      g.me = undefined;
      g.herdr = undefined; // the next session's runtime starts with nothing pending
    }
    me = ctx = undefined;
  });
}
