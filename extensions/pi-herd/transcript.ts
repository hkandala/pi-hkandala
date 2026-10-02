/** What an agent has been doing, from its pi session file (or its pane's screen without one). */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { parseLine, rpc } from "./herdr.ts";
import { list, SESSIONS, type Agent } from "./store.ts";

export const KB = 1024;
const [TRANSCRIPT_MAX, ENTRY_MAX, LAST_MAX] = [16 * KB, KB, 4 * KB];
/** `s` cut to `max` bytes; a character cut in two is dropped (the decoder holds its start back). */
const cap = (s: string, max: number) => {
  const b = Buffer.from(s);
  return b.length <= max
    ? s
    : `${new TextDecoder().decode(b.subarray(0, max), { stream: true })}… [cut]`;
};

/** A pane's recent screen, the fallback when an agent has no session file. */
export const capture = (socket: string, pane: string, n: number) =>
  rpc(socket, "pane.read", { pane_id: pane, source: "recent_unwrapped", lines: n })
    .then((r) => cap(String(r.read.text).trimEnd(), TRANSCRIPT_MAX))
    .catch(() => "");

type Entry = { type: string; id: string; parentId: string | null; [k: string]: any };
/**
 * The session's active branch, newest first: from the last entry, following parentId. Reads the
 * file's last 4 MB only; entries further back are skipped.
 */
function branch(file: string): Entry[] {
  let text = "";
  try {
    const fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 4 * KB * KB);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, Entry>();
  let last: Entry | undefined;
  for (const line of text.split("\n")) {
    try {
      const e = JSON.parse(line) as Entry;
      if (e.id) byId.set(e.id, (last = e));
    } catch {} // the cut first line, or a line still being written
  }
  const out: Entry[] = [];
  for (let e = last; e; e = e.parentId ? byId.get(e.parentId) : undefined) out.push(e);
  return out;
}
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c?.type === "text")
          .map((c) => c.text)
          .join("\n")
      : "";
/** A tool call in one line: its name and first string argument (`→ bash npm test`). */
const callLine = (c: { name: string; arguments?: Record<string, unknown> }) => {
  const arg = Object.values(c.arguments ?? {}).find((v) => typeof v === "string") as string;
  return `→ ${c.name}${arg ? ` ${arg.split("\n")[0]!.slice(0, 100)}` : ""}`;
};
/** One transcript block per entry, or undefined for entries a transcript skips. */
function block(e: Entry): string | undefined {
  if (e.type === "custom_message") return `${e.customType}:\n${textOf(e.content)}`;
  if (e.type !== "message" || !e.message) return undefined;
  const m = e.message;
  if (m.role === "user") return `user:\n${textOf(m.content)}`;
  if (m.role === "toolResult")
    return `tool result: ${m.toolName} ${m.isError ? "error" : "ok"}: ${textOf(m.content).split("\n")[0]}`;
  if (m.role !== "assistant") return undefined;
  const calls = (Array.isArray(m.content) ? m.content : []).filter((c) => c?.type === "toolCall");
  return [`assistant:`, textOf(m.content), ...calls.map(callLine)].filter(Boolean).join("\n");
}
/** What an agent has been doing: its last `n` entries, capped (section 5 of the spec). */
export async function transcript(a: Agent, n: number, captureLines: number) {
  if (!a.session) return capture(a.herdr.socket, a.herdr.pane, captureLines);
  const blocks: string[] = [];
  let size = 0;
  for (const e of branch(a.session)) {
    const b = block(e);
    if (b === undefined) continue;
    const text = cap(b.trim(), ENTRY_MAX);
    if ((size += Buffer.byteLength(text)) > TRANSCRIPT_MAX || blocks.length === n) break;
    blocks.push(text);
  }
  return blocks.reverse().join("\n\n");
}
/** An agent's last assistant text. */
export async function lastText(a: Agent, captureLines: number, max = LAST_MAX) {
  if (!a.session) return cap(await capture(a.herdr.socket, a.herdr.pane, captureLines), max);
  for (const e of branch(a.session))
    if (e.type === "message" && e.message?.role === "assistant") {
      const text = textOf(e.message.content).trim();
      if (text) return cap(text, max);
    }
  return "";
}
/** The error the agent's last turn ended with, if it failed (an API error, say). */
export const lastError = (a: Agent) => {
  const last = a.session
    ? branch(a.session).find((e) => e.type === "message" && e.message?.role === "assistant")
    : undefined;
  return last?.message.stopReason === "error"
    ? cap(String(last.message.errorMessage ?? "error"), KB)
    : undefined;
};

/**
 * A saved pi session by id (or its last characters): its file, id, cwd, and name if it has one.
 * Looks in pi-herd's sessions folder (agents it started) and pi's default one, not a custom
 * --session-dir.
 */
export function findSession(ref: string) {
  const root = join(getAgentDir(), "sessions");
  const files = [SESSIONS, ...list(root).map((d) => join(root, d))].flatMap((d) =>
    list(d)
      .filter((f) => f.endsWith(`${ref}.jsonl`) && f.includes("_"))
      .map((f) => join(d, f)),
  );
  if (files.length !== 1)
    throw new Error(
      files.length
        ? `"${ref}" matches ${files.length} sessions; use the full session id.`
        : `No saved session "${ref}".`,
    );
  const file = files[0]!;
  let header: { id?: string; cwd?: string } | undefined;
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(64 * KB);
    readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    header = parseLine(buf.toString("utf8").split("\n")[0]!);
  } catch {}
  if (!header?.id) throw new Error(`Can't read session ${file}.`);
  const info = branch(file).find((e) => e.type === "session_info");
  return { file, id: header.id, cwd: header.cwd, name: info?.name as string | undefined };
}
