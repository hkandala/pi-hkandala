/**
 * What a tool call shows: its summary wording, its target and the other params it passed, and,
 * once settled, what came back (counts, an exit code). No state but per-result caches, and
 * WORDING, which the summary line extends with an entry per other tool.
 */
import { homedir } from "node:os";
import { untab } from "./code.ts";

export type Node = { children?: Node[] };
type Result = {
  content: { type: string; text?: string }[];
  details?: { diff?: string; durationMs?: number }; // durationMs: a tool's own measure (pi-bash-bg)
};
export type Tool = Node & {
  toolName: string;
  toolCallId: string;
  args?: Record<string, unknown>;
  result?: Result & { isError?: boolean; timestamp?: number };
  isPartial: boolean;
  expanded: boolean;
  executionStarted: boolean;
  hideComponent: boolean;
  cwd: string;
  ui: Node & { requestRender(): void };
};

type State = "running" | "done" | "error";

/**
 * Summary wording per tool: [verb, noun, plural noun]; no noun: the verb alone, uncounted. Others
 * read "ran <tool> N times".
 */
export type Wording = [string, string, string?];
const SEARCHED: Wording = ["searched", "pattern"];
const RAN: Wording = ["ran", "command"];
const TALKED: Wording = ["talked to", "agent"];
const CHECKED: Wording = ["checked agents", ""];
export const WORDING: Record<string, Wording> = {
  read: ["read", "file"],
  edit: ["edited", "file"],
  write: ["wrote", "file"],
  bash: RAN,
  codemode: RAN, // and its script's calls count as their own
  // pi-bash-bg's tools count as commands too.
  bash_list: RAN,
  bash_watch: RAN,
  grep: SEARCHED,
  find: SEARCHED,
  ls: ["listed", "directory", "directories"],
  // pi-web's tools; web_fetch counts pages, not calls (one call fetches up to 10).
  web_search: ["searched the web", "time"],
  web_fetch: ["fetched", "web page"],
  // pi-herd's tools count agents, not calls (one call can name several).
  agent_start: ["started", "agent"],
  agent_send: TALKED,
  agent_watch: TALKED,
  agent_read: CHECKED,
  agent_list: CHECKED,
  agent_stop: ["stopped", "agent"],
};
export const HERD_TOOLS = new Set([
  "agent_start",
  "agent_send",
  "agent_watch",
  "agent_read",
  "agent_list",
  "agent_stop",
]);
/** Agents a pi-herd call names: its to/ids list, or (agent_stop "all") how many it stopped. */
export const agentsIn = (t: Tool) => {
  const v = t.args?.to ?? t.args?.ids;
  if (Array.isArray(v)) return v.length;
  const stopped = (t.result as { details?: { stopped?: number } } | undefined)?.details?.stopped;
  return v === "all" ? (stopped ?? 1) : 1;
};

export const str = (v: unknown) => (typeof v === "string" ? v : "");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const lineCount = (s: string) => (s ? s.replace(/\n$/, "").split("\n").length : 0);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const stateOf = (t: Tool): State =>
  t.result?.isError ? "error" : t.result && !t.isPartial ? "done" : "running";

/** Per-result caches: rows render every frame, and pi replaces the result object on each update. */
function cached<T>(compute: (r: Result) => T) {
  const cache = new WeakMap<Result, T>();
  return (r: Result) => {
    if (!cache.has(r)) cache.set(r, compute(r));
    return cache.get(r)!;
  };
}
/**
 * Escapes (OSC, CSI) and control characters but tab and newline, which pi's own renderers strip
 * from output too: a read file or a fetched page can hold any.
 */
const UNSAFE =
  // oxlint-disable-next-line no-control-regex
  /\x1b\][\s\S]*?(?:\x07|\x1b\\|\x9c)|[\x1b\x9b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g;
const outputOf = cached((r) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => (c.text ?? "").replace(UNSAFE, ""))
    .join("\n")
    .trimEnd(),
);
const output = (t: Tool) => (t.result ? outputOf(t.result) : "");
export const linesOf = cached((r) => (outputOf(r) ? untab(outputOf(r)).split("\n") : []));

function shortPath(path: string, cwd: string) {
  if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path;
}

/** Params a tool's target shows; other tools' target is their first string param. */
const IN_TARGET: Record<string, string[]> = {
  read: ["path", "file_path", "offset"],
  bash: ["command"],
  grep: ["pattern", "path"],
  find: ["pattern", "path"],
  ls: ["path"],
  web_fetch: ["urls"],
  bash_watch: ["pid"],
};
export const HERD_MESSAGE = new Set(["agent_start", "agent_send"]); // tools with pi-herd's message
const OPTION_WIDTH = 40; // closed, longer (or multi-line) values show just their name

/**
 * The params the call passed that its target leaves out: "key value", "key" for true, false ones
 * dropped, lists joined. Closed rows cut big values to their name; `full` shows them whole.
 * Edits and writes have none: their content shows as the diff or the code.
 */
