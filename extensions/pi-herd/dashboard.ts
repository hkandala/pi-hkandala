/**
 * The agent dashboard (← on an empty prompt, /agents dashboard), in three sections: this agent;
 * your agents (the ones this session started or watched, as a tree with the agents they started
 * under them; ended ones once `e` shows them); other agents (every other live agent). A clean
 * full-screen page: a margin, a title, a description, the list, and the keys pinned to the
 * bottom.
 * Keys: ↑↓ (PgUp PgDn) select, enter opens the agent in a popup (on this agent: closes), x twice
 * stops one of yours, e shows or hides ended ones, esc or q closes.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { tilde } from "./text.ts";
import {
  isKeyRelease,
  Key,
  matchesKey,
  type OverlayOptions,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** One agent as herd:update reports it. */
export type Row = {
  id: string;
  name: string;
  state: string;
  since: number;
  live: boolean;
  cwd: string;
  parent?: string;
  mine: boolean; // below this session: it can stop it
  watched: boolean;
  self?: boolean; // this agent
  sent: number;
  received: number;
};

// Nerd Font glyphs, as in pi-footer's agents tab.
const ICON = {
  sent: "\u{f1271}", // 󱉱 md-inbox-arrow-up-outline
  received: "\u{f1270}", // 󱉰 md-inbox-arrow-down-outline
  watching: "\u{f0150}", // 󰅐 md-clock-outline (this session waits on it)
  other: "\u{f15a1}", // 󱖡 md-handshake-outline (not started by this session)
};

/**
 * Agents as a tree: each one's children (by parent) right under it, with guides (`├ └ │`). At
 * every level, ended ones go last; otherwise the order given (the order pi-herd first listed them).
 */
function tree(agents: Row[]): { a: Row; guide: string }[] {
  const ids = new Set(agents.map((a) => a.id));
  const kids = Map.groupBy(agents, (a) => (a.parent && ids.has(a.parent) ? a.parent : ""));
  const out: { a: Row; guide: string }[] = [];
  const seen = new Set<string>(); // guards against a parent loop
  const walk = (parent: string, indent: string) => {
    const level = (kids.get(parent) ?? []).filter((a) => !seen.has(a.id));
    const sorted = [...level.filter((a) => a.live), ...level.filter((a) => !a.live)];
    sorted.forEach((a, i) => {
      const last = i === sorted.length - 1;
      seen.add(a.id);
      out.push({ a, guide: parent ? indent + (last ? "└ " : "├ ") : "" });
      walk(a.id, parent ? indent + (last ? "  " : "│ ") : "");
    });
  };
  walk("", "");
  return out;
}

const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
};
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
/** Cuts `text` to `width` with a … in the style at the cut (pi's truncateToWidth resets it). */
function cut(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  // Cut with no ellipsis, pi's result ends in a reset ("\x1b[0m", 4 chars): drop it, add the ….
  return width < 1 ? "" : `${truncateToWidth(text, width - 1, "").slice(0, -4)}…\x1b[0m`;
}
const fit = (s: string, w: number) => pad(cut(s, w), w);

/** The page's margin: 2 rows on top, 1 below (the keys stay low), 4 columns on each side. */
const MARGIN = { top: 2, bottom: 1, cols: 4 };

/** Body columns of a page `width` wide (less the margins). */
const bodyWidth = (width: number) => Math.max(10, width - 2 * MARGIN.cols);
/** Body rows of a page `height` rows tall (less the margins, the header and the keys). */
const bodyRows = (height: number) => Math.max(1, height - MARGIN.top - MARGIN.bottom - 6);

/**
 * The page: a margin (MARGIN), and inside it a title, a dim description, a rule,
 * the body, and the keys pinned to the bottom. Every row is padded to the full width (and the page to
 * the full height), so nothing of pi's screen shows around it.
 */
function page(
  theme: Theme,
  width: number,
  height: number,
  description: string,
  body: string[],
  keys: string,
  counter: string,
): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const inner = bodyWidth(width);
  const rows = bodyRows(height);
  const lines = [
    theme.bold(theme.fg("accent", "agents")),
    dim(description),
    dim("─".repeat(inner)),
    "",
    ...body.slice(0, rows),
    ...Array(Math.max(0, rows - body.length)).fill(""),
    "",
    pad(keys, inner - visibleWidth(counter)) + counter,
  ];
  const left = " ".repeat(MARGIN.cols);
  const out = [...Array(MARGIN.top).fill(""), ...lines.map((l) => left + fit(l, inner))];
  while (out.length < height) out.push("");
  return out.slice(0, height).map((l) => pad(l, width));
}

