/**
 * The log viewer, a full-screen page like pi-herd's dashboard: the pid and the job's details on
 * the title line, a rule, `> ` and the command (colored as bash, wrapped), then the log's tail,
 * and the keys at the bottom. Scrolls, follows new output, kills on a double x.
 */

import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type OverlayOptions,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { closeSync, openSync, readSync, statSync } from "node:fs";

export const TAIL_BYTES = 1024 * 1024; // the viewer and end messages read at most the log's last 1MB

/** The log's size and its last 1MB as text, without the first line when it was cut. */
export function readTail(path: string): { size: number; text: string } {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString("utf8");
    return { size, text: start > 0 ? text.slice(text.indexOf("\n") + 1) : text };
  } catch {
    return { size: 0, text: "" };
  }
}

/** What the viewer shows about its job, read by its timer every 250ms (not per frame: it can read files). */
export type ViewerInfo = { pid: number; command: string; detail: string; running: boolean };

/** One display line: after the last \r (progress bars), only color escapes kept, no controls. */
export const clean = (line: string) => {
  const text = line.replace(/\r+$/, "");
  return (
    text
      .slice(text.lastIndexOf("\r") + 1)
      .replace(/\t/g, "    ")
      // OSC, DCS, APC and PM strings (titles, hyperlinks), with or without their terminator.
      // oxlint-disable-next-line no-control-regex
      .replace(/\x1b[\]_P^][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
      // oxlint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, (m) => (m.endsWith("m") ? m : ""))
      // Any other escape (charset, reset, cursor save), and a CSI cut off at the line's end.
      // oxlint-disable-next-line no-control-regex
      .replace(/\x1b(?!\[)[ -/]*[0-~]?|\x1b\[[0-9;?]*[ -/]*$/g, "")
      // oxlint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "")
  );
};

/** A bash command colored line by line; a token across lines (a quoted string) is reopened on each. */
export function highlightBash(command: string): string[] {
  let open = "";
  return highlightCode(command.trim(), "bash").map((l) => {
    const line = open + l;
    // oxlint-disable-next-line no-control-regex
    const last = line.match(/\x1b\[(?:38;[\d;]*|39)m/g)?.at(-1) ?? "";
    open = last.startsWith("\x1b[38") ? last : "";
    return line;
  });
}

/** Cuts `text` to `width` with a … in the style at the cut (pi's truncateToWidth resets it). */
export function cut(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  // Cut with no ellipsis, pi's result ends in a reset ("\x1b[0m", 4 chars): drop it, add the ….
  return width < 1 ? "" : `${truncateToWidth(text, width - 1, "").slice(0, -4)}…\x1b[0m`;
}

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

/** The page's margin, as pi-herd's dashboard: 2 rows on top, 1 below, 4 columns on each side. */
const MARGIN = { top: 2, bottom: 1, cols: 4 };

/** ctx.ui.custom options for the viewer: the whole screen (it draws its own margin). */
export const FULL_SCREEN: { overlay: true; overlayOptions: OverlayOptions } = {
  overlay: true,
  overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
};

export class LogViewer {
  private lines: string[] = []; // raw
  private wrapped = { size: -1, width: 0, rows: [] as string[] }; // the lines cleaned and wrapped
  private now!: ViewerInfo; // the job, read by the timer (not per frame: it can read files)
  private command!: string[]; // highlighted once
  private size = -1;
  private top: number | undefined; // first line shown; undefined follows new output
  private armed = false; // x pressed once
  private timer: ReturnType<typeof setInterval>;
  private tui!: TUI;
  private theme!: Theme;
  private log!: string;
  private info!: () => ViewerInfo;
  private rows = 3; // log rows shown, set by render (the command above them takes the rest)
  private kill!: () => void;
  private done!: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    log: string,
    info: () => ViewerInfo,
    kill: () => void,
    done: () => void,
  ) {
    Object.assign(this, { tui, theme, log, info, kill, done });
    this.now = info();
    this.command = highlightBash(this.now.command); // reopened per line, as pi-content-layout does
    this.load();
    let ticks = 0;
    this.timer = setInterval(() => {
      const was = this.now.running;
      this.now = info();
      // As the log grows, when the job ends, and the running time once a second.
      const ended = was !== this.now.running;
      if (this.load() || ended || (this.now.running && ++ticks % 4 === 0)) tui.requestRender();
    }, 250);
  }

  /** Rereads the log's tail if it grew; returns whether it did. */
  private load(): boolean {
    let size = 0;
    try {
      size = statSync(this.log).size;
    } catch {}
    if (size === this.size) return false;
    const tail = readTail(this.log);
    this.size = tail.size;
    this.lines = tail.text.replace(/\n$/, "").split("\n");
    if (this.lines.length === 1 && !this.lines[0]) this.lines = [];
    return true;
  }

  render(width: number): string[] {
    const t = this.theme;
    const dim = (s: string) => t.fg("dim", s);
    const inner = Math.max(10, width - 2 * MARGIN.cols);
    const { pid, detail, running } = this.now;
    const keys = this.armed
      ? t.fg("warning", "press x again to kill")
      : dim(
          `↑↓ PgUp PgDn scroll · ${this.top === undefined ? "following" : "End follow"}${running ? " · x kill" : ""} · esc close`,
        );
    // `> ` and the command (at most a third of the page), a blank line, then the log.
    const height = this.tui.terminal.rows;
    const body = Math.max(4, height - MARGIN.top - MARGIN.bottom - 5); // title, rule, blanks, keys
    const cmd = this.command
      .flatMap((l) => wrapTextWithAnsi(l, inner - 2))
      .map((l, i) => (i ? "  " : dim("> ")) + l);
    const head = [...cmd.slice(0, Math.max(1, Math.floor(body / 3))), ""];
    this.rows = Math.max(1, body - head.length);
    const all = this.wrap(inner);
    const start = this.top ?? Math.max(0, all.length - this.rows);
    const log = all.slice(start, start + this.rows);
    if (!all.length) log.push(dim(running ? "(no output yet)" : "(no output)"));
    while (log.length < this.rows) log.push("");
    const counter =
      all.length > this.rows
        ? dim(`${start + 1}-${Math.min(all.length, start + this.rows)}/${all.length}`)
        : "";
    // A full-screen page, as pi-herd's dashboard: a margin, the title, a rule, the body, and the
    // keys pinned to the bottom. Every row is padded to the full width (and the page to the full
    // height), so nothing of pi's screen shows around it.
    const lines = [
      `${t.bold(t.fg("accent", `pid ${pid}`))}  ${dim(detail)}`,
      dim("─".repeat(inner)),
      "",
      ...head,
      ...log,
      "",
      pad(cut(keys, inner - visibleWidth(counter) - 2), inner - visibleWidth(counter)) + counter,
    ];
    const left = " ".repeat(MARGIN.cols);
    const out = [
      ...Array(MARGIN.top).fill(""),
      ...lines.map((l) => left + pad(cut(l, inner), inner)),
    ];
    while (out.length < height) out.push("");
    return out.slice(0, height).map((l) => pad(l, width));
  }

  /**
   * The log's lines cleaned and wrapped to `width`, all of them again whenever the log grew or the
   * width changed. None when it is only whitespace.
   */
  private wrap(width: number): string[] {
    const w = this.wrapped;
    if (w.size !== this.size || w.width !== width) {
      const rows = this.lines.flatMap((l) => wrapTextWithAnsi(clean(l), width));
      // oxlint-disable-next-line no-control-regex
      const blank = rows.every((r) => !r.replace(/\x1b\[[0-9;]*m/g, "").trim());
      this.wrapped = { size: this.size, width, rows: blank ? [] : rows };
    }
    return this.wrapped.rows;
  }

  /** Scrolls by `delta` rows; reaching the bottom follows new output again. */
  private scrollBy(delta: number) {
    const max = Math.max(0, this.wrapped.rows.length - this.rows);
    const top = Math.max(0, Math.min(max, (this.top ?? max) + delta));
    this.top = top === max ? undefined : top;
  }

  handleInput(data: string): void {
    const x = data === "x" && this.now.running;
    if (matchesKey(data, Key.escape) || data === "q") return this.done();
    if (x && this.armed) this.kill();
    this.armed = x && !this.armed;
    if (matchesKey(data, Key.up)) this.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-this.rows);
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(this.rows);
    else if (matchesKey(data, Key.home)) this.top = 0;
    else if (matchesKey(data, Key.end)) this.top = undefined;
    this.tui.requestRender();
  }

  handleMouse(event: { type: string; wheelDelta?: number }) {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    this.scrollBy(event.wheelDelta);
    return { handled: true };
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}
