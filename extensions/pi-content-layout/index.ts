/**
 * pi-content-layout: a compact, minimal transcript.
 * - Tool calls and thinking between two pieces of assistant text form one group: a summary line
 *   ("Read 3 files, ran 2 commands") with a ├ └ tree of one-row calls under it, each its target and
 *   the other params passed ("grep  TODO in src · glob *.ts").
 *   Running calls show a live timer (and pulse, full screen), edits show their diff,
 *   the last bash call running 30s+ shows pi-bash-bg's "ctrl+shift+b to run in background" hint,
 *   failures are red. Code is colored by pi's own highlighter; diffs tint changed lines and mark
 *   the changed words.
 *   Click a row (fullscreen TUI mode) to open or close its content, which hangs off a └ under it,
 *   and its full input, each cut to 10 lines until their "↓ N more lines" line is clicked;
 *   ctrl+o opens or closes all tool rows, clicked ones too.
 * - Thinking is a tree row: "thinking…" while it streams, then "thought for Xs" (click or ctrl+t
 *   to open).
 * - User messages sit in a rounded border like pi-footer's prompt box; compaction and branch
 *   summaries, skills, and extension messages (pi's box or an extension's) in a dashed one,
 *   labeled in its top edge; click an extension's box (fullscreen) to open or close it.
 * - User bash (!cmd) and info panels (pi's or extensions') read like assistant text, without rules.
 * - Each piece of assistant text starts with a ● bullet (click it to copy the reply as markdown);
 *   summary lines align with its text, and so do status lines, notices, warnings, and errors,
 *   pi's or extensions' (without a bullet).
 * - ctrl+shift+o collapses or expands all groups to their summary line (saved); click a summary
 *   line for its own group.
 * - ctrl+shift+w wraps long lines of open tool content, or cuts them off with … (saved).
 * - ctrl+shift+t cycles timestamps (off, relative, absolute; saved): when messages, groups, and
 *   user bash happened, and how long tool calls took, in a column on the right.
 * - Copying a selection (full screen) leaves out the layout's decoration and rejoins wrapped text.
 *
 * Config (optional): ~/.pi/agent/extensions/pi-content-layout.json
 *   { "autoExpandedTools": ["edit", "write"], "maxExpandedLines": 10, "enableWordWrap": false,
 *     "collapseGroups": false,
 *     "timestamps": "off" | "relative" | "absolute", "timestampFormat": "24h" | "12h" }
 *
 * pi has no public API for restyling its own tool rows or messages, so this patches
 * methods of pi's exported components (restored on shutdown, and falling back to pi's own on any
 * error). It may need updates when pi's components change, and it conflicts with other extensions
 * that patch the same components.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  DynamicBorder,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  copyToClipboard,
  getAgentDir,
  getLanguageFromPath,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Key,
  Markdown,
  Text,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { between, diffOf, highlighted, numbered, rgbOf, untab } from "./code.ts";
import { copied } from "./copy.ts";

type Stamps = "off" | "relative" | "absolute";
type Config = {
  autoExpandedTools?: string[];
  maxExpandedLines?: number;
  enableWordWrap?: boolean;
  collapseGroups?: boolean;
  timestamps?: Stamps;
  timestampFormat?: "24h" | "12h";
};

type Node = { children?: Node[] };
type Proto = Record<string, any>; // oxlint-disable-line no-explicit-any
type Result = {
  content: { type: string; text?: string }[];
  details?: { diff?: string; durationMs?: number }; // durationMs: a tool's own measure (pi-bash-bg)
};
type Tool = Node & {
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
type Block = { type: string; text?: string; thinking?: string; id?: string };
type Message = { content: Block[]; timestamp?: number; stopReason?: string };
type Saved = { role: string; content?: string | Block[]; command?: string; timestamp?: number };
type Entry = { type: string; timestamp: string; message?: Saved };
type Session = { getEntries(): Entry[]; getBranch(): Entry[]; getLeafId(): string | null };
type Mouse = { type: string; button: string; x: number; y: number; width: number; height: number };
/** The parts of pi's full-screen TUI this uses. */
type FullScreen = {
  mode?: string;
  terminal?: { columns: number };
  copySelection?: (text: string) => unknown;
  getSelectionBounds?: () => { start: { col: number } } | undefined;
};
type State = "running" | "done" | "error";

/** Summary wording per tool: [verb, noun, plural noun]. Others read "ran <tool> N times". */
type Wording = [string, string, string?];
const SEARCHED: Wording = ["searched", "pattern"];
const RAN: Wording = ["ran", "command"];
const WORDING: Record<string, Wording> = {
  read: ["read", "file"],
  edit: ["edited", "file"],
  write: ["wrote", "file"],
  bash: RAN,
  // pi-bash-bg's tools count as commands too.
  bash_list: RAN,
  bash_watch: RAN,
  grep: SEARCHED,
  find: SEARCHED,
  ls: ["listed", "directory", "directories"],
  // pi-web's tools; web_fetch counts pages, not calls (one call fetches up to 10).
  web_search: ["searched the web", "time"],
  web_fetch: ["fetched", "web page"],
};

/** Terminal prompt marks (OSC 133) that pi puts around messages for jump-to-prompt. */
const mark = (code: string) => `\x1b]133;${code}\x07`;
// oxlint-disable-next-line no-control-regex
const marksOf = (line: string) => /^(?:\x1b\]133;[A-Z]\x07)*/.exec(line)![0];
/** Prefixes a line, keeping any leading prompt marks at column 0. */
function indent(line: string, prefix: string) {
  const marks = marksOf(line);
  return marks + prefix + line.slice(marks.length);
}

/** Arrays match when their items do: pi renders lines into fresh arrays. */
const same = (a: unknown, b: unknown) =>
  a === b ||
  (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]));
/**
 * compute(), cached on `node` under `key` while `deps` hold (the theme among them, for colors).
 * pi renders every component each frame, and open content can run to thousands of lines.
 */
function memo<T>(node: Proto, key: string, deps: unknown[], compute: () => T): T {
  const cache = node[key];
  if (cache && deps.every((d, i) => same(d, cache.deps[i]))) return cache.value;
  const value = compute();
  node[key] = { deps, value };
  return value;
}

/** Lines padded 1 column by pi, moved to column 3; `paint` colors a ● on the first text line. */
function bulleted(lines: string[], paint?: (s: string) => string): string[] {
  return lines.map((l) => {
    if (blank(l)) return l;
    const prefix = paint ? ` ${paint("●")}` : "  ";
    paint = undefined;
    return indent(l, prefix);
  });
}

/** Runs of blank lines (pi pads them with spaces) as one. */
const blank = (l: string) => !visibleWidth(l.replaceAll(" ", ""));
const tidy = (lines: string[]) => lines.filter((l, i) => !blank(l) || !i || !blank(lines[i - 1]!));

const configPath = () => join(getAgentDir(), "extensions", "pi-content-layout.json");
function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

// --- Timestamps ---------------------------------------------------------------------------------
// ctrl+shift+t cycles off → relative → absolute, saved to the config. Times sit in a column that
// ends 3 columns from the right: messages, summary lines, and panels show when they happened; tool
// rows show how long they took.