/** ctx.ui.custom options for the page: the whole screen (the page draws its own margin). */
export const FULL_SCREEN: { overlay: true; overlayOptions: OverlayOptions } = {
  overlay: true,
  overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
};

/** An agent's row: its tree guide (`├ `), and whether it is in `other agents`. */
type Line = { a: Row; guide: string; other?: boolean };

export class AgentsDashboard {
  private selected = 0; // the row; it follows its agent (pickedId) as rows move
  private pickedId: string | undefined;
  private top = 0;
  private showEnded = false;
  private armed = false; // x pressed once
  // An agent's row, or a line between them (a section's title, or the blank line before it).
  private rows: (Line | string)[] = [];
  private page = 1;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private data: () => { self: Row; agents: Row[]; others: Row[] },
    private act: { attach: (id: string) => void; stop: (id: string) => void },
    private done: () => void,
  ) {
    this.timer = setInterval(() => tui.requestRender(), 1000); // times and statuses
  }

  dispose() {
    clearInterval(this.timer);
  }

  invalidate() {}

  /** The agent at row `i`, if it is one. */
  private at(i: number) {
    const r = this.rows[i];
    return typeof r === "string" ? undefined : r;
  }

  /** Moves the selection by `d` rows onto the nearest agent (in that direction); ↑↓ wrap around. */
  private move(d: number, wrap = false) {
    const agents = this.agentRows(); // never empty: this agent's row is always there
    const [first, last] = [agents[0]!, agents.at(-1)!];
    const to = this.selected + d;
    if (wrap && d < 0 && this.selected === first) this.selected = last;
    else if (wrap && d > 0 && this.selected === last) this.selected = first;
    else
      this.selected =
        d < 0 ? (agents.findLast((i) => i <= to) ?? first) : (agents.find((i) => i >= to) ?? last);
    this.pickedId = this.at(this.selected)?.a.id;
    this.armed = false;
  }

  /** The indexes of the rows that are agents (not a section's title or a blank line). */
  private agentRows() {
    return this.rows.flatMap((r, i) => (typeof r === "string" ? [] : [i]));
  }

  render(width: number): string[] {
    const t = this.theme;
    const dim = (s: string) => t.fg("dim", s);
    const { self, agents, others } = this.data();
    const ended = agents.filter((a) => !a.live).length;
    const shown = tree(this.showEnded ? agents : agents.filter((a) => a.live));
    const section = (title: string, rows: Line[]) => (rows.length ? ["", title, ...rows] : []);
    this.rows = [
      "this agent",
      { a: self, guide: "" },
      ...section("your agents", shown),
      ...section(
        "other agents",
        others.map((a) => ({ a, guide: "", other: true })),
      ),
    ];
    // Rows move (an agent ends, one starts): keep the selection on its agent; x disarms if it's gone.
    const at = this.rows.findIndex((r) => typeof r !== "string" && r.a.id === this.pickedId);
    if (at >= 0) this.selected = at;
    else {
      this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
      this.move(0);
    }

    // Columns padded to their widest cell (by display width, for the glyphs).
    const marks = (r: Line) =>
      // 󱖡 only on an agent you watch but didn't start (not on other agents, or ones under it).
      [!r.a.mine && !r.a.self && !r.other && !r.guide && ICON.other, r.a.watched && ICON.watching]
        .filter(Boolean)
        .join(" ");
    const name = (r: Line) => r.guide + cut(r.a.name, 28);
    const named = (r: Line) => [name(r), marks(r)].filter(Boolean).join(" ");
    const when = (a: Row) =>
      a.since ? duration(Date.now() - a.since) + (a.live ? "" : " ago") : ""; // others: no time
    const all = this.rows.filter((r) => typeof r !== "string");
    const widest = (f: (r: Line) => string) => Math.max(0, ...all.map((r) => visibleWidth(f(r))));
    const [nameW, stateW, timeW] = [
      widest(named),
      widest((r) => r.a.state),
      widest((r) => when(r.a)),
    ];
    // The folder takes what the other columns leave: it is cut only when the page is too narrow.
    const counts = (a: Row) =>
      a.sent + a.received ? `${ICON.sent} ${a.sent} ${ICON.received} ${a.received}` : "";
    const countsW = widest((r) => counts(r.a));
    const room =
      bodyWidth(width) - (2 + nameW + 2 + stateW + 2 + timeW + 2) - (countsW && countsW + 2);
    const cwdW = Math.max(
      10,
      Math.min(
        room,
        widest((r) => tilde(r.a.cwd)),
      ),
    );
    const color = (s: string) =>
      s === "working" ? "accent" : s === "blocked" ? "warning" : ("dim" as const);
    const line = (i: number) => {
      const r = this.rows[i]!;
      if (typeof r === "string") return t.fg("muted", r); // a section's title
      const marker = i === this.selected ? t.fg("accent", "◆") : dim("◇"); // under the title's start
      const mark = marks(r);
      return (
        `${marker} ${dim(r.guide)}${t.fg("text", cut(r.a.name, 28))}${mark ? ` ${dim(mark)}` : ""}` +
        `${" ".repeat(Math.max(0, nameW - visibleWidth(named(r))))}  ` +
        `${t.fg(color(r.a.state), pad(r.a.state, stateW))}  ${dim(pad(when(r.a), timeW))}  ` +
        `${dim(pad(cut(tilde(r.a.cwd), cwdW), cwdW))}  ${dim(counts(r.a))}`
      );
    };

    const height = this.tui.terminal.rows;
    this.page = bodyRows(height);
    // Scrolling up keeps the selected agent's section title (and the blank line above it) in view.
    let lead = 0;
    while (lead < 2 && typeof this.rows[this.selected - lead - 1] === "string") lead++;
    this.top = Math.max(0, Math.min(this.top, this.selected - lead), this.selected - this.page + 1);
    // Every agent on the page by status (ended ones too, shown or not), in a fixed order.
    const everyone = [self, ...agents, ...others];
    const describe = ["working", "blocked", "idle", "done", "unknown", "stopped", "exited"]
      .map((st) => [everyone.filter((a) => a.state === st).length, st] as const)
      .filter(([n]) => n)
      .map(([n, st]) => `${n} ${st}`);
    const picked = this.at(this.selected)?.a;
    const keys = this.armed
      ? t.fg("warning", `press x again to stop ${picked?.name}`)
      : dim(
          [
            "↑↓ select",
            picked?.live && !picked.self && "enter view",
            picked?.live && picked.mine && "x stop",
            ended && (this.showEnded ? "e hide ended" : `e show ended (${ended})`),
            "esc close",
          ]
            .filter(Boolean)
            .join(" · "),
        );
    const agentRows = this.agentRows();
    const counter =
      this.rows.length > this.page
        ? dim(`${agentRows.indexOf(this.selected) + 1}/${agentRows.length}`)
        : "";
    const list: string[] = [];
    for (let i = this.top; i < Math.min(this.rows.length, this.top + this.page); i++)
      list.push(line(i));

    return page(t, width, height, describe.join(" · "), list, keys, counter);
  }

  handleInput(data: string) {
    if (isKeyRelease(data)) return;
    const picked = this.at(this.selected)?.a;
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) return this.done();
    if (matchesKey(data, "x") && picked?.live && picked.mine) {
      if (this.armed) this.act.stop(picked.id);
      this.armed = !this.armed;
      return this.tui.requestRender();
    }
    if (matchesKey(data, Key.up)) this.move(-1, true);
    else if (matchesKey(data, Key.down)) this.move(1, true);
    else if (matchesKey(data, Key.pageUp)) this.move(-this.page);
    else if (matchesKey(data, Key.pageDown)) this.move(this.page);
    else if (matchesKey(data, Key.enter) && picked?.self) return this.done();
    else if (matchesKey(data, Key.enter) && picked?.live) this.act.attach(picked.id);
    else if (matchesKey(data, "e")) this.showEnded = !this.showEnded;
    this.armed = false;
    this.tui.requestRender();
  }
}
