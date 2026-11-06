/**
 * The files every agent shares in ~/.pi/agent/pi-herd/: agents/<id>.json (every agent, live or
 * ended), messages/<toId>/<msgId>.json (one file per message), attached/<pid> (a popup shell and
 * the agent it shows), stopped/<id> (it was stopped, or ended with the agent that started it),
 * sessions/ (the pi sessions of the agents agent_start starts: out of the user's /resume list),
 * children/<id>.jsonl (the agents an agent started or resumed, never cleaned up), costs.json (a cache of session files' costs),
 * .cleanup (when the daily cleanup last ran).
 * Also the agents' derived names, the agents below one and their costs, and the cleanup.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import friendly from "friendly-words";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HIDDEN, rpc } from "./herdr.ts";

const DIR = join(getAgentDir(), "pi-herd");
export const AGENTS = join(DIR, "agents");
export const MESSAGES = join(DIR, "messages");
export const ATTACHED = join(DIR, "attached");
export const STOPPED = join(DIR, "stopped");
export const SESSIONS = join(DIR, "sessions");
export const CHILDREN = join(DIR, "children");
const COSTS = join(DIR, "costs.json");
const STAMP = join(DIR, ".cleanup");
const DAY = 86_400_000;

export type Agent = {
  id: string;
  name?: string;
  pid: number;
  cwd: string;
  startedAt: number;
  parent?: string;
  herdr: { socket: string; pane: string };
  session?: string;
  ended?: number; // when its session ended: the record stays for its parents' lists
};

export const short = (id: string) => id.slice(-8);
/** Two words from the session id, the same every time: a name for agents that have none. */
export const derived = (id: string) => {
  const h = createHash("sha256").update(id).digest();
  const words: string[] = friendly.objects;
  return `${words[h.readUInt32BE(0) % words.length]}-${words[h.readUInt32BE(4) % words.length]}`;
};
export const label = (a: { id: string; name?: string }) => a.name || derived(a.id);
export const alive = (pid: number) => {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
export const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};
export const list = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const mtime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
};
export const rm = (path: string) => {
  try {
    unlinkSync(path);
  } catch {}
};
/** Writes a file atomically: a dot-named temp file of this process, then rename (many pi processes write
 * the same file: a shared temp name lets one rename another's file away). */
export const writeAtomic = (path: string, name: string, data: unknown) => {
  const tmp = join(path, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, join(path, name));
};

const parse = (line: string) => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};
/** The complete lines a file gained after byte `at`, and the byte after them. */
const linesFrom = (path: string, at: number) => {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(Math.max(0, fstatSync(fd).size - at));
      readSync(fd, buf, 0, buf.length, at);
      const end = buf.lastIndexOf(10) + 1;
      return { lines: buf.toString("utf8", 0, end).split("\n").slice(0, -1), at: at + end };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { lines: [] as string[], at };
  }
};

/** `a` started (or resumed) under `parent`: a line in children/<parent>.jsonl, which only grows. */
export const addStarted = (parent: string, a: Agent) =>
  appendFileSync(
    join(CHILDREN, `${parent}.jsonl`),
    `${JSON.stringify({ id: a.id, session: a.session })}\n`,
  );
// Each children file as read so far: its agents' session files, by id.
const read = new Map<string, { at: number; kids: Map<string, string> }>();
const childrenOf = (id: string) => {
  const path = join(CHILDREN, `${id}.jsonl`);
  const c = read.get(path) ?? { at: 0, kids: new Map<string, string>() };
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {}
  if (size <= c.at) return c.kids;
  const r = linesFrom(path, c.at);
  for (const l of r.lines) {
    const e = parse(l);
    if (typeof e?.id === "string") c.kids.set(e.id, typeof e.session === "string" ? e.session : "");
  }
  c.at = r.at;
  read.set(path, c);
  return c.kids;
};
/** The session files of every agent started below `id` (any depth, live or ended, each once). */
const startedBelow = (id: string) => {
  const found = new Map<string, string>([[id, ""]]);
  for (const p of found.keys())
    for (const [k, session] of childrenOf(p)) if (!found.has(k)) found.set(k, session);
  found.delete(id);
  return [...found.values()];
};
// Each session file's cost and how far it was read (pi only appends), kept in costs.json, a cache
// every agent shares: a big tree's files add up to gigabytes.
const costs = new Map<string, { at: number; cost: number }>(
  Object.entries(readJson<Record<string, { at: number; cost: number }>>(COSTS) ?? {}),
);
let saved = 0; // the first count saves at once
let dirty = false;
/** A pi session's cost from its file, summed as pi-footer sums its own. */
const sessionCost = (path: string) => {
  let c = costs.get(path) ?? { at: 0, cost: 0 };
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {}
  if (size === c.at) return c.cost;
  if (size < c.at) c = { at: 0, cost: 0 }; // written again
  const r = linesFrom(path, c.at);
  for (const l of r.lines) {
    const e = parse(l);
    const billed = ["usage", "compaction", "branch_summary"].includes(e?.type);
    const m = e?.type === "message" && e.message?.role !== "user" ? e.message : undefined;
    c.cost += (billed ? e.usage : m?.usage)?.cost?.total ?? 0;
  }
  c.at = r.at;
  costs.set(path, c);
  dirty = true;
  return c.cost;
};
/** The agents started below `id` (any depth, ended ones too): how many, and their sessions' cost. */
export const subagents = (id: string) => {
  const files = startedBelow(id);
  const cost = files.reduce((sum, f) => sum + sessionCost(f), 0);
  if (dirty && Date.now() - saved > 30_000) {
    try {
      writeAtomic(DIR, "costs.json", Object.fromEntries(costs)); // a cache: a failed write only costs a reread
    } catch {}
    saved = Date.now();
    dirty = false;
  }
  return { cost, count: files.length };
};

