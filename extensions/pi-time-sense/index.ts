/**
 * pi-time-sense: give the agent a sense of time. Pi's system prompt has no date (it was removed to keep
 * the prompt cacheable), so the model can't tell what day it is or how long a session has run.
 *
 * At most once per interval (default 1 hour), a hidden message like
 * `<automatic-current-time>Mon 2026-07-13 07:05 GMT+3 (session +2d3h)</automatic-current-time>` is added
 * at the end of the transcript. It only rides on activity that already calls the model, so it never
 * starts a turn of its own:
 * - before_agent_start: attached to the user's prompt.
 * - tool_execution_end: queued as a steer, consumed by the call that delivers the tool result.
 *   (Not turn_start: a steer queued during the final text-only turn would start a turn of its own.)
 *
 * Append-only, so the cached prompt prefix is untouched. Elapsed time counts from the oldest parent
 * session still on disk, so forks keep the original clock.
 */

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

const TYPE = "pi-time-sense";

function readConfig(): { intervalMinutes?: number } {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "extensions", `${TYPE}.json`), "utf8"));
  } catch {
    return {};
  }
}

// First line of a session file is its header; read just the start, since sessions can be large.
function readHeader(file: string): { timestamp?: string; parentSession?: string } {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return JSON.parse(buffer.toString("utf8", 0, bytes).split("\n")[0]);
  } finally {
    closeSync(fd);
  }
}

// Start of the oldest ancestor session still on disk. The seen set guards against cycles.
function sessionStart(header: { timestamp?: string; parentSession?: string }): number {
  const seen = new Set<string>();
  while (header.parentSession && !seen.has(header.parentSession)) {
    seen.add(header.parentSession);
    if (!existsSync(header.parentSession)) break;
    try {
      header = readHeader(header.parentSession);
    } catch {
      break;
    }
  }
  return Date.parse(header.timestamp ?? "") || Date.now();
}

const format = new Intl.DateTimeFormat("en-CA", {
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

// e.g. "Mon 2026-07-13 07:05 GMT+3"
function formatTime(date: Date): string {
  const p = Object.fromEntries(format.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

// e.g. "12m", "3h12m", "2d3h"
function formatElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  return `${minutes}m`;
}

export default function (pi: ExtensionAPI) {
  const { intervalMinutes } = readConfig();
  const minutes =
    typeof intervalMinutes === "number" && intervalMinutes >= 0 ? intervalMinutes : 60;
  const interval = minutes * 60_000;
  let start = Date.now();
  let lastSent = 0;

  pi.on("session_start", (_event, ctx) => {
    const header = ctx.sessionManager.getHeader();
    start = header ? sessionStart(header) : Date.now();
    // Pick up the last marker on this branch, so /reload or resume doesn't repeat one too soon.
    const last = ctx.sessionManager
      .getBranch()
      .findLast((e) => e.type === "custom_message" && e.customType === TYPE);
    lastSent = last ? Date.parse(last.timestamp) || 0 : 0;
  });

  // The marker text, or undefined if one was sent within the interval.
  function due() {
    const now = Date.now();
    if (now - lastSent < interval) return;
    lastSent = now;
    const text = `<automatic-current-time>${formatTime(new Date(now))} (session +${formatElapsed(now - start)})</automatic-current-time>`;
    return { customType: TYPE, content: text, display: false };
  }

  pi.on("before_agent_start", () => {
    const message = due();
    return message ? { message } : undefined;
  });

  pi.on("tool_execution_end", () => {
    const message = due();
    if (message) pi.sendMessage(message);
  });
}
