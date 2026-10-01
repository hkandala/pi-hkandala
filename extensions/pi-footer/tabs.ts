/**
 * The dashboard's tabs, as UI only: the tab bar, focus (who gets the keys), a scrolling list per
 * tab, clicks, and a steady height. What each tab shows comes from index.ts as `Tab`s.
 *
 * Keys, once focused: ←→ switch tabs, ↑↓ move in the tab's list, ↑ at its top (or on a tab
 * without one) and esc close; the list's own keys (enter, x) go to its `onKey`. Anything else
 * is typing: the keys go back to the prompt. Raw input includes key releases (kitty protocol):
 * they're skipped, or every press would count twice.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export const PAGE = 3; // rows a list shows at once

/** Cuts `text` to `width` with a … in the style at the cut (pi's truncateToWidth resets it). */
export function cut(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  // Cut with no ellipsis, pi's result ends in a reset ("\x1b[0m", 4 chars): drop it, add the ….
  return width < 1 ? "" : `${truncateToWidth(text, width - 1, "").slice(0, -4)}…\x1b[0m`;
}

/** A list's selected row and first shown row. */
export type Sel = { selected: number; top: number };

/** What a tab shows: lines, then optionally a scrolling list (a page of rows and a hint line). */
export type Tab = {
  id: string;
  label: string;
  lines: string[];
  list?: {
    sel: Sel;
    length: number;
    row: (i: number, marker: string) => string;
    keys: string; // hint while focused
    note?: string; // replaces the hint (e.g. "press x again to kill")
    onKey?: (data: string, i: number) => boolean; // the list's own keys; true = handled
    onPick?: (i: number) => void; // a click on the selected row
  };
};

/** Something clickable in the rendered lines: a tab, or a list row. */
type Click = { y: number; x0: number; x1: number; tab?: string; row?: number };

/** Moves a list's selection to `i`, scrolling to keep it in view. */
export const move = (sel: Sel, i: number, length: number) => {
  sel.selected = Math.max(0, Math.min(length - 1, i));
  sel.top = Math.max(0, Math.min(sel.top, sel.selected, length - PAGE), sel.selected - PAGE + 1);
};

export class Tabs {
  tab = "";
  focus = false; // the tabs have the keys, not the prompt
  expanded = false;
  private openedByKey = false; // ↓ opened them, so typing closes them again
  /** The tab opening starts on (↓, /footer), when it has a say (e.g. jobs while any run). */
  pick: () => string | undefined = () => undefined;
  /** Runs when the dashboard closes (e.g. lists scroll back to the top). */
  onClose = () => {};
  private clicks: Click[] = [];

  /** Closes, giving the keys back to the prompt (a click on its text). */
  close() {
    this.expanded = this.focus = this.openedByKey = false;
    this.onClose();
  }

  /** Opens at `tab` with the keys, staying open while you type (a footer piece, /footer). */
  show(tab: string) {
    this.expanded = this.focus = true;
    this.openedByKey = false;
    this.tab = tab;
  }

  /** Gives the keys back to the prompt; `close` (↑, esc), or ↓ having opened them, also closes. */
  private unfocus(close: boolean) {
    const closing = close || this.openedByKey;
    this.focus = this.openedByKey = false;
    if (closing) this.close();
  }

  private active(tabs: Tab[]) {
    return tabs.find((t) => t.id === this.tab) ?? tabs[0]!;
  }

  /**
   * The tab bar, a rule, and the active tab, padded to the tallest tab so switching tabs
   * doesn't move anything. Rows are counted from the first returned line.
   */
  render(
    tabs: Tab[],
    width: number,
    theme: Theme,
    paint: (c: "muted" | "accent" | "dim", s: string) => string,
  ): string[] {
    const dim = (s: string) => paint("dim", s);
    const active = this.active(tabs);
    this.clicks = [];
    let x = 2;
    const bar = tabs.map((t) => {
      const text = ` ${t.label} `;
      this.clicks.push({ y: 0, x0: x, x1: (x += text.length), tab: t.id });
      if (t !== active) return paint("muted", text);
      const on = theme.bold(paint("accent", text));
      return this.focus ? theme.bg("selectedBg", on) : on;
    });
    const hint = dim(this.focus ? "←→ switch · ↑ close" : "↓ to focus");
    const header = cut(`  ${bar.join("")}  ${hint}`, width);
    const rule = dim(`  ${"─".repeat(Math.max(0, visibleWidth(header) - 2))}`);
    const lines = [header, rule];

    const body = (t: Tab) => {
      const out = [...t.lines];
      const list = t.list;
      if (!list) return out;
      for (let i = list.sel.top; i < Math.min(list.length, list.sel.top + PAGE); i++) {
        const marker = this.focus && i === list.sel.selected ? paint("accent", "▸") : " ";
        if (t === active) this.clicks.push({ y: 2 + out.length, x0: 0, x1: width, row: i });
        out.push(cut(list.row(i, marker), width));
      }
      const counter = list.length > PAGE ? `${list.sel.selected + 1}/${list.length}` : "";
      const hint = list.note ?? dim([this.focus && list.keys, counter].filter(Boolean).join(" · "));
      out.push("", hint && `   ${hint}`);
      return out;
    };
    const height = Math.max(...tabs.map((t) => body(t).length));
    const shown = body(active);
    while (shown.length < height) shown.push("");
    return [...lines, ...shown, ""];
  }

  /** A click on a rendered row (`y` from the first returned line): a tab, or a list row. */
  click(tabs: Tab[], x: number, y: number): boolean {
    const hit = this.clicks.find((c) => c.y === y && x >= c.x0 && x < c.x1);
    if (!hit) return false;
    const list = this.active(tabs).list;
    if (hit.tab) this.tab = hit.tab;
    else if (list && hit.row !== undefined) {
      if (this.focus && hit.row === list.sel.selected) list.onPick?.(hit.row);
      move(list.sel, hit.row, list.length);
    }
    this.focus = true;
    return true;
  }

  /** Terminal input; `promptEnd`: ↓ has nothing left to do in the prompt. True = consumed. */
  input(data: string, tabs: Tab[], promptEnd: () => boolean, overlay: boolean): boolean {
    if (isKeyRelease(data)) return false;
    if (!this.focus) {
      if (!matchesKey(data, Key.down) || !promptEnd()) return false;
      if (!this.expanded) {
        this.expanded = this.openedByKey = true;
        this.tab = this.pick() ?? this.tab;
      }
      this.focus = true;
      return true;
    }
    if (overlay) return false; // e.g. pi-bash-bg's log viewer gets its own keys
    const active = this.active(tabs);
    const list = active.list?.length ? active.list : undefined;
    if (list?.onKey?.(data, list.sel.selected)) return true;
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const i = tabs.indexOf(active) + (matchesKey(data, Key.left) ? -1 : 1);
      this.tab = tabs[(i + tabs.length) % tabs.length]!.id;
    } else if (matchesKey(data, Key.escape)) this.unfocus(true);
    else if (matchesKey(data, Key.up)) {
      if (list && list.sel.selected > 0) move(list.sel, list.sel.selected - 1, list.length);
      else this.unfocus(true);
    } else if (matchesKey(data, Key.down)) {
      if (list) move(list.sel, list.sel.selected + 1, list.length);
    } else if (!matchesKey(data, Key.enter)) {
      this.unfocus(false); // typing: it goes to the prompt (enter never submits it from here)
      return false;
    }
    return true;
  }
}
