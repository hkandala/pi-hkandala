/**
 * /background dashboard: this session's jobs, running first, then finished ones (until `e` hides
 * them), as a page (see page()). Keys: ↑↓ (PgUp PgDn) select, enter opens the log viewer, x twice kills, e hides or shows
 * finished jobs, esc or q closes.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  Key,
  matchesKey,
  type OverlayOptions,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** One job as the dashboard shows it. */
export type Row = {
  pid: number;
  state: string; // running, exit 0, exit 1, killed, …
  elapsed: string;
  command: string;
  cwd: string;
};

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
/** Cuts `text` to `width` with a … in the style at the cut (pi's truncateToWidth resets it). */
export function cut(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  // Cut with no ellipsis, pi's result ends in a reset ("\x1b[0m", 4 chars): drop it, add the ….
  return width < 1 ? "" : `${truncateToWidth(text, width - 1, "").slice(0, -4)}…\x1b[0m`;
}
const fit = (s: string, w: number) => pad(cut(s, w), w);

/** The page's margin, the same on all four sides (a row is about two columns wide). */
const MARGIN = { rows: 1, cols: 2 };

// The page (cut, MARGIN, bodyWidth, bodyRows, page, FULL_SCREEN) is kept in sync with
// pi-herd/dashboard.ts: they are separate packages, so each has its copy.

/** Body rows of a page `height` rows tall (less the margins, the title and the keys). */
export const bodyRows = (height: number) => Math.max(1, height - 2 * MARGIN.rows - 5);
/** Content columns of a page `width` wide (less the margins). */
export const bodyWidth = (width: number) => Math.max(10, width - 2 * MARGIN.cols);

/**
 * A clean full-screen page (the dashboard, the log viewer): an equal margin on all four sides,
 * and inside it a title, a dim description, the body, and the keys pinned to the bottom.
 */
export function page(
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
  // Every row is padded to the full width (and the page to the full height), so nothing of
  // pi's screen shows around it.
  const left = " ".repeat(MARGIN.cols);
  const out = [...Array(MARGIN.rows).fill(""), ...lines.map((l) => left + fit(l, inner))];
  while (out.length < height) out.push("");
  return out.slice(0, height).map((l) => pad(l, width));
}

/** ctx.ui.custom options for a page: the whole screen (the page draws its own margin). */
export const FULL_SCREEN: { overlay: true; overlayOptions: OverlayOptions } = {
  overlay: true,
  overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
};

export class JobsDashboard {
  private selected = 0; // the row; it follows its job (pickedPid) as rows move
  private pickedPid: number | undefined;
  private top = 0;
  private showEnded = true;
  private armed = false; // x pressed once
  private rows: Row[] = [];
  private page = 1;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private data: () => Row[],
    private act: { logs: (pid: number) => void; kill: (pid: number) => void },
    private tilde: (p: string) => string,
    private done: () => void,
  ) {
    this.timer = setInterval(() => tui.requestRender(), 1000); // elapsed times
  }

  dispose() {
    clearInterval(this.timer);
  }

  invalidate() {}

  private move(i: number) {
    this.selected = Math.max(0, Math.min(this.rows.length - 1, i));
    this.pickedPid = this.rows[this.selected]?.pid;
    this.armed = false;
  }

  render(width: number): string[] {
    const t = this.theme;
    const dim = (s: string) => t.fg("dim", s);
    const all = this.data();
    const running = all.filter((j) => j.state === "running");
    const ended = all.length - running.length;
    this.rows = this.showEnded
      ? [...running, ...all.filter((j) => j.state !== "running")]
      : running;
    // Rows move (a job finishes): keep the selection on its job; x disarms if it's gone.
    const at = this.rows.findIndex((j) => j.pid === this.pickedPid);
    if (at >= 0) this.selected = at;
    else this.move(this.selected);

    const height = this.tui.terminal.rows;
    this.page = bodyRows(height);
    this.top = Math.max(0, Math.min(this.top, this.selected), this.selected - this.page + 1);
    const color = (s: string) =>
      s === "running"
        ? "accent"
        : s === "exit 0"
          ? "success"
          : s === "killed"
            ? "warning"
            : "error";
    // The command takes what the other columns and the widest folder leave (at least 20).
    const cwdW = Math.max(0, ...this.rows.map((j) => visibleWidth(this.tilde(j.cwd))));
    const cmdW = Math.max(
      20,
      Math.min(
        Math.max(0, ...this.rows.map((j) => visibleWidth(j.command.split("\n")[0]!))),
        bodyWidth(width) - 27 - 2 - cwdW,
      ),
    );
    const line = (j: Row, i: number) =>
      `${i === this.selected ? t.fg("accent", "▸") : " "} ${t.fg("text", String(j.pid).padEnd(7))}` +
      `${t.fg(color(j.state), j.state.padEnd(9))}${dim(j.elapsed.padEnd(8))}` +
      `${t.fg("text", fit(j.command.split("\n")[0]!, cmdW))}  ${dim(this.tilde(j.cwd))}`;
    const list = this.rows.length
      ? this.rows.slice(this.top, this.top + this.page).map((j, k) => line(j, this.top + k))
      : [dim(ended ? "No running jobs." : "No background jobs in this session yet.")];

    const picked = this.rows[this.selected];
    const describe = [
      `${running.length} running`,
      ended && `${ended} finished${this.showEnded ? "" : " (hidden)"}`,
      "this session's background jobs",
    ].filter(Boolean);
    const keys = this.armed
      ? t.fg("warning", `press x again to kill ${picked?.pid}`)
      : dim(
          [
            this.rows.length && "↑↓ select · enter logs",
            picked?.state === "running" && "x kill",
            ended && (this.showEnded ? "e hide finished" : `e show finished (${ended})`),
            "esc close",
          ]
            .filter(Boolean)
            .join(" · "),
        );
    const counter =
      this.rows.length > this.page ? dim(`${this.selected + 1}/${this.rows.length}`) : "";
    return page(
      t,
      width,
      height,
      { title: "jobs", description: describe.join(" · ") },
      list,
      keys,
      counter,
    );
  }

  handleInput(data: string) {
    if (isKeyRelease(data)) return;
    const picked = this.rows[this.selected];
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) return this.done();
    if (matchesKey(data, "x") && picked?.state === "running") {
      if (this.armed) this.act.kill(picked.pid);
      this.armed = !this.armed;
      return this.tui.requestRender();
    }
    if (matchesKey(data, Key.up)) this.move(this.selected - 1);
    else if (matchesKey(data, Key.down)) this.move(this.selected + 1);
    else if (matchesKey(data, Key.pageUp)) this.move(this.selected - this.page);
    else if (matchesKey(data, Key.pageDown)) this.move(this.selected + this.page);
    else if (matchesKey(data, Key.enter) && picked) this.act.logs(picked.pid);
    else if (matchesKey(data, "e")) this.showEnded = !this.showEnded;
    this.armed = false;
    this.tui.requestRender();
  }
}
