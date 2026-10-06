/**
 * The job store: the files in ~/.pi/agent/bash-bg/, each job's state, and its end message.
 * No state but the two read-once caches. See docs/SPEC.md sections 1, 3 and 4.
 */

import { formatSize, getAgentDir, truncateTail } from "@earendil-works/pi-coding-agent";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { homedir, uptime } from "node:os";
import { join } from "node:path";
import { readTail, TAIL_BYTES } from "./viewer.ts";

export const DIR = join(getAgentDir(), "bash-bg");
const DAY = 86_400_000;
const COUNT_BYTES = 32 * 1024 * 1024; // a bigger log's lines aren't counted: it would block pi

export type Meta = {
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  sessionId: string;
};
/** code: undefined while running, null when it ended without one (kill -9, reboot). */
export type Job = Meta & { id: string; log: string; code?: number | null; endedAt?: number };

export const file = (id: string, ext: string) => join(DIR, `${id}.${ext}`);
export const readJson = (path: string): Record<string, any> => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};
const alive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
export const tilde = (p: string) =>
  p === homedir() || p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p;
export const oneLine = (cmd: string) => {
  const lines = cmd.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : lines[0]!;
};
const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m`;
};
const killed = (code: number) => code === 129 || code === 130 || code === 143;
export const state = (j: Job) =>
  j.code === undefined
    ? "running"
    : j.code === null
      ? "ended"
      : killed(j.code)
        ? "killed"
        : `exit ${j.code}`;
export const elapsed = (j: Job) => duration((j.endedAt ?? Date.now()) - j.startedAt);

/** Job ids whose file names end with the suffix, newest first. */
export const ids = (suffix: string) => {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(suffix))
      .map((f) => f.slice(0, f.indexOf(".")))
      .sort((a, b) => parseInt(b) - parseInt(a));
  } catch {
    return [];
  }
};

// Meta files never change and an ended job stays ended, so both are read once.
const metas = new Map<string, Meta>();
const ended = new Map<string, Job>();
export function job(id: string): Job | undefined {
  const done = ended.get(id);
  if (done) return done;
  let meta = metas.get(id);
  if (!meta) {
    const json = readJson(file(id, "json"));
    if (typeof json.pid !== "number") return undefined; // a foreground call, or not written yet
    metas.set(id, (meta = json as Meta));
  }
  const j: Job = { ...meta, id, log: file(id, "log") };
  const exitCode = () => {
    try {
      const text = readFileSync(file(id, "exit"), "utf8").trim(); // empty: being written
      return text ? Number(text) : undefined;
    } catch {
      return undefined;
    }
  };
  let code = exitCode();
  // A job started before the last boot has ended: its pid may be another process's by now.
  const booted = Date.now() - uptime() * 1000;
  if (code === undefined && meta.startedAt > booted && alive(meta.pid)) return j;
  code ??= exitCode(); // it may have exited between the two checks
  let endedAt = Date.now();
  try {
    endedAt = statSync(code === undefined ? j.log : file(id, "exit")).mtimeMs;
  } catch {}
  const result = { ...j, code: code ?? null, endedAt };
  ended.set(id, result);
  return result;
}
export const jobs = (list: string[]) => list.map(job).filter((j): j is Job => !!j);
export const byPid = (pid: number) => jobs(ids(".json")).find((j) => j.pid === pid);
export const terminate = (j: Job) => {
  try {
    process.kill(-j.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
};

/** Lines in a text, counted like lineCount. */
const textLines = (text: string) =>
  text.split("\n").length - (!text || text.endsWith("\n") ? 1 : 0);
/** Lines in a file, counted in 1MB chunks. */
function lineCount(path: string): number {
  let n = 0;
  let last = 10;
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(1024 * 1024);
    for (let read; (read = readSync(fd, buf, 0, buf.length, null)) > 0; last = buf[read - 1]!)
      for (let i = buf.indexOf(10); i !== -1 && i < read; i = buf.indexOf(10, i + 1)) n++;
    closeSync(fd);
  } catch {}
  return last === 10 ? n : n + 1;
}

export type Limits = { maxLines: number; maxBytes: number };
/** How a job ended: its output tail, capped like the bash tool's, and where the rest is. */
export function ending(j: Job, limits: Limits) {
  const { size, text } = readTail(j.log);
  const t = truncateTail(text, limits);
  const total =
    size <= TAIL_BYTES ? textLines(text) : size <= COUNT_BYTES ? lineCount(j.log) : undefined;
  const full = `Full output (${formatSize(size)}): ${j.log}`;
  return {
    pid: j.pid,
    command: j.command,
    code: j.code ?? null,
    state: state(j),
    elapsed: elapsed(j),
    output: t.content.replace(/\n$/, ""),
    note: t.lastLinePartial
      ? `[Showing the last ${formatSize(t.outputBytes)} of the last line. ${full}]`
      : total === undefined
        ? `[Showing the last ${t.outputLines} lines. ${full}]`
        : t.outputLines < total
          ? `[Showing the last ${t.outputLines} of ${total} lines. ${full}]`
          : undefined,
  };
}
export type Ending = ReturnType<typeof ending>;

/** The end message's text for the agent, shaped like a bash result. */
export function endText(e: Ending): string {
  const what =
    e.code === null
      ? "ended without an exit code"
      : killed(e.code)
        ? "was killed"
        : `exited with code ${e.code}`;
  const lines = [`Background job ${e.pid} \`${oneLine(e.command)}\` ${what} after ${e.elapsed}.`];
  if (e.output) lines.push(e.output);
  if (e.note) lines.push(e.note);
  if (e.code) lines.push(`Command exited with code ${e.code}`);
  return lines.join("\n");
}

/** Deletes finished jobs' files after 7 days and crashed foreground calls' after a day. */
export async function cleanup() {
  const files = await readdir(DIR).catch(() => [] as string[]);
  const byId = Map.groupBy(files, (f) => f.slice(0, f.indexOf(".")));
  for (const [id, names] of byId) {
    // An id starts with its creation time, so a job this young can't be old enough yet.
    if (Date.now() - parseInt(id) <= (names.includes(`${id}.json`) ? 7 * DAY : DAY)) continue;
    const j = names.includes(`${id}.json`) ? job(id) : undefined;
    // A foreground call ages from its log's last write: one can run for longer than a day.
    const lastWrite = j
      ? 0
      : await stat(file(id, "log")).then(
          (s) => s.mtimeMs,
          () => parseInt(id),
        );
    const old = j
      ? j.endedAt !== undefined && Date.now() - j.endedAt > 7 * DAY
      : Date.now() - lastWrite > DAY;
    if (!old) continue;
    for (const name of names) await unlink(join(DIR, name)).catch(() => {});
    metas.delete(id);
    ended.delete(id);
  }
}
