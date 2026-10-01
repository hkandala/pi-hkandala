/**
 * The full view: the dashboard over the whole screen, drawn like the dashboard (tab bar, rule,
 * tab) with no border. Its tabs (info, agents, jobs) come from index.ts, built for the screen's
 * height, so lists show as many rows as fit. Keys: ←→ switch tabs, ↑↓ move in the list, the
 * list's own keys (enter, x, e), o or esc close.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { move, type Tab, Tabs } from "./tabs.ts";

type Paint = (c: "muted" | "accent" | "dim", s: string) => string;

/** The component for ctx.ui.custom: `build(width, rows)` gives the tabs for `rows` body rows. */
export function fullView(
  tui: TUI,
  theme: Theme,
  build: (width: number, rows: number) => { tabs: Tab[]; paint: Paint },
  start: string,
  done: () => void,
) {
  const tabs = new Tabs();
  tabs.expanded = tabs.focus = true;
  tabs.tab = start;
  tabs.keys = "←→ switch · o or esc close";
  let shown: Tab[] = [];
  return {
    invalidate() {},
    // A blank row, the tab bar and its rule, the tab, and a blank row: exactly the screen's height.
    render(width: number) {
      const height = tui.terminal.rows;
      const built = build(width, height - 4);
      shown = built.tabs;
      const out = ["", ...tabs.render(shown, width, theme, built.paint)];
      while (out.length < height) out.push("");
      return out.slice(0, height);
    },
    handleInput(data: string) {
      if (isKeyRelease(data)) return;
      if (matchesKey(data, "o") || matchesKey(data, Key.escape)) return done();
      const active = shown.find((t) => t.id === tabs.tab) ?? shown[0];
      const list = active?.list;
      // The list's keys first, even with no rows (e shows hidden ones).
      if (list?.onKey?.(data, list.sel.selected)) return tui.requestRender();
      if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
        const i = shown.indexOf(active!) + (matchesKey(data, Key.left) ? -1 : 1);
        tabs.tab = shown[(i + shown.length) % shown.length]!.id;
      } else if (list && (matchesKey(data, Key.up) || matchesKey(data, Key.down)))
        move(
          list.sel,
          list.sel.selected + (matchesKey(data, Key.up) ? -1 : 1),
          list.length,
          list.page,
        );
      tui.requestRender();
    },
  };
}
