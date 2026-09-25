/**
 * pi-content-layout: a compact, minimal transcript.
 * - Tool calls and thinking between two pieces of assistant text form one group: a summary line
 *   ("Read 3 files, ran 2 commands") with a ├ └ tree of one-row calls under it.
 *   Running calls show a live timer, edits keep their diff, failures show the error.
 *   Click a row (fullscreen TUI mode) or press ctrl+o for pi's full view.
 * - Thinking is a tree row: "thinking…" while it streams, then "thought for Xs" (click to open).
 * - User messages sit in a rounded border like pi-footer's prompt box.
 * - Each piece of assistant text starts with a ● bullet; summary lines align with its text.
 *
 * Config (optional): ~/.pi/agent/extensions/pi-content-layout.json
 *   { "diffs": true }
 *
 * ponytail: pi has no public API for restyling its own tool rows or messages, so this patches
 * methods of pi's exported components (restored on shutdown, and falling back to pi's own on any
 * error). It may need updates when pi's components change, and it conflicts with other extensions
 * that patch the same components.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  getAgentDir,
  renderDiff,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Config = { diffs?: boolean };

type Node = { children?: Node[] };
type Proto = Record<string, any>; // oxlint-disable-line no-explicit-any
type Result = { content: { type: string; text?: string }[]; details?: { diff?: string } };
type Tool = Node & {
  toolName: string;
  args?: Record<string, unknown>;
  result?: Result & { isError?: boolean };
  isPartial: boolean;
  expanded: boolean;
  executionStarted: boolean;
  hideComponent: boolean;
  cwd: string;
  ui: Node & { requestRender(): void };
  setExpanded(expanded: boolean): void;
};
type Block = { type: string; text?: string; thinking?: string };
type Message = { content: Block[]; timestamp?: number; stopReason?: string };
type Mouse = { type: string; button: string; x: number; y: number; width: number; height: number };
type State = "running" | "done" | "error";

const ERROR_LINES = 3; // lines of a failed call's output shown under its row
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

function readConfig(): Config {
  try {
    return JSON.parse(
      readFileSync(join(getAgentDir(), "extensions", "pi-content-layout.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const lineCount = (s: string) => (s ? s.split("\n").length : 0);
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
// The exit code is already in the row; pi's "(no output)" placeholder adds nothing.
const errorLinesOf = cached((r) =>
  outputOf(r)
    .split("\n")
    .filter((l) => l.trim() && !/^\(no output\)$|exited with code/.test(l)),
);
// ponytail: cached with the theme's colors at the time; a theme switch keeps them.
const diffOf = cached((r) => renderDiff(r.details?.diff ?? "").split("\n"));

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
  // ponytail: counts output lines, so pi's truncation notes count too.
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
const described = new WeakMap<Result, [string, string]>();

/** Lines shown under a row: the error, or an edit's diff. */
function body(t: Tool, theme: Theme, config: Config): string[] {
  if (!t.result || t.isPartial) return [];
  if (t.result.isError) {
    const lines = errorLinesOf(t.result);
    const shown = t.toolName === "bash" ? lines.slice(-ERROR_LINES) : lines.slice(0, ERROR_LINES);
    return shown.map((l) => theme.fg("error", l));
  }
  if (t.toolName !== "edit" || !t.result.details?.diff || config.diffs === false) return [];
  return diffOf(t.result);
}

/** Rounded border like pi-footer's prompt box around `lines`, which fit width - 4. */
function frame(lines: string[], width: number, theme: Theme): string[] {
  const inner = Math.max(1, width - 4);
  const bar = "─".repeat(Math.max(0, width - 2));
  const side = theme.fg("muted", "│");
  return [
    theme.fg("muted", `╭${bar}╮`),
    ...lines.map((l) => {
      const text = truncateToWidth(l, inner);
      return `${side} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${side}`;
    }),
    theme.fg("muted", `╰${bar}╯`),
  ];
}

// --- Groups -------------------------------------------------------------------------------------
// Each chat child renders its own part of a group, so pi's click routing (by child height) holds.
// A child is a group "item" (tool row, or an assistant message that opens with collapsed
// thinking), an item that "closes" the group (that thinking is followed by text), "skip" (renders
// nothing, e.g. an assistant message with only tool calls), or a "boundary".

type Kind = "item" | "closes" | "skip" | "boundary";

const visible = (c: Block) =>
  !!(c.type === "text" ? c.text : c.type === "thinking" ? c.thinking : "")?.trim();

