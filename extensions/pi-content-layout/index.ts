/**
 * pi-content-layout: a compact, minimal transcript.
 * - Tool calls and thinking between two pieces of assistant text form one group: a summary line
 *   ("Read 3 files, ran 2 commands") with a ├ └ tree of one-row calls under it.
 *   Running calls show a live timer, edits show their diff, failures are red.
 *   Click a row (fullscreen TUI mode) to open or close its content, which hangs off a └ under it,
 *   and its full input; ctrl+o opens or closes all tool rows, clicked ones too.
 * - Thinking is a tree row: "thinking…" while it streams, then "thought for Xs" (click to open).
 * - User messages sit in a rounded border like pi-footer's prompt box; compaction and branch
 *   summaries, skills, and extension messages in a dashed one, labeled in its top edge.
 * - User bash (!cmd) and info panels (pi's or extensions') read like assistant text, without rules.
 * - Each piece of assistant text starts with a ● bullet; summary lines align with its text.
 * - ctrl+shift+o collapses or expands all groups to their summary line (saved); click a summary
 *   line for its own group.
 * - ctrl+shift+t cycles timestamps (off, relative, absolute; saved): when messages, groups, and
 *   user bash happened, and how long tool calls took, in a column on the right.
 *
 * Config (optional): ~/.pi/agent/extensions/pi-content-layout.json
 *   { "autoExpandedTools": ["edit"], "maxExpandedLines": 0, "collapseGroups": false,
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
  getAgentDir,
  renderDiff,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Key,
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Stamps = "off" | "relative" | "absolute";
type Config = {
  autoExpandedTools?: string[];
  maxExpandedLines?: number;
  collapseGroups?: boolean;
  timestamps?: Stamps;
  timestampFormat?: "24h" | "12h";
};

type Node = { children?: Node[] };
type Proto = Record<string, any>; // oxlint-disable-line no-explicit-any
type Result = { content: { type: string; text?: string }[]; details?: { diff?: string } };
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
type State = "running" | "done" | "error";

/** Summary wording per tool: [verb, noun, plural noun]. Others read "ran <tool> N times". */
type Wording = [string, string, string?];
const SEARCHED: Wording = ["searched", "pattern"];
const WORDING: Record<string, Wording> = {
  read: ["read", "file"],
  edit: ["edited", "file"],
  write: ["wrote", "file"],
  bash: ["ran", "command"],
  grep: SEARCHED,
  find: SEARCHED,
  ls: ["listed", "directory", "directories"],
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
 * the batch's (`bound`: the call took at most that long).
 */
function timesOf(t: Tool & Proto): { start?: number; end?: number; bound?: boolean } {
  if (t.clStart) return { start: t.clStart, end: t.clEnd };
  if (t.clCall === undefined) t.clCall = callOf(t.toolCallId) ?? null;
  return { start: t.clCall?.start, end: t.result?.timestamp, bound: t.clCall?.batch > 1 };
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
const untab = (s: string) => s.replace(/\t/g, "   ");
const linesOf = cached((r) => untab(outputOf(r)).split("\n"));
// pi marks skipped lines with "..."; only the ones between hunks say something.
const diffOf = (r: Result) =>
  renderDiff((r.details?.diff ?? "").replace(/^\s*\.\.\.\n|\n\s*\.\.\.$/g, "")).split("\n");

function shortPath(path: string, cwd: string) {
  if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
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
      default:
        return oneLine(str(Object.values(a).find((v) => typeof v === "string")));
    }
  })();
  const state = stateOf(t);
  if (state === "error") {
    const exit = out.match(/exit(?:ed with)? code (\d+)/i)?.[1];
    return [target, exit ? `exit ${exit}` : "error"];
  }
  if (t.toolName === "write") return [target, plural(lineCount(str(a.content)), "line")];
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
  if (open && t.toolName === "write")
    return untab(str(t.args?.content).trimEnd())
      .split("\n")
      .map((l) => theme.fg("muted", l));
  if (!open || !t.result) return [];
  if (t.toolName === "edit" && t.result.details?.diff) return diffOf(t.result);
  const color = t.result.isError ? "error" : "muted";
  return linesOf(t.result).map((l) => theme.fg(color, l)); // live output while running
}

/**
 * Rounded border like pi-footer's prompt box around `lines`, which fit width - 4; dashed with a
 * title in its top edge for special messages. A stamp sits in the top edge's time column.
 * Cached on `node`.
 */
function frame(
  node: Proto,
  lines: string[],
  width: number,
  theme: Theme,
  title?: string,
  stamp = "",
  margin = "",
) {
  return memo(node, "clFrame", [lines, width, theme, title, stamp, margin], () =>
    boxed(lines, width - 2 * margin.length, theme, title, stamp).map((l) => margin + l + margin),
  );
}
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
/** The most lines open content shows (0: no limit). */
let maxLines = 0;

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

