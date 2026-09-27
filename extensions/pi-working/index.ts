/**
 * pi-working: an elapsed timer in pi's working label, and a "Worked for" label that stays in the
 * prompt's top border after a run, until the next run starts or esc is pressed.
 *
 *   ╭── ⠋ Working (12s) ─────────────────────╮   while running; the time turns yellow when the
 *                                                model has been silent for 30s
 *   ╭── ✓ Worked for 4m 12s · 3m ago ────────╮   after the run; ■ interrupted, ✗ failed
 *
 * A run spans the first agent_start to agent_settled, so retries, compaction and follow-ups count.
 * Config (optional): ~/.pi/agent/extensions/pi-working.json
 *   { "workingVerbs": ["Working"], "doneVerbs": ["Worked"] }   one picked at random per run
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STALL_MS = 30_000;

/** 12s, 4m, 1h 4m; precise keeps the seconds under an hour: 4m 12s. */
function duration(ms: number, precise = false): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m === 0) return `${s}s`;
  if (m < 60) return precise ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)]!;

function verbs(value: unknown, fallback: string): string[] {
  const list = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
  return list.length ? list : [fallback];
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "extensions", "pi-working.json"), "utf8"));
  } catch {
    return {};
  }
}

// pi's editors that draw its status in their top border (pi's own, pi-footer's box) take any object
// with these two methods. Not public API: if it changes, the done label just stops showing.
type Indicator = {
  renderInBorder(width: number): string;
  renderSpinnerInBorder(width: number): string;
};
type Editor = { workingStatusIndicator?: unknown; setWorkingStatusIndicator(i?: Indicator): void };
type Node = { children?: Node[]; embedWorkingStatus?: boolean } & Partial<Editor>;

const findEditor = (node: Node): Editor | undefined => {
  if (node.embedWorkingStatus === true && typeof node.setWorkingStatusIndicator === "function")
    return node as Editor;
  for (const child of node.children ?? []) {
    const found = findEditor(child);
    if (found) return found;
  }
  return undefined;
};

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let root: Node | undefined;
  let editor: Editor | undefined;
  let requestRender = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let config = { working: ["Working"], done: ["Worked"] };

  // The running run.
  let startedAt: number | undefined;
  let verb = "";
  let heardAt = 0; // last model output or finished tool
  let tools = 0; // tools executing
  let outcome: string | undefined; // "aborted" or the last assistant message's stopReason

  // The finished run, shown until the next run or esc.
  let done: { verb: string; ms: number; endedAt: number; outcome?: string } | undefined;
  let shown = ""; // done label as last rendered

  const icon = () => {
    if (!ctx) return "";
    const t = ctx.ui.theme;
    if (done?.outcome === "aborted") return t.fg("warning", "■");
    if (done?.outcome === "error") return t.fg("error", "✗");
    return t.fg("success", "✓");
  };
  const doneLabel = () => {
    if (!done || !ctx) return "";
    const t = ctx.ui.theme;
    const ago = Date.now() - done.endedAt;
    return (
      `${icon()} ${t.fg("muted", `${done.verb} for ${duration(done.ms, true)}`)}` +
      (ago >= 60_000 ? t.fg("dim", ` · ${duration(ago)} ago`) : "")
    );
  };
  const indicator: Indicator = {
    renderInBorder: (width) => truncateToWidth((shown = doneLabel()), width, ""),
    renderSpinnerInBorder: (width) => truncateToWidth(icon(), width, ""),
  };

  const clearDone = () => {
    done = undefined;
    if (editor?.workingStatusIndicator !== indicator) return;
    editor.setWorkingStatusIndicator(undefined);
    requestRender();
  };

  const tick = () => {
    if (!ctx) return;
    if (startedAt !== undefined) {
      const stalled = tools === 0 && Date.now() - heardAt > STALL_MS;
      const time = ctx.ui.theme.fg(
        stalled ? "warning" : "dim",
        `(${duration(Date.now() - startedAt)})`,
      );
      ctx.ui.setWorkingMessage(`${verb} ${time}`);
    } else if (done && editor) {
      const current = editor.workingStatusIndicator;
      // pi empties the border after its own indicators (e.g. an idle /compact): put the label back.
      if (!current) editor.setWorkingStatusIndicator(indicator);
      if (!current || (current === indicator && doneLabel() !== shown)) requestRender();
    }
  };

  const stop = () => {
    clearInterval(timer);
    unsubscribe?.();
    clearDone();
    ctx?.ui.setWorkingMessage(undefined);
    ctx = root = editor = timer = unsubscribe = startedAt = undefined;
  };

  pi.on("session_start", (_event, c) => {
    stop();
    if (c.mode !== "tui") return;
    ctx = c;
    const file = readConfig();
    config = {
      working: verbs(file.workingVerbs, "Working"),
      done: verbs(file.doneVerbs, "Worked"),
    };
    // pi calls widget factories right away with the TUI; that is all this widget is for.
    c.ui.setWidget("pi-working", (tui) => {
      root = tui as unknown as Node;
      requestRender = () => tui.requestRender();
      return { render: () => [], invalidate() {} };
    });
    c.ui.setWidget("pi-working", undefined);
    timer = setInterval(tick, 1000);
    // Returns nothing, so esc still reaches pi.
    unsubscribe = c.ui.onTerminalInput((data) => {
      if (done && startedAt === undefined && matchesKey(data, Key.escape)) clearDone();
      return undefined;
    });
  });
  pi.on("session_shutdown", stop);

  pi.on("agent_start", () => {
    if (!ctx) return;
    heardAt = Date.now();
    if (startedAt === undefined) {
      startedAt = heardAt;
      verb = pick(config.working);
      tools = 0;
      outcome = undefined;
      done = undefined; // pi replaces the label with its spinner
    }
    tick();
  });
  pi.on("message_update", () => {
    heardAt = Date.now();
  });
  pi.on("message_end", ({ message }, c) => {
    heardAt = Date.now();
    // Interrupting during a tool ends the run with an "error" message, so check the run's signal.
    if (message.role === "assistant") outcome = c.signal?.aborted ? "aborted" : message.stopReason;
  });
  pi.on("tool_execution_start", () => {
    tools++;
  });
  pi.on("tool_execution_end", () => {
    tools = Math.max(0, tools - 1);
    heardAt = Date.now();
  });
  pi.on("agent_settled", () => {
    if (!ctx || startedAt === undefined) return;
    done = { verb: pick(config.done), ms: Date.now() - startedAt, endedAt: Date.now(), outcome };
    startedAt = undefined;
    editor = (root && findEditor(root)) ?? editor; // found late: another extension may swap it
    tick();
  });
}
