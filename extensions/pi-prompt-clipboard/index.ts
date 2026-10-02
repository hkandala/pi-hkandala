/**
 * pi-prompt-clipboard: move prompts between the editor and the clipboard.
 * - ctrl+shift+s copies the whole prompt (pasted content included) to the clipboard and clears the
 *   editor. Undo (ctrl+- by default) brings it back.
 * - Pasting a long text shows pi's usual `[paste #1 +40 lines]` marker; pasting the same text again
 *   with the cursor at that marker replaces it with the full, editable text.
 *
 * Config (optional): ~/.pi/agent/extensions/pi-prompt-clipboard.json
 *   { "shortcut": "ctrl+shift+s" }
 *
 * pi has no API for paste handling, so this wraps the editor's `handlePaste` (restored on
 * shutdown). pi's own paste logic always runs; this only swaps the new marker for the old one's
 * text afterwards, and falls back to stock behavior if pi's editor internals change.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Editor, type KeyId } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Config = { shortcut?: string };
type Paster = {
  state?: { lines: string[]; cursorLine: number; cursorCol: number };
  pastes?: Map<number, string>;
  pasteCounter?: number;
  insertTextAtCursorInternal?: (text: string) => void;
};

const MARKER = /\[paste #(\d+)(?: \+\d+ lines| \d+ chars)?\]/g;

function readConfig(): Config {
  try {
    return JSON.parse(
      readFileSync(join(getAgentDir(), "extensions", "pi-prompt-clipboard.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

/** pi prefixes a space to path-like pastes after a word, so the two pastes may differ by it. */
const same = (a: string, b: string) => a.replace(/^ /, "") === b.replace(/^ /, "");

/** Wraps pi's paste handler so a repeat paste at a marker expands it. Returns the undo. */
function patchPaste(): () => void {
  const proto = Editor.prototype as unknown as { handlePaste: (text: string) => void };
  const original = proto.handlePaste;
  proto.handlePaste = function (this: Paster, text: string) {
    const { state, pastes } = this;
    if (
      !state ||
      !Array.isArray(state.lines) ||
      !(pastes instanceof Map) ||
      !this.insertTextAtCursorInternal
    ) {
      return original.call(this, text);
    }
    const { cursorLine, cursorCol } = state;
    const line = state.lines[cursorLine] ?? "";
    // Two markers side by side can both touch the cursor.
    const hits = [...line.matchAll(MARKER)].filter(
      (m) => m.index <= cursorCol && cursorCol <= m.index + m[0].length,
    );
    const count = this.pasteCounter;
    original.call(this, text); // pi cleans the text and inserts its own marker for long pastes
    if (!hits.length || this.pasteCounter === count) return; // not at a marker, or a short paste
    const pasted = pastes.get(this.pasteCounter!);
    if (pasted === undefined) return;
    const hit = hits.find((m) => {
      const stored = pastes.get(Number(m[1]));
      return stored !== undefined && same(stored, pasted);
    });
    if (!hit) return;
    const stored = pastes.get(Number(hit[1]))!;
    // Same text: drop the new marker and put the old one's full text in its place. The old paste
    // stays in pi's map, so undoing back to the marker still sends the full text.
    pastes.delete(this.pasteCounter!);
    this.pasteCounter! -= 1;
    state.lines[cursorLine] = line.slice(0, hit.index) + line.slice(hit.index + hit[0].length);
    state.cursorCol = hit.index;
    this.insertTextAtCursorInternal(stored);
  };
  return () => (proto.handlePaste = original);
}

export default function (pi: ExtensionAPI) {
  let unpatch: (() => void) | undefined;

  pi.registerShortcut((readConfig().shortcut ?? "ctrl+shift+s") as KeyId, {
    description: "Copy the prompt to the clipboard and clear it",
    handler: async (ctx) => {
      const text = ctx.ui.getEditorText();
      if (!text.trim()) return ctx.ui.notify("Nothing to copy", "info");
      try {
        await copyToClipboard(text);
      } catch (error) {
        return ctx.ui.notify(`Copy failed: ${(error as Error).message}`, "error");
      }
      ctx.ui.setEditorText("");
      ctx.ui.notify("Prompt copied to clipboard", "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui" && !unpatch) unpatch = patchPaste();
  });

  pi.on("session_shutdown", () => {
    unpatch?.();
    unpatch = undefined;
  });
}
