/** The rounded prompt box (pi's editor inside a border, with the footer as its last row). */
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cut } from "./tabs.ts";

export type MouseEvent = { type: string; button: string; x: number; y: number; width: number };

/** What the box needs from the footer: its line, where clicks go, whether the dashboard has the keys. */
export type BoxHooks = {
  footer: (width: number) => string;
  clickFooter: (x: number) => void;
  clickInput: () => void;
  footerFocused: () => boolean;
  name: () => string | undefined; // the session's, at the top border's right end
  placeholder: () => string | undefined; // styled, in the empty prompt (pi-herd's popup hint)
};

/**
 * pi's editor drawn six columns narrower inside a rounded box set a column in on each side (so
 * the text lines up with the transcript's), with the footer as its last row.
 * Assumes pi's editor layout: top border, text rows, bottom border, then the autocomplete list.
 */
export class BoxEditor extends CustomEditor {
  hooks: BoxHooks;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, hooks: BoxHooks) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.hooks = hooks;
  }

  // Text rows pi's editor rendered last frame (private in pi, but set on every render). Without
  // it (pi renamed it), the box falls back to pi's plain editor.
  private get rows(): number | undefined {
    const n = (this as unknown as { renderedVisibleLineCount?: unknown }).renderedVisibleLineCount;
    return typeof n === "number" ? n : undefined;
  }

  render(width: number): string[] {
    if (width < 10 || this.rows === undefined) return super.render(width);
    const inner = width - 6;
    const lines = super.render(inner);
    const bottom = this.rows! + 1;
    const color = this.borderColor; // read once: its getter may look at the prompt's text
    const b = (s: string) => color.call(this, s);
    const side = (line: string) => ` ${b("│")} ${line} ${b("│")} `;
    const footer = cut(this.hooks.footer(inner), inner);
    // While the dashboard has the keys, drop pi's cursor (an inverse cell, and the hardware
    // cursor's marker) so it's clear typing isn't going to the prompt.
    const text = lines.slice(1, bottom);
    // oxlint-disable-next-line no-control-regex
    const inverse = /\x1b\[7m(.*?)\x1b\[0m/;
    const rows = !this.hooks.footerFocused()
      ? text
      : text.map((l) => l.replace(CURSOR_MARKER, "").replace(inverse, "$1"));
    // The placeholder after the cursor, in place of the empty row's trailing spaces.
    const placeholder = this.hooks.placeholder();
    if (placeholder && this.getText() === "" && rows[0] !== undefined) {
      const row = rows[0].replace(/ +$/, "");
      const free = inner - visibleWidth(row) - 1;
      const withHint = `${row} ${cut(placeholder, free)}`;
      if (free > 0) rows[0] = withHint + " ".repeat(Math.max(0, inner - visibleWidth(withHint)));
    }
    // The session name at the right end of the top border, if pi's label (on the left) leaves room.
    let top = lines[0]!;
    const name = this.hooks.name();
    if (name) {
      const label = ` ${cut(name, 32)} `;
      // oxlint-disable-next-line no-control-regex
      const used = visibleWidth(top.replace(/\x1b\[[0-9;]*m/g, "").replace(/─+$/, ""));
      if (used + visibleWidth(label) + 2 <= inner)
        top = truncateToWidth(top, inner - visibleWidth(label), "") + label;
    }
    return [
      b(" ╭─") + top + b("─╮ "),
      ...rows.map(side),
      side(" ".repeat(inner)),
      side(footer + " ".repeat(Math.max(0, inner - visibleWidth(footer)))),
      b(" ╰─") + lines[bottom] + b("─╯ "),
      ...lines.slice(bottom + 1).map((line) => `   ${line}   `), // autocomplete list, below the box
    ];
  }

  // Clicks map back onto pi's editor: three columns for margin, border and padding, two rows for
  // the footer. One on the text (or the blank row under it) also gives the prompt the keys back
  // and closes the dashboard; one on the footer line goes to the footer (its pieces open tabs).
  handleMouse(event: MouseEvent) {
    const rows = this.rows;
    if (event.width < 10 || rows === undefined) return super.handleMouse(event);
    const shifted = { ...event, x: event.x - 3, width: event.width - 6 };
    const click = event.type === "click" && event.button === "left";
    if (click && event.y <= rows + 1) this.hooks.clickInput();
    if (event.y <= rows) return super.handleMouse(shifted);
    if (event.y === rows + 1) return { handled: true, focus: true };
    if (event.y === rows + 2) {
      if (click) this.hooks.clickFooter(event.x - 3);
      return { handled: true };
    }
    return super.handleMouse({ ...shifted, y: event.y - 2 });
  }
}

export type Node = {
  children?: Node[];
  isShowingAutocomplete?: () => boolean;
  getText?: () => string;
};
/** pi's editor, for where its cursor is (historyIndex is private: -1 when not browsing history). */
type PromptEditor = Node & {
  getLines?: () => string[];
  getCursor?: () => { line: number; col: number };
  historyIndex?: number;
  focused?: boolean; // false while a selector (e.g. /tree) or a dialog replaces it
};

// Found by duck typing; if pi's layout changes, the autocomplete gap, border pinning and the
// prompt-end check just stop applying (↓ then always opens the dashboard).
export const findEditor = (node: Node): Node | undefined => {
  if (typeof node.isShowingAutocomplete === "function") return node;
  for (const child of node.children ?? []) {
    const found = findEditor(child);
    if (found) return found;
  }
  return undefined;
};

/**
 * The cursor is at the end of the prompt's text (not browsing history), with no autocomplete
 * list or overlay, and the prompt has focus (not /tree etc.): ↓ has nothing left to do there.
 */
export const promptAtEnd = (editor: Node | undefined, tui: TUI) => {
  const e = (editor ?? {}) as PromptEditor;
  const lines = e.getLines?.() ?? [""];
  const cursor = e.getCursor?.() ?? { line: 0, col: 0 };
  return (
    e.focused !== false &&
    cursor.line === lines.length - 1 &&
    cursor.col === lines.at(-1)!.length &&
    (e.historyIndex ?? -1) === -1 &&
    !e.isShowingAutocomplete?.() &&
    !tui.hasOverlay()
  );
};

/** The editor lost the keys to something that replaced it (a selector, a dialog). */
export const editorUnfocused = (editor: Node | undefined) =>
  (editor as PromptEditor | undefined)?.focused === false;

/**
 * pi reassigns editor.borderColor on thinking-level changes; a no-op setter pins it (muted, or
 * bashMode for a `!` command). Returns the undo, which puts back pi's latest assignment: pi keeps
 * its own editor across /reload.
 */
export function pinBorderColor(editor: Node, theme: Theme) {
  let latest = (editor as { borderColor?: unknown }).borderColor;
  Object.defineProperty(editor, "borderColor", {
    configurable: true,
    get: () => {
      const color = editor.getText?.().trimStart().startsWith("!") ? "bashMode" : "muted";
      return (s: string) => theme.fg(color, s);
    },
    set: (value) => {
      latest = value;
    },
  });
  return () =>
    Object.defineProperty(editor, "borderColor", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: latest,
    });
}