const STAMPS: Stamps[] = ["off", "relative", "absolute"];
let stamps: Stamps = "off";
let twelveHour = false;
/** pi-bash-bg's shortcut, once it has reported (bash-bg:update): the hint under long bash calls. */
let backgroundKey: string | undefined;
const HINT_AFTER_S = 30;
/** Running bash rows in the order they started: only the last gets the hint (the key moves all). */
const runningBash = new Set<Proto>();

/** Columns text gives up for the time column: its widest time + 1 ("11mo ago", "Sep 24 12:02 pm"). */
const reserve = () => (stamps === "off" ? 0 : stamps === "relative" ? 9 : twelveHour ? 16 : 13);

/** Saves toggles into the config file, keeping any other keys. */
function saveConfig(change: Config) {
  try {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), `${JSON.stringify({ ...readConfig(), ...change }, null, 2)}\n`);
  } catch {} // unwritable config: the toggle still applies to this session
}

const UNITS: [string, number][] = [
  ["y", 31_536_000],
  ["mo", 2_592_000],
  ["w", 604_800],
  ["d", 86_400],
  ["h", 3600],
  ["m", 60],
];
/**
 * "12m ago", or the shortest clear clock time: "14:02:31" today, "Sep 24 14:02", "Sep 24 2025"
 * ("2:02:31 pm", "Sep 24 2:02 pm" in 12-hour format).
 */
function clock(ms: number | undefined): string {
  if (!ms || stamps === "off") return "";
  const now = new Date();
  if (stamps === "relative") {
    const s = (now.getTime() - ms) / 1000;
    const unit = UNITS.find(([, size]) => s >= size);
    return unit ? `${Math.floor(s / unit[1])}${unit[0]} ago` : "now";
  }
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  const h = d.getHours();
  const time = `${twelveHour ? h % 12 || 12 : two(h)}:${two(d.getMinutes())}`;
  const ampm = twelveHour ? (h < 12 ? " am" : " pm") : "";
  if (d.toDateString() === now.toDateString()) return `${time}:${two(d.getSeconds())}${ampm}`;
  const day = `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`;
  if (d.getFullYear() === now.getFullYear()) return `${day} ${time}${ampm}`;
  return `${day} ${d.getFullYear()}`;
}

const duration = (s: number) =>
  s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;

/**
 * `line` with `stamp` (dim) ending 3 columns from the right, the line shortened to make room, and
 * a faint dotted leader between them. Dots sit on even columns so leaders line up across lines.
 */
function stamped(line: string, stamp: string, width: number, theme: Theme): string {
  if (!stamp) return line;
  // oxlint-disable-next-line no-control-regex
  line = line.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1"); // pi's padding, so it isn't cut with a …
  const end = Math.max(1, width - 3 - visibleWidth(stamp));
  const head = truncateToWidth(line, Math.max(0, end - 1), theme.fg("muted", "…"));
  const from = visibleWidth(head);
  let leader = " ";
  for (let c = from + 1; c < end - 1; c++) leader += c % 2 ? " " : "·";
  if (end - from > 1) leader += " ";
  return head + theme.fg("borderMuted", leader) + theme.fg("dim", stamp);
}

/** `lines` with `stamp` on the first line with text. */
function stampFirst(lines: string[], stamp: string, width: number, theme: Theme): string[] {
  const i = lines.findIndex((l) => !blank(l));
  if (stamp && i >= 0) lines[i] = stamped(lines[i]!, stamp, width, theme);
  return lines;
}

let session: Session | undefined;
/**
 * When each tool call's assistant message was saved (the call starts running then), and how many
 * calls it made.
 */
