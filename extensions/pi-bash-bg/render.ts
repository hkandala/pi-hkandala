/**
 * The two renderers: a background job's end message, and /background list's entry.
 */

import { DynamicBorder, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Spacer,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { DIR, type Ending, tilde } from "./jobs.ts";
import { clean, cut, highlightBash } from "./viewer.ts";

const COLLAPSED_LINES = 4; // a collapsed end message's most lines

/** ● running, ✓ exit 0, ■ killed, ✗ anything else. */
const stateIcon = (theme: Theme, s: string) =>
  s === "running"
    ? theme.fg("accent", "●")
    : s === "exit 0"
      ? theme.fg("success", "✓")
      : s === "killed"
        ? theme.fg("warning", "■")
        : theme.fg("error", "✗");

// Collapsed like pi's compaction message, in at most 4 lines: one per job, its command cut to
// fit. Expanded, the whole command, then its output.
export function endMessage(
  message: { details?: { jobs: Ending[] } },
  { expanded }: { expanded: boolean },
  theme: Theme,
) {
  const list = message.details?.jobs ?? [];
  const dim = (s: string) => theme.fg("dim", s);
  const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
  const rows = list.map((j) => ({
    icon: stateIcon(theme, j.state),
    command: highlightBash(j.command),
    meta: dim(` · pid ${j.pid} · ${j.state} · ${j.elapsed}`),
    j,
  }));
  if (!expanded) {
    const shown = rows.length > COLLAPSED_LINES ? rows.slice(0, COLLAPSED_LINES - 1) : rows;
    const more = rows.length - shown.length;
    const hint = dim(` (${keyText("app.tools.expand")} to expand)`);
    let last: { width: number; lines: string[] } | undefined; // see the expanded one below
    box.addChild({
      invalidate: () => (last = undefined),
      render: (width: number) => {
        if (last?.width === width) return last.lines;
        const lines = shown.map((r, i) => {
          const tail = r.meta + (!more && i === shown.length - 1 ? hint : "");
          const room = Math.max(1, width - 2 - visibleWidth(tail));
          const cmd = r.command.length > 1 ? `${r.command[0]} …` : r.command[0]!;
          return cut(`${r.icon} ${cut(cmd, room)}${tail}`, width);
        });
        if (more) lines.push(cut(dim(`+${more} more`) + hint, width));
        last = { width, lines };
        return lines;
      },
    });
    return box;
  }
  // Like pi-content-layout's open bash row: a command on more than one line continues under
  // a │ and gets a │ line before its output, which hangs off a └. Kept per width: pi renders
  // the whole chat on every frame in full screen, and the output can run to a thousand lines.
  let last: { width: number; lines: string[] } | undefined;
  box.addChild({
    invalidate: () => (last = undefined),
    render: (width: number) => {
      if (last?.width === width) return last.lines;
      const fit = Math.max(1, width - 2);
      const lines: string[] = [];
      for (const { icon, command, meta, j } of rows) {
        const cmd = [...command.slice(0, -1), command.at(-1) + meta].flatMap((l) =>
          wrapTextWithAnsi(l, fit),
        );
        lines.push(...cmd.map((l, i) => `${i ? dim("│") : icon} ${l}`));
        if (cmd.length > 1) lines.push(dim("│"));
        const out = [j.output?.trim() && j.output, j.note].filter(Boolean).join("\n");
        // Cleaned like the log viewer's lines: raw \r and cursor codes would break pi's frame.
        const outLines = (out ? out.split("\n").map(clean) : ["(no output)"]).flatMap((l) =>
          wrapTextWithAnsi(theme.fg(out ? "toolOutput" : "dim", l), fit),
        );
        lines.push(...outLines.map((l, i) => `${i ? " " : dim("└")} ${l}`), "");
      }
      lines.pop();
      last = { width, lines };
      return lines;
    },
  });
  return box;
}

// /background list: printed like /hotkeys, never sent to the model, gone after a reload. A
// bullet per job, newest first: state, pid, start time, how long, cwd, and (listing all jobs)
// whether this session watches it; its log dim under it. Commands stay out: they're long.
export type Row = {
  pid: number;
  state: string;
  startedAt: number;
  elapsed: string;
  cwd: string;
  log: string;
  watching?: boolean;
};
const clock = (ms: number) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
};
/** The entry, or none for one from before this load (`loadedAt`). */
export function listEntry(
  entry: { timestamp: string; data?: { title: string; jobs: Row[]; more: number } },
  theme: Theme,
  loadedAt: number,
) {
  if (Date.parse(entry.timestamp) < loadedAt) return undefined;
  const { title, jobs: rows = [], more = 0 } = entry.data!;
  const dim = (s: string) => theme.fg("dim", s);
  const lines = rows.flatMap((j) => [
    `${dim("•")} ${stateIcon(theme, j.state)} ${theme.fg("accent", String(j.pid))} ` +
      theme.fg("text", `· ${clock(j.startedAt)} · ${j.state} · ${j.elapsed} · ${tilde(j.cwd)}`) +
      (j.watching ? ` ${theme.fg("accent", "· watching")}` : ""),
    dim(`    ${tilde(j.log)}`),
  ]);
  if (more) lines.push(dim(`+${more} more in ${tilde(DIR)}/`));
  const box = new Container();
  box.addChild(new DynamicBorder());
  box.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
  box.addChild(new Spacer(1));
  box.addChild(new Text(lines.join("\n") || dim("No matching background jobs."), 1, 0));
  box.addChild(new DynamicBorder());
  return box;
}