const agentFile = (id: string) => join(AGENTS, `${id}.json`);
/** A record this version can use (not a broken file, or another version's of a different shape). */
const valid = (a: unknown): a is Agent => {
  const x = a as Agent | undefined;
  return (
    typeof x?.id === "string" &&
    typeof x.pid === "number" &&
    typeof x.startedAt === "number" &&
    typeof x.cwd === "string" &&
    (x.name == null || typeof x.name === "string") &&
    typeof x.herdr?.socket === "string" &&
    typeof x.herdr.pane === "string"
  );
};
export const readAgent = (id: string) => {
  const a = readJson<Agent>(agentFile(id));
  return valid(a) ? a : undefined;
};
/** Live: its session hasn't ended and its pid runs. */
export const isLive = (a?: Agent): a is Agent => !!a && !a.ended && alive(a.pid);
export const writeAgent = (a: Agent) => writeAtomic(AGENTS, `${a.id}.json`, a);
export const isStopped = (id: string) => existsSync(join(STOPPED, id));
/** A stopped/<id> marker: lists show the agent as stopped once it ends. Never blocks a stop. */
export const markStopped = (id: string) => {
  try {
    writeFileSync(join(STOPPED, id), "");
  } catch {}
};
export const unmarkStopped = (id: string) => rm(join(STOPPED, id));
/** A record or message file's name (a write's temp file starts with a dot). */
export const isJson = (f: string) => f.endsWith(".json") && !f.startsWith(".");
// Each record file as last read, by name: re-read only once its stat changes (every write is a
// rename, a new inode). allAgents runs on every change in agents/, by any agent.
const parsed = new Map<string, { key: string; a: Agent | undefined }>();
/** Every record, live or ended, newest first. */
export const allAgents = () => {
  const names = list(AGENTS).filter(isJson);
  const kept = new Set(names);
  for (const f of parsed.keys()) if (!kept.has(f)) parsed.delete(f);
  const out: Agent[] = [];
  for (const f of names) {
    const path = join(AGENTS, f);
    let key: string;
    try {
      const st = statSync(path);
      key = `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      continue; // just removed
    }
    let e = parsed.get(f);
    if (e?.key !== key) parsed.set(f, (e = { key, a: readJson<Agent>(path) }));
    if (valid(e.a)) out.push(e.a);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
};
/** Live agents, newest first. */
export const liveAgents = () => allAgents().filter(isLive);

/**
 * Daily: deletes dead records (an ended session's after 7 days), old messages, stale popup markers,
 * and stop markers of dead agents older than 7 days; closes orphaned panes.
 */
export async function cleanup() {
  for (const f of list(AGENTS)) {
    const a = readJson<Agent>(join(AGENTS, f));
    const old = !a?.ended || Date.now() - a.ended > 7 * DAY; // a crash leaves no end time
    // Re-read just before unlink, so a record a restarted session just wrote survives.
    if (a && old && !isLive(a) && readJson<Agent>(join(AGENTS, f))?.pid === a.pid)
      rm(join(AGENTS, f));
  }
  const live = liveAgents();
  for (const to of list(MESSAGES)) {
    const dir = join(MESSAGES, to);
    // Named <epochMs>-…; a write's leftover temp file starts with a dot.
    for (const f of list(dir))
      if (Date.now() - parseInt(f.replace(/^\./, "")) > 7 * DAY) rm(join(dir, f));
    try {
      // Fails unless empty. Read again: an agent may have registered since `live` was read.
      if (!live.some((a) => a.id === to) && !isLive(readAgent(to))) rmdirSync(dir);
    } catch {}
  }
  for (const f of list(ATTACHED)) if (!alive(parseInt(f))) rm(join(ATTACHED, f)); // named by pid
  for (const id of list(STOPPED))
    if (!live.some((a) => a.id === id) && Date.now() - mtime(join(STOPPED, id)) > 7 * DAY)
      rm(join(STOPPED, id));
  // A pane in the dedicated session is an orphan when no live agent is registered for it, or its
  // agent's parent isn't live. Only what is an orphan on two checks a minute apart is closed.
  const orphans = async () => {
    const { panes = [] } = await rpc(HIDDEN, "pane.list").catch(() => ({}));
    const agents = liveAgents();
    return (panes as { pane_id: string }[])
      .map((p) => p.pane_id)
      .filter((pane) => {
        const a = agents.find((x) => x.herdr.socket === HIDDEN && x.herdr.pane === pane);
        return !a || (!!a.parent && !agents.some((x) => x.id === a.parent));
      });
  };
  const first = await orphans();
  if (!first.length) return;
  setTimeout(async () => {
    for (const pane of await orphans())
      if (first.includes(pane)) await rpc(HIDDEN, "pane.close", { pane_id: pane }).catch(() => {});
  }, 60_000).unref();
}

/** The cleanup at most once a day, whoever starts first: the stamp is written before it runs. */
export function cleanupDaily() {
  let last = 0;
  try {
    last = statSync(STAMP).mtimeMs;
  } catch {}
  if (Date.now() - last > DAY) {
    writeFileSync(STAMP, "");
    void cleanup().catch(() => {});
  }
}