const calls = new Map<string, { start: number; batch: number }>();
let indexed = 0;
function callOf(id: string) {
  if (!calls.has(id) && session) {
    const entries = session.getEntries();
    for (const e of entries.slice(indexed)) {
      if (e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
      const ids = e.message.content.flatMap((c) => (c.type === "toolCall" && c.id ? [c.id] : []));
      for (const i of ids) calls.set(i, { start: Date.parse(e.timestamp), batch: ids.length });
    }
    indexed = entries.length;
  }
  return calls.get(id);
}

/**
 * A tool call's start and end: measured live, or from the session for history. pi saves a batch
 * of parallel calls' results only once all of them finish, so for history those end times are
 * the batch's (`bound`: the call took at most that long), unless the result's details carry the
 * tool's own `durationMs` (pi-bash-bg's bash does).
 */
function timesOf(t: Tool & Proto): { start?: number; end?: number; bound?: boolean } {
  if (t.clStart) return { start: t.clStart, end: t.clEnd };
  if (t.clCall === undefined) t.clCall = callOf(t.toolCallId) ?? null;
  const start = t.clCall?.start;
  // A tool that reports its own duration is exact, even in a batch.
  const ms = t.result?.details?.durationMs;
  if (start && typeof ms === "number") return { start, end: start + ms };
  return { start, end: t.result?.timestamp, bound: t.clCall?.batch > 1 };
}

/** When a group member started: a tool call, or an assistant message that opens with thinking. */
const startOf = (node: Proto): number | undefined =>
  node instanceof ToolExecutionComponent ? timesOf(node).start : node.lastMessage?.timestamp;

/**
 * Pairs chat components with the session messages they show, from the end (the chat may start
 * later than the branch), setting each one's clTime. Unpaired ones get no time. `shares`: the
 * component shows the same message as the next one.
 */
function pair(
  entries: Entry[],
  nodes: Proto[],
  match: (node: Proto, message: Saved) => boolean,
  shares = (_node: Proto) => false,
) {
  let j = entries.length - 1;
  for (let i = nodes.length - 1; i >= 0; i--)
    for (let k = shares(nodes[i]!) ? Math.min(j + 1, entries.length - 1) : j; k >= 0; k--) {
      const m = entries[k]!.message!;
      if (!match(nodes[i]!, m)) continue;
      nodes[i]!.clTime = m.timestamp ?? Date.parse(entries[k]!.timestamp);
      j = k - 1;
      break;
    }
}

/**
 * When a component's message was sent. User messages, skills (the user message they came in), and
 * user bash keep no timestamp in pi's components, so they're paired with the session's messages
 * on the current branch. Rerun when the branch or the chat changes.
 */
let paired = "";
function timeOf(node: Proto): number | undefined {
  const key = `${session?.getLeafId()}:${chat?.children.length}`;
  if (node.clTime === undefined && session && chat && key !== paired) {
    paired = key;
    const branch = session.getBranch();
    const saved = (role: string) => branch.filter((e) => e.message?.role === role);
    const shown = (...types: Function[]) =>
      chat!.children.filter((c: unknown) => types.some((t) => c instanceof t));
    const textOf = (m: Saved) =>
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
    const skill = (n: Proto) => n instanceof SkillInvocationMessageComponent;
    pair(
      saved("user"),
      shown(UserMessageComponent, SkillInvocationMessageComponent),
      (n, m) => textOf(m).includes(skill(n) ? `<skill name="${n.skillBlock.name}"` : n.text),
      (n) => skill(n) && !!n.skillBlock.userMessage,
    );
    pair(saved("bashExecution"), shown(BashExecutionComponent), (n, m) => m.command === n.command);
  }
  return node.clTime;
}
/** The stamp for a component paired with the session (no pairing while timestamps are off). */
const pairedStamp = (node: Proto) => (stamps === "off" ? "" : clock(timeOf(node)));

const str = (v: unknown) => (typeof v === "string" ? v : "");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const lineCount = (s: string) => (s ? s.replace(/\n$/, "").split("\n").length : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const stateOf = (t: Tool): State =>
  t.result?.isError ? "error" : t.result && !t.isPartial ? "done" : "running";

/** Per-result caches: rows render every frame, and pi replaces the result object on each update. */
function cached<T>(compute: (r: Result) => T) {
  const cache = new WeakMap<Result, T>();
  return (r: Result) => {
    if (!cache.has(r)) cache.set(r, compute(r));
    return cache.get(r)!;
  };
}
const outputOf = cached((r) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .trimEnd(),
);
const output = (t: Tool) => (t.result ? outputOf(t.result) : "");
const linesOf = cached((r) => untab(outputOf(r)).split("\n"));

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
const OPTION_WIDTH = 40; // closed, longer (or multi-line) values show just their name

/**
 * The params the call passed that its target leaves out: "key value", "key" for true, false ones
 * dropped, lists joined. Closed rows cut big values to their name; `full` shows them whole.
 * Edits and writes have none: their content shows as the diff or the code.
 */
function options(t: Tool, full: boolean): string {
  const a = t.args ?? {};
  if (t.toolName === "edit" || t.toolName === "write") return "";
  const shown = IN_TARGET[t.toolName] ?? [Object.keys(a).find((k) => typeof a[k] === "string")];
  return Object.entries(a)
    .filter(([k, v]) => !shown.includes(k) && v !== undefined && v !== null && v !== false)
    .map(([k, v]) => {
      if (v === true) return k;
      const flat = Array.isArray(v) && v.every((x) => typeof x !== "object");
      const text = flat ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
      const big = text.includes("\n") || text.length > OPTION_WIDTH;
      return full || !big ? `${k} ${text}` : k;
    })
    .join(" · ");
}

/** What a call targets and, once settled, what came back. */
function describe(t: Tool): [target: string, result: string] {
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
      // Match lines read "file:N: text"; context lines read "file-N- text".
      return [target, plural(out.match(/^.+?:\d+: /gm)?.length ?? 0, "match", "matches")];
    case "find":
      return [target, plural(out.startsWith("No files") ? 0 : lineCount(out), "file")];
    case "ls":
      return [target, plural(out.startsWith("(empty") ? 0 : lineCount(out), "entry", "entries")];
    default:
      return [target, ""];
  }
}

/** Whether a row shows its content: autoExpandedTools open; ctrl+o sets all; a click, its own. */
const isOpen = (t: Tool & Proto, config: Config): boolean =>
  t.clOpen ?? (t.expanded || config.autoExpandedTools!.includes(t.toolName));

/** Lines shown under an open row: the diff, written content, or output (red for failures). */
function body(t: Tool & Proto, theme: Theme, config: Config): string[] {
  const open = isOpen(t, config);
  return memo(t, "clBody", [open, t.result, t.args?.content, theme], () =>
    bodyLines(t, open, theme),
  );
}
function bodyLines(t: Tool & Proto, open: boolean, theme: Theme): string[] {
  const lang = getLanguageFromPath(str(t.args?.path ?? t.args?.file_path));
  if (open && t.toolName === "write")
    return numbered(highlighted(untab(str(t.args?.content).trimEnd()), lang, theme), 1, theme);
  if (!open || !t.result) return [];
  if (t.toolName === "edit" && t.result.details?.diff)
    return diffOf(t.result.details.diff, lang, theme);
  if (t.toolName === "read" && !t.result.isError) {
    // pi ends a partial read with a note ("[705 more lines in file. …]"), which isn't code.
    const lines = linesOf(t.result);
    const note =
      lines.at(-2) === "" && /^\[.*\]$/.test(lines.at(-1)!) ? lines.length - 2 : Infinity;
    const code = highlighted(lines.slice(0, note).join("\n"), lang, theme);
    const first = Math.max(1, Math.floor(Number(t.args?.offset)) || 1);
    return [...numbered(code, first, theme), ...lines.slice(note).map((l) => theme.fg("muted", l))];
  }
  const color = t.result.isError ? "error" : "text";
  return linesOf(t.result).map((l) => theme.fg(color, l)); // live output while running
}

/**
 * Rounded border like pi-footer's prompt box around `lines`, which fit width - 6; dashed with a
 * title in its top edge for special messages. A stamp sits in the top edge's time column. Set a
 * column in on each side, so the text lines up with assistant text. Cached on `node`.
 */
function frame(
  node: Proto,
  lines: string[],
  width: number,
  theme: Theme,
  title?: string,
  stamp = "",
) {
  return memo(node, "clFrame", [lines, width, theme, title, stamp], () =>
    boxed(
      lines.map((l) => dimHint(l, theme)),
      width - 2,
      theme,
      title,
      stamp,
    ).map((l) => ` ${l} `),
  );
}
/** pi paints "(ctrl+o to expand)" in its message color with only the key dim: all of it dim. */
const dimHint = (line: string, theme: Theme) =>
  // oxlint-disable-next-line no-control-regex
  line.replace(/\((?:\x1b\[[\d;]*m)*(\S+?)(?:\x1b\[[\d;]*m)* to expand\)/, (_, key) =>
    theme.fg("dim", `(${key} to expand)`),
  );
function boxed(lines: string[], width: number, theme: Theme, title?: string, stamp = "") {
  const inner = Math.max(1, width - 4);
  const [h, v] = title ? ["┄", "┆"] : ["─", "│"];
  const head = title ? `${h}${h} ${title} ` : "";
  const bar = (lead: string, room = width - 2) =>
    lead + h.repeat(Math.max(0, room - visibleWidth(lead)));
  const side = theme.fg("muted", v);
  const top = stamp
    ? theme.fg("muted", `╭${bar(head, width - 5 - visibleWidth(stamp))} `) +
      theme.fg("dim", stamp) +
      theme.fg("muted", ` ${h}╮`)
    : theme.fg("muted", `╭${bar(head)}╮`);
  return [
    top,
    ...lines.map((l) => {
      const text = truncateToWidth(l, inner);
      return `${side} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${side}`;
    }),
    theme.fg("muted", `╰${bar("")}╯`),
  ];
}

// --- Groups -------------------------------------------------------------------------------------
// Each chat child renders its own part of a group, so pi's click routing (by child height) holds.
// A child is a group "item" (tool row, or an assistant message that opens with thinking), an item
// that "closes" the group (that thinking is followed by text), "skip" (renders nothing, e.g. an
// assistant message with only tool calls), or a "boundary".

type Kind = "item" | "closes" | "skip" | "boundary";

const visible = (c: Block) =>
  !!(c.type === "text" ? c.text : c.type === "thinking" ? c.thinking : "")?.trim();

/** Whether a message opens with thinking (which then becomes a tree row). */
const leadsWithThinking = (message?: Message) =>
  message?.content.find(visible)?.type === "thinking";

/** The thinking a message opens with. */
function thinkingOf(message: Message): string {
  const run = [];
  for (const c of message.content.slice(message.content.findIndex(visible))) {
    if (c.type !== "thinking") break;
    if (c.thinking?.trim()) run.push(c.thinking.trim());
  }
  return run.join("\n");
}

function kindOf(node: unknown): Kind {
  if (node instanceof ToolExecutionComponent) {
    const t = node as unknown as Tool;
    return t.hideComponent ? "skip" : "item";
  }
  if (!(node instanceof AssistantMessageComponent)) return "boundary";
  const a = node as unknown as Proto;
  const message = a.lastMessage as Message | undefined;
  // pi also prints a note for truncated responses, and for failed ones without tool calls.
  const stop = message?.stopReason ?? "";
  const text =
    !!message?.content.some((c) => c.type === "text" && c.text?.trim()) ||
    stop === "length" ||
    (!a.hasToolCalls && (stop === "error" || stop === "aborted"));
  if (leadsWithThinking(message)) return text ? "closes" : "item";
  return text ? "boundary" : "skip";
}

/**
 * pi's chat container: the third in its document (header, loaded resources, chat), which is the
 * first child of the TUI root.
 */
let chat: Proto | undefined;
function parentOf(node: Node, target: Node, depth = 4): Node | undefined {
  if (!node.children || depth < 0) return undefined;
  if (node.children.includes(target)) return node;
  for (const child of node.children) {
    const found = parentOf(child, target, depth - 1);
    if (found) return found;
  }
  return undefined;
}

/** Whether groups start collapsed to their summary line (ctrl+shift+o); a click sets one's own. */
let collapseGroups = false;
/** Most lines open thinking and a call's input and content each show until clicked (0: all). */
let maxLines = 10;
/** Whether open content wraps long lines, or cuts them off with … (the default; ctrl+shift+w). */
let wordWrap = false;
/** Whether pi runs full screen, where the whole transcript redraws and can animate. */
let fullscreen = false;
/** Whether the agent is working (from agent_start to agent_end). */
let working = false;

/** `lines` cut to maxLines, and a line to show the rest or, once shown (`full`), cut them again. */
function capped(lines: string[], theme: Theme, full?: boolean): [string[], string?] {
  if (!maxLines || lines.length <= maxLines) return [lines];
  if (full) return [lines, theme.fg("dim", "↑ show less")];
  const more = `↓ ${plural(lines.length - maxLines, "more line")}`;
  return [lines.slice(0, maxLines), theme.fg("dim", more)];
}

/**
 * What's still running, full screen: a slow pulse from its color (text when `open`, else muted) 40%
 * of the way to the other and back, every 1.6s.
 */
function pulse(theme: Theme, s: string, open: boolean): string {
  const [muted, text] = [rgbOf(theme.getFgAnsi("muted")), rgbOf(theme.getFgAnsi("text"))];
  if (!fullscreen || !muted || !text) return theme.fg(open ? "text" : "muted", s);
  const t = (0.4 * (1 - Math.cos((Date.now() / 1600) * 2 * Math.PI))) / 2;
  return `\x1b[38;2;${open ? between(text, muted, t) : between(muted, text, t)}m${s}\x1b[39m`;
}

/** The member that opens the group `list[i]` belongs to (it keeps the group's collapsed state). */
function groupStart(list: unknown[], i: number): Proto {
  let first = i;
  for (let j = i - 1; j >= 0; j--) {
    const kind = kindOf(list[j]);
    if (kind === "item") first = j;
    else if (kind !== "skip") break;
  }
  return list[first] as Proto;
}

/** Kind of the nearest non-skipped sibling in `dir`. */
function neighbor(list: unknown[], i: number, dir: 1 | -1): Kind {
  for (i += dir; i >= 0 && i < list.length; i += dir) {
    const kind = kindOf(list[i]);
    if (kind !== "skip") return kind;
  }
  return "boundary";
}

/** Components given their own render, and how to undo each on shutdown. */
const overridden = new Map<Proto, () => void>();
/** Gives one component its own render, falling back to pi's on any error, once. */
function override(
  node: Proto,
  render: (orig: (width: number) => string[], width: number) => string[],
  undo = () => {},
) {
  if (overridden.has(node)) return;
  const orig = node.render.bind(node);
  node.render = (width: number) => {
    try {
      return render(orig, width);
    } catch {
      return orig(width);
    }
  };
  overridden.set(node, () => {
    delete node.render;
    undo();
  });
}

/**
 * pi's status lines, notices, warnings, and errors (plain Text in the chat, outside panels) at
 * column 3 like assistant text, without a bullet, keeping the same 3 columns free on the right.
 */
function indentNotices(list: Proto[]) {
  let panel = false; // between two rules: the panel's own render places it
  for (const node of list) {
    if (node instanceof DynamicBorder) panel = !panel;
    // Exactly Text: subclasses (pi's loaders) draw their own way.
    if (panel || overridden.has(node) || Object.getPrototypeOf(node) !== Text.prototype) continue;
    override(node, (orig, width) => atColumn3(node, width, orig));
  }
}

/** A plain Text's lines, from `render`, at column 3 with the same 3 columns free on the right. */
function atColumn3(node: Proto, width: number, render: (width: number) => string[]) {
  // pi pads them 1 column (0 with its outputPad setting off); the rest makes 3.
  const pad = Math.min(3, Math.max(0, node.paddingX ?? 1));
  const raw = render(Math.max(1, width - 6 + 2 * pad));
  return memo(node, "clLines", [raw, width], () =>
    raw.map((l) => (blank(l) ? l : indent(l, " ".repeat(3 - pad)))),
  );
}

/**
 * Summary line from a group's calls ("Read 3 files, ran 2 commands, 1 failed"): muted collapsed,
 * and pulsing then while the group goes on (`live`: the agent works, and nothing ended it yet).
 */
function summary(members: unknown[], theme: Theme, collapsed: boolean, live: boolean): string {
  const counts = new Map<Wording, number>();
  let failed = 0;
  for (const m of members) {
    if (!(m instanceof ToolExecutionComponent)) continue;
    const t = m as unknown as Tool;
    if (stateOf(t) === "error") failed++;
    const wording = (WORDING[t.toolName] ??= [`ran ${t.toolName}`, "time"]); // one entry per tool
    const urls = t.toolName === "web_fetch" && t.args?.urls;
    counts.set(wording, (counts.get(wording) ?? 0) + (Array.isArray(urls) ? urls.length : 1));
  }
  const text =
    [...counts].map(([[verb, noun, nouns], n]) => `${verb} ${plural(n, noun, nouns)}`).join(", ") ||
    "thought";
  const color = collapsed ? "muted" : "text";
  const title = text[0]!.toUpperCase() + text.slice(1);
  const line = collapsed && live ? pulse(theme, title, false) : theme.fg(color, title);
  return failed ? `${line}${theme.fg(color, ", ")}${theme.fg("error", `${failed} failed`)}` : line;
}

/**
 * A member's lines: the summary line if it opens the group, its ├/└ row (wrapped onto more lines
 * when open), and its body. A member alone in its group shows `solo` instead, when given, as the
 * summary line with no tree. The summary line shows when the group started, the row `stamp`.
 * A collapsed group shows only its summary line.
 * Sets node.clHeadY and node.clRowY to the summary line's and the row's lines, for click handling.
 */
function groupLines(
  node: Proto,
  row: string[],
  rowBody: string[],
  width: number,
  theme: Theme,
  solo?: string,
  stamp = "",
) {
  let list: unknown[] = chat?.children ?? [];
  if (list[node.clIndex] !== node) node.clIndex = list.indexOf(node);
  if (node.clIndex < 0) [list, node.clIndex] = [[node], 0]; // outside the chat: on its own
  const i: number = node.clIndex;
  const first = neighbor(list, i, -1) !== "item";
  const last = kindOf(node) === "closes" || !["item", "closes"].includes(neighbor(list, i, 1));
  const alone = first && last && solo;
  const collapsed = !alone && ((first ? node : groupStart(list, i)).clCollapsed ?? collapseGroups);
  let head: string | undefined; // the summary line, when the member opens the group
  const started = first ? clock(startOf(node)) : "";
  if (first && !alone) {
    const members = [];
    let ended = false; // by text, a message, or thinking the answer follows
    for (let j = i; j < list.length && !ended; j++) {
      const kind = kindOf(list[j]);
      ended = kind === "boundary" || kind === "closes";
      if (kind === "item" || kind === "closes") members.push(list[j]);
    }
    head = summary(members, theme, collapsed, working && !ended);
  }
  node.clHeadY = head ? 1 : undefined;
  node.clGroupCollapsed = collapsed;
  const rowY = (node.clRowY = collapsed ? Infinity : alone ? 1 : head ? 2 : 0);
  const deps = [row, rowBody, width, theme, last, alone, head, started, stamp, collapsed];
  deps.push(node.clFullBody, wordWrap); // a click showed all of the content; ctrl+shift+w wrapped it
  return memo(node, "clGroup", deps, () => {
    node.clMoreY = undefined;
    if (collapsed) return head ? ["", stamped(`   ${head}`, started, width, theme)] : [];
    // Open content hangs off a └ under the row's name (column 5), one space before it like the
    // rows, and a blank line follows it unless the group ends (a spacer follows then).
    // Fit to 3 columns in, 2 of rail, 2 for the └, 3 after: long lines wrap, or end in …. A diff
    // line's tint (a background it opens with) spans the whole row.
    const fit = Math.max(1, width - (alone ? 8 : 10));
    let wrapped = rowBody.flatMap((l) => {
      // oxlint-disable-next-line no-control-regex
      const tint = /^\x1b\[48;[\d;]*m/.exec(l)?.[0] ?? "";
      const cut = tint + theme.fg("muted", "…");
      const parts = !wordWrap
        ? [truncateToWidth(l, fit, cut)]
        : visibleWidth(l) > fit
          ? hanging(l, fit)
          : [l];
      if (!tint) return parts;
      return parts.map(
        (p) => `${tint}${p}${tint}${" ".repeat(Math.max(0, fit - visibleWidth(p)))}\x1b[49m`,
      );
    });
    const [shown, toggle] = capped(wrapped, theme, node.clFullBody);
    wrapped = toggle ? [...shown, toggle] : shown;
    const hung = wrapped.map((l, j) => (j ? "  " : `${theme.fg("dim", "└")} `) + l);
    if (hung.length && !last) hung.push("");
    let lines: string[];
    if (alone) lines = ["", `   ${solo}`, ...hung.map((l) => `   ${l}`)]; // └ under the line's start
    else {
      const rail = last ? " " : theme.fg("dim", "│");
      lines = [
        ...(head ? ["", `   ${head}`] : []), // aligned with assistant text
        `   ${theme.fg("dim", last ? "└" : "├")} ${row[0]}`,
        // A wrapped row's └ hangs from the row through a │ down its lines.
        ...row
          .slice(1)
          .map((l) => `   ${rail} ${hung.length ? theme.fg("dim", "│") + l.slice(1) : l}`),
        // A row on more than one line (a multi-line bash command) gets a line before its content.
        ...(row.length > 1 && hung.length ? [`   ${rail} ${theme.fg("dim", "│")}`] : []),
        ...hung.map((l) => `   ${rail} ${l}`),
      ];
    }
    // The content's toggle is its last line (a spacer may follow).
    node.clMoreY = toggle ? lines.length - hung.length + wrapped.length - 1 : undefined;
    // Right margin matches the left indent of the row text.
    lines = lines.map((l) => truncateToWidth(l, Math.max(1, width - 3), theme.fg("muted", "…")));
    if (head || alone) lines[1] = stamped(lines[1]!, started, width, theme);
    if (!alone) lines[rowY] = stamped(lines[rowY]!, stamp, width, theme);
    return lines;
  });
}

/** A long line wrapped to `fit`; numbered code (a diff, a read, a write) continues under its code. */
function hanging(line: string, fit: number): string[] {
  // oxlint-disable-next-line no-control-regex
  const hang = /^[-+ ] *\d+ /.exec(line.replace(/\x1b\[[\d;]*m/g, ""))?.[0].length ?? 0;
  if (!hang || hang > fit / 2) return wrapTextWithAnsi(line, fit);
  const [first = "", ...rest] = wrapTextWithAnsi(sliceByColumn(line, hang, Infinity), fit - hang);
  return [sliceByColumn(line, 0, hang) + first, ...rest.map((p) => " ".repeat(hang) + p)];
}

function renderTool(t: Tool & Proto, width: number, theme: Theme, config: Config): string[] {
  const state = stateOf(t);
  if (t.executionStarted) t.clStart ??= Date.now();
  if (state !== "running" && t.clStart) t.clEnd ??= Date.now();
  // Until a result arrives the arguments may still be streaming in.
  const [target, detail] = t.result
    ? memo(t, "clInfo", [t.result], () => describe(t))
    : describe(t);
  const { start, end, bound } = timesOf(t);
  const seconds = start ? Math.max(0, ((end ?? Date.now()) - start) / 1000) : 0;
  const took = start && end ? (bound ? "≤" : "") + duration(seconds) : "";
  // The duration sits in the time column while timestamps show, else in the row from 1s up
  // when exact.
  let time = stamps === "off" && seconds >= 1 && !bound ? took : "";
  // While running, a live timer (pi's spinner keeps frames coming) shows the call is in progress.
  if (state === "running") time = t.clStart ? `running ${Math.floor(seconds)}s` : "";
  const stamp = stamps !== "off" && state !== "running" ? took : "";
  const result = state === "error" ? detail : [detail, time].filter(Boolean).join(" · ");
  // Open, a row reads as bright as its content; closed, it stays muted. While running, a closed
  // row pulses whole, an open one just its name.
  const open = isOpen(t, config);
  const color = state === "error" ? "error" : open ? "text" : "muted";
  const pulsing = state === "running" && !open;
  const paint = (s: string) => (pulsing ? pulse(theme, s, false) : theme.fg(color, s));
  const name = t.toolName.padEnd(5);
  const tail = result ? ` · ${result}` : "";
  // The target's room: 5 columns of tree before the row, 3 after, and the time column.
  const room = Math.max(1, width - 8 - visibleWidth(name) - 1 - reserve());
  // Closed, a long target gives way to the result and ends in … (pi's truncation resets colors
  // before it, so it gets its own). Open, it wraps in full under its start (a bash command with its
  // own line breaks), the result after it, or on a line of its own when it doesn't fit.
  let lines: string[];
  let toggle: string | undefined; // the input's toggle, under the result
  if (open) {
    const full = t.toolName === "bash" ? untab(str(t.args?.command).trim()) : target;
    // A copy: the highlighted command is memoized, and the options get appended to it.
    const colored = [
      ...(t.toolName === "bash" && state !== "error"
        ? memo(t, "clCommand", [full, theme], () => highlighted(full, "bash", theme))
        : full.split("\n").map((l) => theme.fg(color, l))),
    ];
    // The options follow the input, dim, their own line breaks kept.
    const opts = options(t, true);
    if (opts) {
      const [first, ...rest] = opts.split("\n").map((l) => theme.fg("dim", l));
      colored[colored.length - 1] += (full ? theme.fg("dim", " · ") : "") + first;
      colored.push(...rest);
    }
    [lines, toggle] = capped(
      colored.flatMap((l) => wrapTextWithAnsi(l, room)),
      theme,
      t.clFullRow,
    );
    if (tail && visibleWidth(lines.at(-1)! + tail) > room) lines.push("");
  } else {
    // The options follow the target, dim, and give way first.
    const fit = Math.max(1, room - visibleWidth(tail));
    const opts = options(t, false);
    const dimmed = (x: string) => (pulsing ? paint(x) : theme.fg("dim", x));
    const text = paint(target) + (opts ? dimmed((target ? " · " : "") + opts) : "");
    lines = [truncateToWidth(text, fit, paint("…"))];
  }
  const painted = state === "running" ? pulse(theme, name, open) : theme.fg(color, name);
  const label = `${theme.bold(theme.italic(painted))} `;
  const row = lines.map((l, i) => (i ? " ".repeat(visibleWidth(label)) : label) + l);
  const tailText = lines.at(-1) ? tail : tail.slice(1);
  let after = pulsing ? paint(tailText) : theme.fg(state === "error" ? "error" : "dim", tailText);
  // An open edit's or write's line counts in the diff's colors.
  if (open && (t.toolName === "edit" || t.toolName === "write"))
    after = after.replace(
      /\+(\d+)(?: -(\d+))?/,
      (_, added, removed) =>
        theme.fg("toolDiffAdded", `+${added}`) +
        (removed ? ` ${theme.fg("toolDiffRemoved", `-${removed}`)}` : "") +
        theme.getFgAnsi("dim"),
    );
  row[row.length - 1] += after;
  if (toggle) row.push(" ".repeat(visibleWidth(name) + 1) + toggle);
  t.clRowMore = toggle ? row.length - 1 : undefined;
  let content = body(t, theme, config);
  if (t.toolName === "bash" && state === "running") runningBash.add(t);
  else runningBash.delete(t);
  if (backgroundKey && seconds >= HINT_AFTER_S && [...runningBash].at(-1) === t)
    content = [...content, theme.fg("dim", `${backgroundKey} to run in background`)];
  return groupLines(t, row, content, width, theme, undefined, stamp);
}

export default function (pi: ExtensionAPI) {
  const restores: (() => void)[] = [];
  // Patched methods fall back to pi's own on any error: a layout bug must never crash pi.
  const patch = (proto: Proto, key: string, wrap: (orig: any) => unknown) => {
    const orig = proto[key];
    const fn = wrap(orig) as (...args: unknown[]) => unknown;
    proto[key] = function (this: unknown, ...args: unknown[]) {
      try {
        return fn.apply(this, args);
      } catch {
        return orig.apply(this, args);
      }
    };
    restores.push(() => (proto[key] = orig));
  };

  pi.events.on("bash-bg:update", (data) => {
    backgroundKey = (data as { shortcut?: string }).shortcut;
  });

  let requestRender = () => {};
  pi.registerShortcut(Key.ctrlShift("t"), {
    description: "Cycle timestamps: off, relative, absolute",
    handler: async (ctx) => {
      stamps = STAMPS[(STAMPS.indexOf(stamps) + 1) % STAMPS.length]!;
      saveConfig({ timestamps: stamps });
      ctx.ui.notify(`Timestamps: ${stamps}`, "info");
      requestRender();
    },
  });

  // Like ctrl+o for rows, it sets every group, clicked ones too.
  pi.registerShortcut(Key.ctrlShift("o"), {
    description: "Collapse or expand tool groups",
    handler: async (ctx) => {
      collapseGroups = !collapseGroups;
      saveConfig({ collapseGroups });
      for (const c of chat?.children ?? []) delete c.clCollapsed;
      ctx.ui.notify(`Tool groups: ${collapseGroups ? "collapsed" : "expanded"}`, "info");
      requestRender();
    },
  });
  pi.registerShortcut(Key.ctrlShift("w"), {
    description: "Toggle word wrap for open tool content",
    handler: async (ctx) => {
      wordWrap = !wordWrap;
      saveConfig({ enableWordWrap: wordWrap });
      ctx.ui.notify(`Word wrap: ${wordWrap ? "on" : "off"}`, "info");
      requestRender();
    },
  });
  /** A click on a group's summary line (on the member that opens it) collapses or expands it. */
  const toggleGroup = (lead: Proto) => {
    lead.clCollapsed = !lead.clGroupCollapsed;
    requestRender();
    return { handled: true };
  };

  pi.on("agent_start", () => {
    working = true;
  });
  pi.on("agent_end", () => {
    working = false;
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || restores.length) return;
    const config = readConfig();
    collapseGroups = config.collapseGroups === true;
    const max = Number(config.maxExpandedLines ?? 10);
    maxLines = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 10;
    wordWrap = config.enableWordWrap === true;
    if (!Array.isArray(config.autoExpandedTools)) config.autoExpandedTools = ["edit", "write"];
    stamps = STAMPS.includes(config.timestamps!) ? config.timestamps! : "off";
    twelveHour = config.timestampFormat === "12h";
    session = ctx.sessionManager as unknown as Session;
    const theme = () => ctx.ui.theme;
    // pi calls widget factories right away with the TUI; that is all this widget is for.
    ctx.ui.setWidget("pi-content-layout", (root) => {
      chat = (root as unknown as Node).children?.[0]?.children?.[2];
      requestRender = () => (root as unknown as Tool["ui"]).requestRender();
      const tui = root as unknown as FullScreen;
      fullscreen = tui.mode === "fullscreen";
      // pi hands a selection's text to copySelection; the layout's decoration comes off first.
      const copy = tui.copySelection;
      if (copy) {
        tui.copySelection = (text) => {
          const start = tui.getSelectionBounds?.()?.start.col ?? 0;
          return copy(copied(text, start, tui.terminal?.columns ?? 80, reserve()));
        };
        restores.push(() => (tui.copySelection = copy));
      }
      return { render: () => [], invalidate() {} };
    });
    // Relative times ("12m ago") age without anything else to redraw them.
    const timer = setInterval(() => stamps === "relative" && requestRender(), 30_000);
    restores.push(() => clearInterval(timer));
    ctx.ui.setWidget("pi-content-layout", undefined);
    // Whatever ends the chat gets one more blank line before the prompt (pi adds a spacer of its
    // own), so the gap is the same after text, a group, or a message. Inside the chat, so it
    // scrolls with the content.
    if (chat)
      override(chat, (orig, width) => {
        indentNotices(chat!.children);
        const lines = orig(width);
        return lines.length && !blank(lines.at(-1)!) ? [...lines, ""] : lines;
      });

    const tool = ToolExecutionComponent.prototype as unknown as Proto;
    patch(
      tool,
      "render",
      (orig) =>
        function (this: Tool, width: number) {
          return kindOf(this) === "item"
            ? renderTool(this, width, theme(), config)
            : orig.call(this, width);
        },
    );
    // ctrl+o sets every row, clicked ones too, like the header.
    patch(
      tool,
      "setExpanded",
      (orig) =>
        function (this: Tool & Proto, expanded: boolean) {
          this.clOpen = this.clFullRow = this.clFullBody = undefined;
          return orig.call(this, expanded);
        },
    );
    // pi routes clicks by its own layout; a click on a row or its content opens or closes it.
    patch(
      tool,
      "handleMouse",
      (orig) =>
        function (this: Tool & Proto, event: Mouse) {
          if (kindOf(this) !== "item") return orig.call(this, event);
          if (event.type !== "click" || event.button !== "left") return undefined;
          if (event.y === this.clHeadY) return toggleGroup(this);
          if (event.y < this.clRowY) return undefined;
          // A toggle line shows or cuts its part; anywhere else opens or closes the row.
          const part =
            event.y === this.clRowY + this.clRowMore
              ? "clFullRow"
              : event.y === this.clMoreY
                ? "clFullBody"
                : undefined;
          if (part) this[part] = !this[part];
          else this.clOpen = !isOpen(this, config);
          this.ui.requestRender();
          return { handled: true };
        },
    );

    /** A box's content without its background and padding, to fit a frame. */
    const inner = (box: Proto, width: number): string[] =>
      Container.prototype.render.call(box, Math.max(1, width - 6));

    // User messages: take the text out of pi's background box and draw a rounded border instead.
    // Done at render time so messages created before the extension loaded are covered too.
    patch(
      UserMessageComponent.prototype as unknown as Proto,
      "render",
      () =>
        function (this: Proto, width: number) {
          const [box] = this.children;
          if (box instanceof Box) {
            this.clear();
            for (const child of box.children) this.addChild(child);
          }
          const stamp = pairedStamp(this);
          const lines = [...frame(this, inner(this, width), width, theme(), undefined, stamp)];
          // pi's prompt marks stay at column 0 of the first and last lines, as pi places them:
          // terminals like Ghostty start a fresh line at the opening mark when it isn't.
          lines[0] = mark("A") + lines[0];
          lines[lines.length - 1] = mark("B") + mark("C") + lines[lines.length - 1];
          return lines;
        },
    );

    // Special messages (compaction and branch summaries, skills, extension messages in pi's box
    // or an extension's): the background box becomes a dashed border with pi's label in it, and
    // the time in its top edge. pi's own boxes open with the label and a blank line.
    const special = (box: Proto, width: number, title: string, time?: number) =>
      frame(box, inner(box, width).slice(2), width, theme(), title, clock(time));
    for (const [proto, title] of [
      [CompactionSummaryMessageComponent.prototype, "compaction"],
      [BranchSummaryMessageComponent.prototype, "branch"],
    ] as const)
      patch(
        proto as unknown as Proto,
        "render",
        () =>
          function (this: Proto, width: number) {
            return special(this, width, title, this.message.timestamp);
          },
      );
    patch(
      CustomMessageComponent.prototype as unknown as Proto,
      "render",
      (orig) =>
        function (this: Proto, width: number) {
          const own = this.customComponent;
          // An extension's status line (a plain Text) sits at column 3 like pi's.
          if (own && Object.getPrototypeOf(own) === Text.prototype)
            return ["", ...atColumn3(own, width, (w) => own.render(w))];
          // An extension's background box (pi-bash-bg's end messages) is pi's look redone: its whole
          // content goes in the dashed border. Anything else keeps the extension's own look.
          if (own && !(own instanceof Box)) return orig.call(this, width);
          const { customType: title, timestamp } = this.message;
          if (own)
            return ["", ...frame(own, inner(own, width), width, theme(), title, clock(timestamp))];
          return ["", ...special(this.box, width, title, timestamp)];
        },
    );
    // A click opens or closes a framed extension message (pi-bash-bg's end messages), like ctrl+o.
    patch(
      CustomMessageComponent.prototype as unknown as Proto,
      "handleMouse",
      (orig) =>
        function (this: Proto, event: Mouse) {
          const click = event.type === "click" && event.button === "left";
          if (!click || !(this.customComponent instanceof Box)) return orig.call(this, event);
          this.setExpanded(!this._expanded);
          requestRender();
          return { handled: true };
        },
    );
    // A skill's label leads its one line while closed, and has a line of its own while open.
    patch(
      SkillInvocationMessageComponent.prototype as unknown as Proto,
      "render",
      () =>
        function (this: Proto, width: number) {
          const lines = inner(this, width);
          const body = this.expanded
            ? lines.slice(1)
            : lines.map((l) => l.replace("\x1b[1m[skill]\x1b[22m ", ""));
          const stamp = pairedStamp(this);
          return frame(this, body, width, theme(), "skill", stamp);
        },
    );

    // User bash (!cmd) and pi's info panels (/changelog, /hotkeys, updates) read like assistant
    // text: a ● and column 3, without pi's horizontal rules around them. The ● takes the color
    // of what it marks: pi's bash color (dim for !! runs, as pi's rules were), the panel heading.
    patch(
      BashExecutionComponent.prototype as unknown as Proto,
      "render",
      () =>
        function (this: Proto, width: number) {
          // The output follows the command without pi's blank line.
          const raw: string[] = this.contentContainer.render(Math.max(1, width - 4 - reserve()));
          const stamp = pairedStamp(this);
          return memo(this, "clBash", [raw, theme(), stamp, width], () => {
            const lines = tidy(raw);
            if (lines.length > 1 && blank(lines[1]!)) lines.splice(1, 1);
            const rule = this.children.find((c: unknown) => c instanceof DynamicBorder);
            return ["", ...stampFirst(bulleted(lines, rule?.color), stamp, width, theme())];
          });
        },
    );
    // A panel is the siblings between two rules anywhere in the chat, pi's or an extension's
    // (pi-header's /loaded); rules elsewhere, like selectors', stay. Panels aren't restored from
    // history, so the time one first shows is when it was opened; it goes by the heading.
    patch(
      DynamicBorder.prototype as unknown as Proto,
      "render",
      (orig) =>
        function (this: Proto, width: number) {
          const parent: Proto | null = (this.clParent ??= (chat && parentOf(chat, this)) ?? null);
          if (!parent) return orig.call(this, width);
          const list: Proto[] = parent.children;
          const i = list.indexOf(this);
          const opens = list.slice(0, i).filter((c) => c instanceof DynamicBorder).length % 2 === 0;
          for (let j = i + 1; opens && j < list.length; j++) {
            const member = list[j]!;
            if (member instanceof DynamicBorder) break;
            if (overridden.has(member)) continue;
            const paint = j === i + 1 ? (s: string) => theme().fg("accent", s) : undefined;
            const { paddingY } = member;
            if (member instanceof Markdown) member.paddingY = 0; // pi spaces the panel already
            override(
              member,
              (orig, w) => {
                const raw = orig(Math.max(1, w - 4));
                const stamp = paint ? clock((member.clTime ??= Date.now())) : "";
                return memo(member, "clLines", [raw, theme(), stamp, w], () =>
                  stampFirst(bulleted(tidy(raw), paint), stamp, w, theme()),
                );
              },
              () => member instanceof Markdown && (member.paddingY = paddingY),
            );
          }
          return [];
        },
    );

    const assistant = AssistantMessageComponent.prototype as unknown as Proto;
    // Thinking opens or closes with ctrl+t (pi's own setting) and is timed: "thinking…" while it
    // streams, then "thought for Xs", or "thought briefly" under a second. Timed from the
    // message's start, since some providers deliver thinking in one burst. pi saves no thinking
    // time, so messages loaded from history show "thought for some time". One label per message.
    patch(
      assistant,
      "updateContent",
      (orig) =>
        function (this: Proto, message: Message, streaming?: boolean) {
          // pi's constructor makes the first call only for history (live messages start empty and
          // update with `streaming` set).
          const history = !this.clInit && streaming === undefined;
          this.clInit = true;
          const blocks = message.content;
          if (blocks.some((c) => c.type === "thinking" && c.thinking?.trim())) {
            // Thinking ends when the answer text or a tool call starts, or the message ends.
            const done =
              !(streaming ?? this.isStreaming) ||
              blocks.some((c) => c.type === "toolCall" || (c.type === "text" && c.text?.trim()));
            const now = Date.now();
            this.clUntimed ??= history;
            this.clThinkStart ??= message.timestamp ?? now;
            if (done) this.clThinkEnd ??= now;
            const secs = (this.clThinkEnd - this.clThinkStart) / 1000;
            const label = this.clUntimed
              ? "thought for some time"
              : secs < 1
                ? "thought briefly"
                : `thought for ${Math.round(secs)}s`;
            this.hiddenThinkingLabel = done ? label : "thinking…";
          }
          if (!leadsWithThinking(message)) return orig.call(this, message, streaming);
          // pi's own visibility (a click, ctrl+t) opens the thinking within the tree instead: pi
          // always draws the label, which becomes the row, and render adds the text under it.
          const overrides: Map<number, boolean> = this.thinkingVisibilityOverrides;
          const own = overrides.get(0);
          this.clThinkOpen = !(own ?? this.hideThinkingBlock);
          overrides.set(0, true);
          try {
            return orig.call(this, message, streaming);
          } finally {
            if (own === undefined) overrides.delete(0);
            else overrides.set(0, own);
          }
        },
    );
    patch(
      assistant,
      "render",
      (orig) =>
        function (this: Proto, width: number) {
          const th = theme();
          // Assistant text sits at column 3 like tree row content (pi pads it by 1, this adds 2)
          // and keeps the same 3 columns free on the right, plus the time column.
          this.clInner = Math.max(1, width - 4 - reserve());
          const lines: string[] = orig.call(this, this.clInner);
          this.clHeight = lines.length;
          this.clRowY = undefined;
          let group: string[] = [];
          let text = lines;
          const kind = kindOf(this);
          if (kind === "item" || kind === "closes") {
            // pi's output opens with a spacer and the collapsed thinking label; a tree row
            // replaces both. Their zero-width prompt marks move to the row's first and last lines.
            const [spacer = "", label = "", ...rest] = lines;
            const thought: string = this.hiddenThinkingLabel;
            // Open, the row and its text read bright; closed, muted.
            const color = this.clThinkOpen ? "text" : "muted";
            const paint = (s: string) =>
              thought === "thinking…" ? pulse(th, s, this.clThinkOpen) : th.fg(color, s);
            const row = th.italic(paint(thought));
            // Thinking alone reads as its own summary line: "Thought for 28s".
            const solo = paint(thought[0]!.toUpperCase() + thought.slice(1));
            let thinking: string[] = [];
            if (this.clThinkOpen) {
              const source = thinkingOf(this.lastMessage);
              if (this.clThinking?.source !== source) {
                const style = { color: (s: string) => theme().fg("text", s), italic: true };
                const md = new Markdown(source, 0, 0, this.markdownTheme, style);
                this.clThinking = { source, md };
              }
              thinking = this.clThinking.md.render(Math.max(1, width - 10)); // 7 in, 3 margin
            }
            group = [...groupLines(this, [row], thinking, width, th, solo)];
            text = rest;
            if (group.length) {
              group[group.length - 1] = marksOf(label) + group[group.length - 1];
              group[0] = spacer + group[0];
            } else if (text.length) text[0] = spacer + marksOf(label) + text[0]; // collapsed group
          }
          const body = text;
          const stamp = clock(this.lastMessage?.timestamp);
          // The ● copies the reply (see handleMouse), and shows ✓ for a moment after. It marks
          // text only: pi's note for an aborted, failed, or cut-off message goes without, like
          // other status lines.
          const replied = (this.lastMessage as Message | undefined)?.content.some(
            (c) => c.type === "text" && c.text?.trim(),
          );
          const justCopied = Date.now() - (this.clCopied ?? 0) < 1200;
          const bullet = !replied ? "" : justCopied ? th.fg("success", "✓") : th.fg("text", "●");
          text = memo(this, "clText", [body, th, stamp, bullet, width], () =>
            stampFirst(bulleted(body, bullet ? () => bullet : undefined), stamp, width, th),
          );
          this.clTextY = group.length;
          const bulletY = bullet ? text.findIndex((l) => !blank(l)) : -1;
          this.clBulletY = bulletY < 0 ? undefined : group.length + bulletY;
          return [...group, ...text];
        },
    );
    // Clicking the thinking row or its open text opens or closes it, like a tool row.
    patch(
      assistant,
      "handleMouse",
      (orig) =>
        function (this: Proto, event: Mouse) {
          const rowY: number | undefined = this.clRowY;
          const click = event.type === "click" && event.button === "left";
          // A click on the ● copies the reply's text as written (markdown).
          if (click && event.y === this.clBulletY && event.x <= 2) {
            const source = (this.lastMessage as Message).content
              .filter((c) => c.type === "text" && c.text?.trim())
              .map((c) => c.text!.trim())
              .join("\n\n");
            if (source) {
              copyToClipboard(source).then(
                () => {
                  this.clCopied = Date.now();
                  requestRender();
                  setTimeout(requestRender, 1250);
                },
                () => {}, // no clipboard: nothing to confirm
              );
              return { handled: true };
            }
          }
          if (click && event.y === this.clHeadY) return toggleGroup(this);
          if (click && event.y === this.clMoreY) {
            this.clFullBody = !this.clFullBody; // the thinking's toggle line
            requestRender();
            return { handled: true };
          }
          if (rowY !== undefined) {
            const onThinking = event.y >= rowY && event.y < this.clTextY;
            if (onThinking && click) {
              this.thinkingVisibilityOverrides.set(0, this.clThinkOpen); // hidden if it was open
              this.updateContent(this.lastMessage);
              return { handled: true };
            }
            if (event.y < this.clTextY) return undefined;
          }
          // pi laid the content out 2 columns in and 4 narrower; with a thinking row, the text
          // starts at clTextY here and after pi's spacer and label (2 lines) there.
          const y = rowY === undefined ? event.y : event.y - this.clTextY + 2;
          return orig.call(this, {
            ...event,
            x: event.x - 2,
            y,
            width: this.clInner ?? event.width - 4,
            height: this.clHeight,
          });
        },
    );
  });

  pi.on("session_shutdown", () => {
    working = false;
    runningBash.clear();
    for (const restore of restores.splice(0).reverse()) restore();
    for (const undo of overridden.values()) undo();
    overridden.clear();
    chat = undefined;
    session = undefined;
    calls.clear();
    indexed = 0;
    paired = "";
  });
}