/** Whether an assistant message opens with collapsed thinking (so it becomes a tree row). */
function leadsWithThinking(a: Proto) {
  const first = (a.lastMessage as Message | undefined)?.content.find(visible);
  return (
    first?.type === "thinking" && (a.thinkingVisibilityOverrides.get(0) ?? a.hideThinkingBlock)
  );
}

function kindOf(node: unknown): Kind {
  if (node instanceof ToolExecutionComponent) {
    const t = node as unknown as Tool;
    return t.hideComponent ? "skip" : t.expanded ? "boundary" : "item";
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
  if (leadsWithThinking(a)) return text ? "closes" : "item";
  return text ? "boundary" : "skip";
}

let tui: Node | undefined; // root of pi's component tree, to find each component's chat container
function parentOf(node: Node, target: Node, depth = 4): Node | undefined {
  if (!node.children || depth < 0) return undefined;
  if (node.children.includes(target)) return node;
  for (const child of node.children) {
    const found = parentOf(child, target, depth - 1);
    if (found) return found;
  }
  return undefined;
}

/** Kind of the nearest non-skipped sibling in `dir`. */
function neighbor(list: unknown[], i: number, dir: 1 | -1): Kind {
  for (i += dir; i >= 0 && i < list.length; i += dir) {
    const kind = kindOf(list[i]);
    if (kind !== "skip") return kind;
  }
  return "boundary";
}

/**
 * When a group ends the chat, its dense tree rows would sit tight against the prompt, so the chat
 * gets one more blank line then. Inside the chat, so it scrolls with the content; text and status
 * lines keep just pi's own spacer.
 */
const paddedChats = new Set<Proto>();
function padChat(chat: Proto | undefined) {
  if (!chat || paddedChats.has(chat)) return;
  paddedChats.add(chat);
  const render = chat.render;
  chat.render = function (width: number) {
    const lines: string[] = render.call(this, width);
    try {
      return neighbor(this.children, this.children.length, -1) === "item" ? [...lines, ""] : lines;
    } catch {
      return lines; // a layout bug must never crash pi
    }
  };
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
 * A member's lines: the summary line if it opens the group, its ├/└ row, and its body. A member
 * alone in its group shows `solo` instead, when given, as the summary line with no tree.
 * Sets node.clRowY to the row's line, for click handling.
 */
function groupLines(
  node: Proto,
  row: string,
  rowBody: string[],
  width: number,
  theme: Theme,
  solo?: string,
) {
  node.clParent ??= tui && parentOf(tui, node);
  padChat(node.clParent);
  const list: unknown[] = node.clParent?.children ?? [node];
  if (list[node.clIndex] !== node) node.clIndex = list.indexOf(node);
  const i: number = node.clIndex;
  const first = neighbor(list, i, -1) !== "item";
  const last = kindOf(node) === "closes" || !["item", "closes"].includes(neighbor(list, i, 1));
  const lines: string[] = [];
  if (first && last && solo) {
    lines.push("", `   ${solo}`);
    node.clRowY = 1;
  } else {
    if (first) {
      const members = [];
      for (let j = i; j < list.length; j++) {
        const kind = kindOf(list[j]);
        if (kind === "boundary") break;
        if (kind !== "skip") members.push(list[j]);
        if (kind === "closes") break;
      }
      lines.push("", `   ${summary(members, theme)}`); // aligned with assistant text
    }
    node.clRowY = lines.length;
    const rail = last ? " " : theme.fg("dim", "│");
    lines.push(
      `   ${theme.fg("dim", last ? "└" : "├")} ${row}`,
      ...rowBody.map((l) => `   ${rail}   ${l}`),
    );
  }
  // Right margin matches the left indent of the row text.
  return lines.map((l) => truncateToWidth(l, Math.max(1, width - 3), theme.fg("muted", "…")));
}

function renderTool(t: Tool & Proto, width: number, theme: Theme, config: Config): string[] {
  const state = stateOf(t);
  if (t.executionStarted) t.clStart ??= Date.now();
  if (state !== "running" && t.clStart) t.clEnd ??= Date.now();
  let info = t.result && described.get(t.result);
  if (!info) {
    info = describe(t);
    if (t.result) described.set(t.result, info);
  }
  const [target, detail] = info;
  const seconds = t.clStart ? ((t.clEnd ?? Date.now()) - t.clStart) / 1000 : 0;
  let time = seconds >= 1 ? `${seconds.toFixed(1)}s` : "";
  // While running, a live timer (pi's spinner keeps frames coming) shows the call is in progress.
  if (state === "running") time = t.clStart ? `running ${Math.floor(seconds)}s` : "";
  const result = state === "error" ? detail : [detail, time].filter(Boolean).join(" · ");
  const color = state === "error" ? "error" : state === "done" ? "muted" : "dim";
  const name = t.toolName.padEnd(5);
  const tail = result ? ` · ${result}` : "";
  // The target gives way so the result stays visible: 5 columns of tree before the row, 3 after.
  const room = width - 8 - visibleWidth(name) - 1 - visibleWidth(tail);
  const row =
    theme.italic(theme.fg(color, name)) +
    // pi's truncation resets colors before the ellipsis, so it gets its own.
    ` ${theme.fg(color, truncateToWidth(target, Math.max(1, room), theme.fg(color, "…")))}` +
    theme.fg(state === "error" ? "error" : "dim", tail);
  return groupLines(t, row, body(t, theme, config), width, theme);
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

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || restores.length) return;
    const config = readConfig();
    const theme = () => ctx.ui.theme;
    // pi calls widget factories right away with the TUI; that is all this widget is for.
    ctx.ui.setWidget("pi-content-layout", (root) => {
      tui = root as unknown as Node;
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget("pi-content-layout", undefined);

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
    // pi routes clicks by its own layout; a click on a compact row or its body opens the full view.
    patch(
      tool,
      "handleMouse",
      (orig) =>
        function (this: Tool & Proto, event: Mouse) {
          if (kindOf(this) !== "item") return orig.call(this, event);
          if (event.type !== "click" || event.button !== "left" || event.y < this.clRowY)
            return undefined;
          this.setExpanded(true);
          this.ui.requestRender();
          return { handled: true };
        },
    );

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
          const inner = Container.prototype.render.call(this, Math.max(1, width - 4));
          const lines = frame(inner, width, theme());
          // pi's prompt marks stay at column 0 of the first and last lines, as pi places them:
          // terminals like Ghostty start a fresh line at the opening mark when it isn't.
          lines[0] = mark("A") + lines[0];
          lines[lines.length - 1] = mark("B") + mark("C") + lines[lines.length - 1];
          return lines;
        },
    );

    const assistant = AssistantMessageComponent.prototype as unknown as Proto;
    // Thinking is collapsed by default and timed: "thinking…" while it streams, then
    // "thought for Xs", or "thought briefly" under a second. Timed from the message's start, since
    // some providers deliver thinking in one burst. pi saves no thinking time, so messages loaded
    // from history show "thought for some time".
    // ponytail: one label per message, and ctrl+t only toggles messages that already exist.
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
          return orig.call(this, message, streaming);
        },
    );
    patch(
      assistant,
      "render",
      (orig) =>
        function (this: Proto, width: number) {
          const th = theme();
          // Assistant text sits at column 3 like tree row content (pi pads it by 1, this adds 2)
          // and keeps the same 3 columns free on the right.
          const lines: string[] = orig.call(this, Math.max(1, width - 4));
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
            group = groupLines(this, row, [], width, th, solo);
            group[group.length - 1] = marksOf(label) + group[group.length - 1];
            group[0] = spacer + group[0];
            text = rest;
          }
          // A bullet marks the text.
          let first = true;
          text = text.map((l) => {
            if (!visibleWidth(l)) return l;
            const prefix = first ? ` ${th.fg("text", "●")}` : "  ";
            first = false;
            return indent(l, prefix);
          });
          return [...group, ...text];
        },
    );
    // Clicking the thinking row opens it (pi's full rendering then takes over this message).
    patch(
      assistant,
      "handleMouse",
      (orig) =>
        function (this: Proto, event: Mouse) {
          const rowY: number | undefined = this.clRowY;
          if (rowY !== undefined) {
            if (event.y === rowY && event.type === "click" && event.button === "left") {
              this.thinkingVisibilityOverrides.set(0, false);
              this.updateContent(this.lastMessage);
              return { handled: true };
            }
            if (event.y <= rowY) return undefined;
          }
          // pi laid the content out 2 columns in, 4 narrower and, with a thinking row, 1 row lower.
          const y = rowY === undefined ? event.y : event.y - rowY + 1;
          return orig.call(this, {
            ...event,
            x: event.x - 2,
            y,
            width: event.width - 4,
            height: this.clHeight,
          });
        },
    );
  });

  pi.on("session_shutdown", () => {
    for (const restore of restores.splice(0).reverse()) restore();
    for (const chat of paddedChats) delete chat.render;
    paddedChats.clear();
    tui = undefined;
  });
}
