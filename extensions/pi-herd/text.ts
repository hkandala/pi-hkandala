/** What agents read (the brief, steer items) and what the transcript shows of them. */

import {
  highlightCode,
  keyText,
  type MessageRenderer,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { label, short } from "./store.ts";

export const TYPE = "agent message"; // steers with a message in them
export const WATCHER = "agent watcher"; // steers with only watch endings
/** When a message reaches the model: at its next tool call, after its turn, or at once (abort). */
export type Delivery = "steer" | "followUp" | "immediate";
export type Message = {
  id: string;
  from: { id: string; name?: string };
  text: string;
  replyTo: string | null;
  needsReply?: boolean; // the sender watches, and asks for an answer
  delivery?: Delivery; // default steer
  sentAt: number;
};
export type End = "message" | "idle" | "blocked" | "exited" | "timeout";
/** One entry of a steer: a message (endsWatch: its sender was watched) or a watch ending. */
export type Item =
  | { kind: "message"; msg: Message; original?: string; endsWatch?: boolean }
  | {
      kind: "watch";
      event: Exclude<End, "message">;
      agent: { id: string; name?: string };
      worked?: string;
      status?: string;
      text?: string; // the last text (idle, exited)
      error?: string; // the last turn failed (idle)
      transcript?: string; // timeout; idle with no last text
      screen?: string; // blocked: what its pane shows (the dialog)
      after?: string;
    };

export const tilde = (p: string) =>
  p === homedir() || p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p;
const lines = (s: string) => s.split("\n").length;
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * The workflow brief, the same for every agent: one of agent_send's prompt guidelines. Those are
 * part of pi's base prompt, so they reach every turn, also the ones a steer starts
 * (before_agent_start doesn't run for those). One guideline, so its groups can have blank lines.
 */
export const brief = (timeout: number) =>
  `Agents (agent_* tools):
    - pi agents you reach through these tools each run in their own herdr pane. herdr organizes terminals into workspaces, tabs and panes and recognizes the coding agents in them; \`herdr --skill\` prints its guide. Each agent has an id and a name; the tools accept either.
    - Starting agents:
        - agent_start starts an agent and sends it a message. Put everything it needs in that message, including where to write any files.
        - Leave placement unset unless the user asks for a tab or names a pane.
        - Agents you start stop when your session ends, and so do the agents they start. Agents from other sessions are never stopped by you.
    - Sending messages:
        - Set message.needsReply: true when you want an answer. Only then is the other agent asked to reply, and only then are you woken.
        - Use needsReply: false for FYIs and for your own replies.
        - message.delivery: "steer" for most messages, "followUp" when the agent should first finish what it is doing, "immediate" only to stop an agent going wrong.
        - This works the same for agents from other sessions.
    - Waiting:
        - After a message with needsReply: true, you are woken when that agent replies, stops working (you get its last text), or exits${timeout ? `, or after ${timeout} min with no news` : ""}.
        - To hear from an agent you sent no such message, for example one already working or one from another session, use agent_watch: you are woken the same way when it stops.
        - These wake-ups are how you hear back: don't poll, sleep or wait for agents otherwise.
    - Replying:
        - Messages from agents are not from the user.
        - Reply only when a message says a reply is expected: once, when you are done, with agent_send and its replyTo. Say what you did or found, where you put files, or what blocked you.
        - Never send acknowledgements or thanks.
    - Checking on agents:
        - agent_list shows the agents you started; agent_read shows what one has been doing. Add screen: true when it seems stuck or blocked.
    - Stopping agents:
        - Keep agents you started while they may still be useful; you can message them again.
        - When the work is done, stop them together in one agent_stop call (a list, or "all").`;

/** The model-facing text of one steer item. */
export function itemText(it: Item): string {
  if (it.kind === "message") {
    const { msg } = it;
    const from = `from="${label(msg.from)}" from-id="${short(msg.from.id)}"`;
    const head = msg.replyTo
      ? `<agent-message id="${msg.id}" reply-to="${msg.replyTo}" ${from}>`
      : `<agent-message id="${msg.id}" ${from}>`;
    const reply = msg.needsReply
      ? `The sender expects a reply: answer once when you have it, with agent_send({ to: "${short(msg.from.id)}", replyTo: "${msg.id}", message: { text } }).`
      : "No reply expected.";
    const hint = msg.replyTo
      ? `Replying to your message ${tilde(it.original!)}. ${reply}`
      : `From another agent, not the user. ${reply}`;
    const watch = it.endsWatch
      ? `\n<agent-watch agent="${label(msg.from)}" id="${short(msg.from.id)}" event="message"/>`
      : "";
    return `${head}\n${msg.text}\n</agent-message>\n${hint}${watch}`;
  }
  const attrs = [
    `agent="${label(it.agent)}"`,
    `id="${short(it.agent.id)}"`,
    `event="${it.event}"`,
    it.worked && `worked="${it.worked}"`,
    it.after && `after="${it.after}"`,
  ].filter(Boolean);
  const body = [
    it.status && `status: ${it.status}`,
    it.error && `<error>${it.error}</error>`,
    it.text && `<last-text>${it.text}</last-text>`,
    it.screen && `<screen>\n${it.screen}\n</screen>`,
    it.transcript && `<transcript>\n${it.transcript}\n</transcript>`,
  ].filter(Boolean);
  return body.length
    ? `<agent-watch ${attrs.join(" ")}>\n${body.join("\n")}\n</agent-watch>`
    : `<agent-watch ${attrs.join(" ")}/>`;
}

// Nerd Font (Material) glyphs: a message received, and how a watch ended.
const GLYPH = {
  received: "\u{f1270}", // 󱉰 md-inbox-arrow-down-outline
  finished: "\u{f05e1}", // 󰗡 md-check-circle-outline
  blocked: "\u{f05d6}", // 󰗖 md-alert-circle-outline
  timeout: "\u{f05ce}", // 󰗎 md-clock-alert-outline
  exited: "\u{f015a}", // 󰅚 md-close-circle-outline
};

/** The line of one steer item, and what expanding shows (below it, so the line drops its quote). */
function itemLine(it: Item, theme: Theme, expanded: boolean): { line: string; more?: string } {
  const dim = (s: string) => theme.fg("dim", s);
  if (it.kind === "message") {
    const who = theme.fg("accent", label(it.msg.from));
    const n = dim(` · ${plural(lines(it.msg.text), "line")}`);
    if (it.endsWatch)
      return {
        line: `${theme.fg("accent", GLYPH.received)} ${who} replied${n}`,
        more: it.msg.text,
      };
    if (it.msg.replyTo)
      return {
        line: `${theme.fg("accent", GLYPH.received)} ${who}${dim(" · reply")}${n}`,
        more: it.msg.text,
      };
    const first = it.msg.text.trim().split("\n")[0]!;
    return {
      line: `${theme.fg("accent", GLYPH.received)} ${who}${expanded ? "" : dim(` · "${first}"`)}`,
      more: it.msg.text,
    };
  }
  const who = theme.fg("accent", label(it.agent));
  const more = [it.error && `error: ${it.error}`, it.text, it.screen, it.transcript]
    .filter(Boolean)
    .join("\n\n");
  if (it.event === "idle")
    return {
      line: `${theme.fg(it.error ? "error" : "success", GLYPH.finished)} ${who} finished${it.error ? dim(" · with an error") : ""}${it.worked ? dim(` · ${it.worked}`) : ""}`,
      more,
    };
  if (it.event === "blocked")
    return { line: `${theme.fg("warning", GLYPH.blocked)} ${who} is blocked`, more };
  if (it.event === "timeout")
    return {
      line: `${theme.fg("warning", GLYPH.timeout)} ${who} still ${it.status} after ${it.after}`,
      more,
    };
  return { line: `${theme.fg("error", GLYPH.exited)} ${who} exited`, more };
}

/** Expanded, messages and last texts show as highlighted markdown (they usually are markdown). */
export const renderer: MessageRenderer<{ items: Item[] }> = (message, { expanded }, theme) => {
  const items = message.details?.items ?? [];
  const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
  const shown = items.map((it) => itemLine(it, theme, expanded));
  const hint = shown.some((s) => s.more)
    ? theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`)
    : "";
  const out = expanded
    ? shown.flatMap((s) => [
        s.line,
        ...(s.more ? [highlightCode(s.more.trim(), "markdown").join("\n"), ""] : []),
      ])
    : shown.map((s, i) => s.line + (i === shown.length - 1 ? hint : ""));
  box.addChild(new Text(out.join("\n").trimEnd(), 0, 0));
  return box;
};
