/**
 * The log viewer, as a full-screen page (dashboard.ts): the pid and the job's details under the
 * title, then the command (colored as bash, wrapped) and the log's tail. Scrolls, follows new
 * output, kills on a double x.
 */

import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { bodyRows, bodyWidth, page } from "./dashboard.ts";

const MAX_BYTES = 1024 * 1024; // only the log's last 1MB is shown

/** What the viewer shows about its job, read on every render. */
export type ViewerInfo = { pid: number; command: string; detail: string; running: boolean };

/** One display line: after the last \r (progress bars), only color escapes kept, no controls. */
const clean = (line: string) => {
  const text = line.replace(/\r+$/, "");
  return (
    text
      .slice(text.lastIndexOf("\r") + 1)
      .replace(/\t/g, "    ")
      // oxlint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, (m) => (m.endsWith("m") ? m : ""))
      // oxlint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "")
  );
};

export class LogViewer {
  private lines: string[] = [];
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
    this.load();
    this.timer = setInterval(() => {
      if (this.load() || info().running) tui.requestRender();
    }, 250);
  }

  /** Rereads the log's tail if it grew; returns whether it did. */
  private load(): boolean {
    let size = 0;
    try {
      size = statSync(this.log).size;
    } catch {}
    if (size === this.size) return false;
    this.size = size;
    const start = Math.max(0, size - MAX_BYTES);
    const buf = Buffer.alloc(size - start);
    try {
      const fd = openSync(this.log, "r");
      readSync(fd, buf, 0, buf.length, start);
      closeSync(fd);
    } catch {}
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the cut first line
    this.lines = text.replace(/\n$/, "").split("\n").map(clean);
    if (this.lines.length === 1 && !this.lines[0]) this.lines = [];
    return true;
  }

  render(width: number): string[] {
    const t = this.theme;
    const height = this.tui.terminal.rows;
    const { pid, command, detail, running } = this.info();
    const keys = this.armed
      ? t.fg("warning", "press x again to kill")
      : t.fg(
          "dim",
          `↑↓ PgUp PgDn scroll · ${this.top === undefined ? "following" : "End follow"}${running ? " · x kill" : ""} · esc close`,
        );
    // The command (at most a third of the page), a blank line, then the log.
    const cmd = highlightCode(command.trim(), "bash").flatMap((l) =>
      wrapTextWithAnsi(l, bodyWidth(width)),
    );
    const head = [...cmd.slice(0, Math.max(1, Math.floor(bodyRows(height) / 3))), ""];
    this.rows = Math.max(3, bodyRows(height) - head.length);
    const start = this.top ?? Math.max(0, this.lines.length - this.rows);
    const log = this.lines.slice(start, start + this.rows);
    if (!this.lines.length) log.push(t.fg("dim", "(no output yet)"));
    const counter =
      this.lines.length > this.rows
        ? t.fg(
            "dim",
            `${start + 1}-${Math.min(this.lines.length, start + this.rows)}/${this.lines.length}`,
          )
        : "";
    return page(
      t,
      width,
      height,
      { title: "logs", description: `pid ${pid} · ${detail}` },
      [...head, ...log],
      keys,
      counter,
    );
  }

  /** Scrolls by `delta` lines; reaching the bottom follows new output again. */
  private scrollBy(delta: number) {
    const max = Math.max(0, this.lines.length - this.rows);
    const top = Math.max(0, Math.min(max, (this.top ?? max) + delta));
    this.top = top === max ? undefined : top;
  }

  handleInput(data: string): void {
    const x = data === "x" && this.info().running;
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