/** Summary line from a group's tool calls: "Read 3 files, ran 2 commands, 1 failed". */
function summary(members: unknown[], theme: Theme): string {
  const counts = new Map<Wording, number>();
  let failed = 0;
  for (const m of members) {
    if (!(m instanceof ToolExecutionComponent)) continue;
    const t = m as unknown as Tool;
    if (stateOf(t) === "error") failed++;
    const wording = (WORDING[t.toolName] ??= [`ran ${t.toolName}`, "time"]); // one entry per tool
    counts.set(wording, (counts.get(wording) ?? 0) + 1);
  }
  const text =
    [...counts].map(([[verb, noun, nouns], n]) => `${verb} ${plural(n, noun, nouns)}`).join(", ") ||
    "thought";
  const line = theme.fg("muted", text[0]!.toUpperCase() + text.slice(1));
  return failed
    ? `${line}${theme.fg("muted", ", ")}${theme.fg("error", `${failed} failed`)}`
    : line;
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
  let head: string | undefined; // the summary line, when the member opens the group
  const started = first ? clock(startOf(node)) : "";
  if (first && !alone) {
    const members = [];
    for (let j = i; j < list.length; j++) {
      const kind = kindOf(list[j]);
      if (kind === "boundary") break;
      if (kind !== "skip") members.push(list[j]);
      if (kind === "closes") break;
    }
    head = summary(members, theme);
  }
  const collapsed = !alone && ((first ? node : groupStart(list, i)).clCollapsed ?? collapseGroups);
  node.clHeadY = head ? 1 : undefined;
  node.clGroupCollapsed = collapsed;
  const rowY = (node.clRowY = collapsed ? Infinity : alone ? 1 : head ? 2 : 0);
  const deps = [row, rowBody, width, theme, last, alone, head, started, stamp, collapsed];
  return memo(node, "clGroup", deps, () => {
    if (collapsed) return head ? ["", stamped(`   ${head}`, started, width, theme)] : [];
    // Open content hangs off a └ under the row's name (column 5), one space before it like the
    // rows, and a blank line follows it unless the group ends (a spacer follows then).
    // Wrapped to fit, so nothing open is cut off: 3 columns in, 2 of rail, 2 for the └, 3 after.
    const fit = Math.max(1, width - (alone ? 8 : 10));
    let wrapped = rowBody.flatMap((l) => (visibleWidth(l) > fit ? wrapTextWithAnsi(l, fit) : [l]));
    if (maxLines > 0 && wrapped.length > maxLines) {
      const more = plural(wrapped.length - maxLines, "more line");
      wrapped = [...wrapped.slice(0, maxLines), theme.fg("dim", `… ${more}`)];
    }
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
        ...hung.map((l) => `   ${rail} ${l}`),
      ];
    }
    // Right margin matches the left indent of the row text.
    lines = lines.map((l) => truncateToWidth(l, Math.max(1, width - 3), theme.fg("muted", "…")));
    if (head || alone) lines[1] = stamped(lines[1]!, started, width, theme);
    if (!alone) lines[rowY] = stamped(lines[rowY]!, stamp, width, theme);
    return lines;
  });
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
  const color = state === "error" ? "error" : state === "done" ? "muted" : "dim";
  const name = t.toolName.padEnd(5);
  const tail = result ? ` · ${result}` : "";
  // The target's room: 5 columns of tree before the row, 3 after, and the time column.
  const room = Math.max(1, width - 8 - visibleWidth(name) - 1 - reserve());
  // Closed, a long target gives way to the result and ends in … (pi's truncation resets colors
  // before it, so it gets its own). Open, it wraps in full under its start (a bash command with its
  // own line breaks), the result after it, or on a line of its own when it doesn't fit.
  let lines: string[];
  if (isOpen(t, config)) {
    const full = t.toolName === "bash" ? untab(str(t.args?.command).trim()) : target;
    lines = full.split("\n").flatMap((l) => wrapTextWithAnsi(l, room));
    if (tail && visibleWidth(lines.at(-1)! + tail) > room) lines.push("");
  } else {
    const fit = Math.max(1, room - visibleWidth(tail));
    lines = [truncateToWidth(target, fit, theme.fg(color, "…"))];
  }
  const row = lines.map(
    (l, i) =>
      (i ? " ".repeat(visibleWidth(name) + 1) : `${theme.italic(theme.fg(color, name))} `) +
      theme.fg(color, l),
  );
  row[row.length - 1] += theme
    .fg(state === "error" ? "error" : "dim", lines.at(-1) ? tail : tail.slice(1))
    // An edit's line counts in the diff's colors.
    .replace(
      /\+(\d+) -(\d+)/,
      (_, added, removed) =>
        `${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}${theme.getFgAnsi("dim")}`,
    );
  return groupLines(t, row, body(t, theme, config), width, theme, undefined, stamp);
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
  /** A click on a group's summary line (on the member that opens it) collapses or expands it. */
  const toggleGroup = (lead: Proto) => {
    lead.clCollapsed = !lead.clGroupCollapsed;
    requestRender();
    return { handled: true };
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || restores.length) return;
    const config = readConfig();
    collapseGroups = config.collapseGroups === true;
    maxLines = Math.max(0, Math.floor(Number(config.maxExpandedLines) || 0));
    if (!Array.isArray(config.autoExpandedTools)) config.autoExpandedTools = ["edit"];
    stamps = STAMPS.includes(config.timestamps!) ? config.timestamps! : "off";
    twelveHour = config.timestampFormat === "12h";
    session = ctx.sessionManager as unknown as Session;
    const theme = () => ctx.ui.theme;
    // pi calls widget factories right away with the TUI; that is all this widget is for.
    ctx.ui.setWidget("pi-content-layout", (root) => {
      chat = (root as unknown as Node).children?.[0]?.children?.[2];
      requestRender = () => (root as unknown as Tool["ui"]).requestRender();
      return { render: () => [], invalidate() {} };
    });
    // Relative times ("12m ago") age without anything else to redraw them.
    const timer = setInterval(() => stamps === "relative" && requestRender(), 30_000);
    restores.push(() => clearInterval(timer));
    ctx.ui.setWidget("pi-content-layout", undefined);
    // When a group ends the chat, its dense tree rows would sit tight against the prompt, so the
    // chat gets one more blank line then. Inside the chat, so it scrolls with the content; text
    // and status lines keep just pi's own spacer.
    if (chat)
      override(chat, (orig, width) => {
        const lines = orig(width);
        return neighbor(chat!.children, chat!.children.length, -1) === "item"
          ? [...lines, ""]
          : lines;
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
          this.clOpen = undefined;
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
          this.clOpen = !isOpen(this, config);
          this.ui.requestRender();
          return { handled: true };
        },
    );

    /** A box's content without its background and padding, to fit a frame. */
    const inner = (box: Proto, width: number, margin = 4): string[] =>
      Container.prototype.render.call(box, Math.max(1, width - margin));

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
          // A column in on each side, so the text lines up with assistant text.
          const body = inner(this, width, 6);
          const lines = [...frame(this, body, width, theme(), undefined, stamp, " ")];
          // pi's prompt marks stay at column 0 of the first and last lines, as pi places them:
          // terminals like Ghostty start a fresh line at the opening mark when it isn't.
          lines[0] = mark("A") + lines[0];
          lines[lines.length - 1] = mark("B") + mark("C") + lines[lines.length - 1];
          return lines;
        },
    );

    // Special messages (compaction and branch summaries, skills, extension messages pi draws
    // itself): pi's background box becomes a dashed border with pi's label in it, and the time in
    // its top edge. Their first two lines are the label and a blank line.
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
          if (this.customComponent) return orig.call(this, width); // the extension's own look
          return ["", ...special(this.box, width, this.message.customType, this.message.timestamp)];
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
    // Thinking is collapsed by default and timed: "thinking…" while it streams, then
    // "thought for Xs", or "thought briefly" under a second. Timed from the message's start, since
    // some providers deliver thinking in one burst. pi saves no thinking time, so messages loaded
    // from history show "thought for some time".
    // One label per message; ctrl+t only toggles messages that already exist.
    patch(
      assistant,
      "updateContent",
      (orig) =>
        function (this: Proto, message: Message, streaming?: boolean) {
          // pi's constructor makes the first call: with thinking already there, it's history.
          const history = !this.clInit;
          if (history) this.hideThinkingBlock = true;
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
            const row = th.italic(th.fg("muted", thought));
            // Thinking alone reads as its own summary line: "Thought for 28s".
            const solo = th.fg("muted", thought[0]!.toUpperCase() + thought.slice(1));
            let thinking: string[] = [];
            if (this.clThinkOpen) {
              const source = thinkingOf(this.lastMessage);
              if (this.clThinking?.source !== source) {
                const style = { color: (s: string) => theme().fg("thinkingText", s), italic: true };
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
          text = memo(this, "clText", [body, th, stamp, width], () =>
            stampFirst(
              bulleted(body, (s) => th.fg("text", s)),
              stamp,
              width,
              th,
            ),
          );
          this.clTextY = group.length;
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
          if (click && event.y === this.clHeadY) return toggleGroup(this);
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
