/**
 * The files every agent shares in ~/.pi/agent/pi-herd/: agents/<id>.json (who is live),
 * messages/<toId>/<msgId>.json (one file per message), attached/<pid> (a popup shell and the agent
 * it shows), stopped/<id> (it was stopped, or ended with the agent that started it).
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import friendly from "friendly-words";
import { createHash } from "node:crypto";
import {
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
export const STAMP = join(DIR, ".cleanup");
export const DAY = 86_400_000;

export type Agent = {
  id: string;
  name?: string;
  pid: number;
  cwd: string;
  startedAt: number;
  parent?: string;
  herdr: { socket: string; pane: string };
  session?: string;
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
/** Writes a file atomically: a dot-named temp file, then rename. */
export const writeAtomic = (path: string, name: string, data: unknown) => {
  const tmp = join(path, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, join(path, name));
};

export const agentFile = (id: string) => join(AGENTS, `${id}.json`);
export const readAgent = (id: string) => readJson<Agent>(agentFile(id));
/** Live agents (the record exists and its pid runs), newest first. */
export const liveAgents = () =>
  list(AGENTS)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .map((f) => readJson<Agent>(join(AGENTS, f)))
    .filter((a): a is Agent => !!a?.id && alive(a.pid))
    .sort((a, b) => b.startedAt - a.startedAt);

/**
 * Daily: deletes dead records, old messages, stale popup markers, and stop markers of dead agents
 * older than 7 days; closes orphaned panes.
 */
export async function cleanup() {
  for (const f of list(AGENTS)) {
    const a = readJson<Agent>(join(AGENTS, f));
    // Re-read just before unlink, so a record a restarted session just wrote survives.
    if (a && !alive(a.pid) && readJson<Agent>(join(AGENTS, f))?.pid === a.pid) rm(join(AGENTS, f));
  }
  const live = liveAgents();
  for (const to of list(MESSAGES)) {
    const dir = join(MESSAGES, to);
    // Named <epochMs>-…; a write's leftover temp file starts with a dot.
    for (const f of list(dir))
      if (Date.now() - parseInt(f.replace(/^\./, "")) > 7 * DAY) rm(join(dir, f));
    try {
      if (!live.some((a) => a.id === to)) rmdirSync(dir); // fails unless empty
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