export function options(t: Tool, full: boolean): string {
  const a = t.args ?? {};
  if (t.toolName === "edit" || t.toolName === "write") return "";
  const shown = IN_TARGET[t.toolName] ?? [Object.keys(a).find((k) => typeof a[k] === "string")];
  return Object.entries(a)
    .filter(([k, v]) => !shown.includes(k) && v !== undefined && v !== null && v !== false)
    .map(([k, v]) => {
      if (v === true) return k;
      // pi-herd's message object: its text shows open as markdown; closed, only its flags.
      if (k === "message" && HERD_MESSAGE.has(t.toolName) && typeof v === "object") {
        const m = v as { delivery?: string; needsReply?: boolean };
        const flags = [
          m.delivery !== "steer" && m.delivery,
          m.needsReply !== undefined && `needsReply ${m.needsReply}`,
        ];
        return [k, ...flags].filter(Boolean).join(" · ");
      }
      const flat = Array.isArray(v) && v.every((x) => typeof x !== "object");
      const text = flat ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
      const big = text.includes("\n") || text.length > OPTION_WIDTH;
      return full || !big ? `${k} ${text}` : k;
    })
    .join(" · ");
}

/** What a call targets and, once settled, what came back. */
export function describe(t: Tool): [target: string, result: string] {
  const a = t.args ?? {};
  const out = output(t);
  const path = shortPath(str(a.path ?? a.file_path), t.cwd);
  const within = a.path ? ` in ${path}` : "";
  const target = (() => {
    switch (t.toolName) {
      case "read":
        return a.offset ? `${path}:${a.offset}` : path;
      case "bash":
        return oneLine(str(a.command));
      case "grep":
      case "find":
        return `${str(a.pattern)}${within}`;
      case "ls":
        return path || ".";
      case "edit":
      case "write":
        return path;
      case "web_fetch":
        return oneLine(Array.isArray(a.urls) ? a.urls.join(" ") : "");
      case "bash_watch":
        return a.pid === undefined ? "" : `pid ${a.pid}`;
      default:
        return oneLine(str(Object.values(a).find((v) => typeof v === "string")));
    }
  })();
  const state = stateOf(t);
  if (state === "error") {
    const exit = out.match(/exit(?:ed with)? code (\d+)/i)?.[1];
    return [target, exit ? `exit ${exit}` : "error"];
  }
  if (t.toolName === "write") return [target, `+${lineCount(str(a.content))}`];
  if (state === "running") return [target, ""];
  // Counts output lines, so pi's truncation notes count too.
  switch (t.toolName) {
    case "read":
      return [target, plural(lineCount(out), "line")];
    case "edit": {
      const diff = t.result?.details?.diff ?? "";
      const added = diff.match(/^\+/gm)?.length ?? 0;
      const removed = diff.match(/^-/gm)?.length ?? 0;
      return [target, diff ? `+${added} -${removed}` : ""];
    }
    case "grep":
      // Match lines read "file:N: text" ("file:N:text" for some greps); context lines "file-N- text".
      return [target, plural(out.match(/^.+?:\d+:/gm)?.length ?? 0, "match", "matches")];
    case "find":
      return [target, plural(out.startsWith("No files") ? 0 : lineCount(out), "file")];
    case "ls":
      return [target, plural(out.startsWith("(empty") ? 0 : lineCount(out), "entry", "entries")];
    default:
      return [target, ""];
  }
}

type Call = {
  id: string;
  name: string;
  args?: string;
  status: string;
  durationMs?: number;
  error?: string;
};
type Calls = {
  details?: { calls?: Call[] };
  nestedCalls?: { calls?: { id: string; arguments?: Record<string, unknown> }[] };
};

/** Args from pi's preview: JSON cut to 200 characters (then its first string param), or a model. */
function parseArgs(s = ""): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  const [, k, v] = /^\{"([^"]+)":"((?:[^"\\]|\\.)*)/.exec(s) ?? [];
  if (!k) return { value: s };
  try {
    return { [k]: JSON.parse(`"${v}"`) };
  } catch {
    return { [k]: v };
  }
}

/**
 * The calls a codemode script made, in order: pi lists them in its result's details. `live` holds
 * the ones seen running in this session, by id, with their whole args and results. The others
 * (history, model calls) have only how they ended: pi keeps no results for them (`clStatus`), and
 * the whole args only in a saved result's nestedCalls.
 */
export function nestedOf(t: Tool, live: Map<string, Tool>): Tool[] {
  const r = t.result as Calls | undefined;
  const whole = new Map(r?.nestedCalls?.calls?.map((c) => [c.id, c.arguments]));
  let n = 0;
  return (r?.details?.calls ?? []).map((c) => {
    // Tool calls read `<id>/<n>`, numbered in order (`<id>/?` until they end); model calls
    // `<id>/<name>/<n>`.
    const tool = c.id.slice(t.toolCallId.length).split("/").length === 2;
    const id = tool && c.id.endsWith("/?") ? `${t.toolCallId}/${n + 1}` : c.id;
    if (tool) n++;
    const found = live.get(id);
    if (found) return found;
    const running = c.status === "running";
    return {
      toolName: c.name,
      toolCallId: id,
      args: whole.get(id) ?? parseArgs(c.args),
      cwd: t.cwd,
      isPartial: running,
      result: running
        ? undefined
        : { content: [{ type: "text", text: c.error ?? "" }], isError: c.status === "error" },
      clStatus: c.status,
      // Its duration, as a start and end (timesOf reads them).
      ...(c.durationMs === undefined ? {} : { clStart: 1, clEnd: 1 + c.durationMs }),
    } as unknown as Tool;
  });
}
