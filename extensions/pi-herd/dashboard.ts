/**
 * /agents dashboard: the agents this session started or watched, as a tree with the agents they
 * started under them (ended ones too, until `e` hides them), then the other live agents. A clean
 * full-screen page: an equal margin, a title, a description, the list, and the keys pinned to the
 * bottom (the same page as pi-bash-bg's dashboard and log viewer).
 * Keys: ↑↓ (PgUp PgDn) select, enter views, x twice stops one of yours, e hides or shows ended
 * ones, esc or q closes.
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
 * every level, stopped ones go last; otherwise the order given (the order pi-herd first listed them).
 */
function tree(agents: Row[]): { a: Row; guide: string }[] {
  const ids = new Set(agents.map((a) => a.id));
  const kids = Map.groupBy(agents, (a) => (a.parent && ids.has(a.parent) ? a.parent : ""));
  const out: { a: Row; guide: string }[] = [];
  const seen = new Set<string>(); // guards against a parent loop
  const walk = (parent: string, indent: string) => {
    const level = (kids.get(parent) ?? []).filter((a) => !seen.has(a.id));
    const sorted = [
      ...level.filter((a) => a.state !== "stopped"),
      ...level.filter((a) => a.state === "stopped"),
    ];
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

/** The page's margin, the same on all four sides (a row is about two columns wide). */
const MARGIN = { rows: 1, cols: 2 };

// The page (cut, MARGIN, bodyWidth, bodyRows, page, FULL_SCREEN) is kept in sync with
// pi-bash-bg/dashboard.ts: they are separate packages, so each has its copy.

/** Body columns of a page `width` wide (less the margins). */
const bodyWidth = (width: number) => Math.max(10, width - 2 * MARGIN.cols);
/** Body rows of a page `height` rows tall (less the margins, the title and the keys). */
const bodyRows = (height: number) => Math.max(1, height - 2 * MARGIN.rows - 5);

/**
 * The page: an equal margin on all four sides, and inside it a title, a dim description, the
 * body, and the keys pinned to the bottom. Every row is padded to the full width (and the page to
 * the full height), so nothing of pi's screen shows around it.
 */
function page(
  theme: Theme,
  width: number,
  height: number,
  head: { title: string; description: string },
  body: string[],
  keys: string,
  counter = "",
): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const inner = bodyWidth(width);
  const rows = bodyRows(height);
  const lines = [
    theme.bold(theme.fg("accent", head.title)),
    dim(head.description),
    "",
    ...body.slice(0, rows),
    ...Array(Math.max(0, rows - body.length)).fill(""),
    "",
    pad(keys, inner - visibleWidth(counter)) + counter,
  ];
  const left = " ".repeat(MARGIN.cols);
  const out = [...Array(MARGIN.rows).fill(""), ...lines.map((l) => left + fit(l, inner))];
  while (out.length < height) out.push("");
  return out.slice(0, height).map((l) => pad(l, width));
}

/** ctx.ui.custom options for the page: the whole screen (the page draws its own margin). */
export const FULL_SCREEN: { overlay: true; overlayOptions: OverlayOptions } = {
  overlay: true,
  overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
};

export class AgentsDashboard {
  private selected = 0; // the row; it follows its agent (pickedId) as rows move
  private pickedId: string | undefined;
  private top = 0;
  private showEnded = true;
  private armed = false; // x pressed once
  // An agent's row, or a line between them (the blank line and heading before other agents).
  private rows: ({ a: Row; guide: string } | string)[] = [];
  private page = 1;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private data: () => { agents: Row[]; others: Row[] },
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

  /** Moves the selection by `d` rows, skipping the lines between agents. */
  private move(d: number) {
    const step = d < 0 ? -1 : 1;
    let i = Math.max(0, Math.min(this.rows.length - 1, this.selected + d));
    while (this.rows[i] !== undefined && !this.at(i)) i += step;
    if (this.at(i)) this.selected = i;
    this.pickedId = this.at(this.selected)?.a.id;
    this.armed = false;
  }

  render(width: number): string[] {
    const t = this.theme;
    const dim = (s: string) => t.fg("dim", s);
    const { agents, others } = this.data();
    const ended = agents.filter((a) => !a.live).length;
    const shown = tree(this.showEnded ? agents : agents.filter((a) => a.live));
    this.rows = [
      ...shown,
      ...(others.length ? ["", "other agents · live, not started or watched by you"] : []),
      ...others.map((a) => ({ a, guide: "" })),
    ];
    // Rows move (an agent ends, one starts): keep the selection on its agent; x disarms if it's gone.
    const at = this.rows.findIndex((r) => typeof r !== "string" && r.a.id === this.pickedId);
    if (at >= 0) this.selected = at;
    else {
      this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
      this.move(0);
    }

    // Columns padded to their widest cell (by display width, for the glyphs).
    const marks = (r: { a: Row; guide: string }) =>
      [!r.a.mine && !r.guide && ICON.other, r.a.watched && ICON.watching].filter(Boolean).join(" ");
    const name = (r: { a: Row; guide: string }) => r.guide + cut(r.a.name, 28);
    const named = (r: { a: Row; guide: string }) => [name(r), marks(r)].filter(Boolean).join(" ");
    const when = (a: Row) =>
      a.since ? duration(Date.now() - a.since) + (a.live ? "" : " ago") : ""; // others: no time
    const all = this.rows.filter((r) => typeof r !== "string");
    const widest = (f: (r: { a: Row; guide: string }) => string) =>
      Math.max(0, ...all.map((r) => visibleWidth(f(r))));
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
      if (typeof r === "string") return dim(r && `  ${r}`);
      const marker = i === this.selected ? t.fg("accent", "▸") : " ";
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
    this.top = Math.max(0, Math.min(this.top, this.selected), this.selected - this.page + 1);
    const live = agents.length - ended;
    const describe = [
      `${live} live`,
      ended && `${ended} ended${this.showEnded ? "" : " (hidden)"}`,
      others.length && `${others.length} other`,
      "the agents you started or watched, and the agents they started",
    ].filter(Boolean);
    const picked = this.at(this.selected)?.a;
    const keys = this.armed
      ? t.fg("warning", `press x again to stop ${picked?.name}`)
      : dim(
          [
            this.rows.length && "↑↓ select",
            picked?.live && "enter view",
            picked?.live && picked.mine && "x stop",
            ended && (this.showEnded ? "e hide ended" : `e show ended (${ended})`),
            "esc close",
          ]
            .filter(Boolean)
            .join(" · "),
        );
    const counter =
      this.rows.length > this.page ? dim(`${this.selected + 1}/${this.rows.length}`) : "";
    const list = this.rows.length
      ? []
      : [dim("No agents yet: the ones you start or watch show here.")];
    for (let i = this.top; i < Math.min(this.rows.length, this.top + this.page); i++)
      list.push(line(i));

    return page(
      t,
      width,
      height,
      { title: "agents", description: describe.join(" · ") },
      list,
      keys,
      counter,
    );
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
    if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.pageUp)) this.move(-this.page);
    else if (matchesKey(data, Key.pageDown)) this.move(this.page);
    else if (matchesKey(data, Key.enter) && picked?.live) this.act.attach(picked.id);
    else if (matchesKey(data, "e")) this.showEnded = !this.showEnded;
    this.armed = false;
    this.tui.requestRender();
  }
}
