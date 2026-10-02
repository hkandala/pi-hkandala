/** What agents read (the brief, steer items) and what the transcript shows of them. */

import {
  DynamicBorder,
  highlightCode,
  keyText,
  type MessageRenderer,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
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

/**
 * The workflow brief, the same for every agent: one of agent_send's prompt guidelines. Those are
 * part of pi's base prompt, so they reach every turn, also the ones a steer starts
 * (before_agent_start doesn't run for those). One guideline, so it can be one heading with
 * nested bullets.
 */
export const brief = (timeout: number) =>
  `Agents (agent_* tools):
    - pi agents you reach through these tools each run in their own herdr pane. herdr organizes terminals into workspaces, tabs and panes and recognizes the coding agents in them; \`herdr --skill\` prints its guide. Each agent has an id and a name; the tools accept either.
    - Starting agents:
        - agent_start starts an agent and sends it a message. Put everything it needs in that message, including where to write any files.
        - Name it for what it works on, in 2 to 4 words of kebab-case: auth-test-fixer or api-docs-reviewer, not reviewer, so the user's agent lists say what each one does.
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

/**
 * The line of one steer item, what expanding shows below it, and for a message (or a reply) its
 * text on one line, shown after the line while collapsed.
 */
function itemLine(it: Item, theme: Theme): { line: string; more?: string; preview?: string } {
  const dim = (s: string) => theme.fg("dim", s);
  if (it.kind === "message") {
    const who = theme.fg("accent", label(it.msg.from));
    const kind = it.endsWatch ? " replied" : it.msg.replyTo ? dim(" · reply") : "";
    return {
      line: `${theme.fg("accent", GLYPH.received)} ${who}${kind}`,
      more: it.msg.text,
      preview: it.msg.text.replace(/\s+/g, " ").trim(),
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

/**
 * Collapsed, a message's text follows its line, dim, its line breaks dropped, up to 2 rows, then
 * `…`; the expand hint shows only when something is hidden. Expanded, messages and last texts
 * show as highlighted markdown (they usually are markdown): a message's right after its line, as
 * when collapsed; a watch ending's after a blank line.
 */
export const renderer: MessageRenderer<{ items: Item[] }> = (message, { expanded }, theme) => {
  const dim = (s: string) => theme.fg("dim", s);
  const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
  const shown = (message.details?.items ?? []).map((it) => itemLine(it, theme));
  if (expanded) {
    const out = shown.flatMap((s) => {
      if (!s.more) return [s.line];
      const [first, ...rest] = highlightCode(s.more.trim(), "markdown");
      return s.preview === undefined
        ? [s.line, "", first!, ...rest, ""]
        : [s.line + dim(" · ") + first, ...rest, ""];
    });
    box.addChild(new Text(out.join("\n").trimEnd(), 0, 0));
    return box;
  }
  let last: { width: number; lines: string[] } | undefined; // drawn on every frame
  box.addChild({
    invalidate: () => (last = undefined),
    render: (width: number) => {
      if (last?.width === width) return last.lines;
      const hint = dim(` (${keyText("app.tools.expand")} to expand)`);
      let hidden = false;
      let fitted = false; // the hint is already on the last row (the cut's)
      const lines = shown.flatMap((s, i) => {
        if (s.preview === undefined) {
          hidden ||= !!s.more;
          return wrapTextWithAnsi(s.line, width);
        }
        const rows = wrapTextWithAnsi(s.line + dim(` · ${s.preview}`), width);
        if (rows.length <= 2) return rows;
        hidden = true;
        // The last item's second row leaves room for the hint.
        fitted = i === shown.length - 1;
        const room = width - 1 - (fitted ? visibleWidth(hint) : 0);
        return [rows[0]!, truncateToWidth(rows[1]!, room, "") + dim("…") + (fitted ? hint : "")];
      });
      if (hidden && !fitted) lines.push(...wrapTextWithAnsi(lines.pop()! + hint, width));
      last = { width, lines };
      return lines;
    },
  });
  return box;
};

/** An /agents list entry: its title, and a row per agent (name, id, state, cwd, tags). */
export type ListData = { title: string; rows: string[][] };
/**
 * /agents list prints agents like /background list does jobs: a framed entry, not sent to the
 * model. Only entries from this runtime (loadedAt: when it loaded) show.
 */
export const listRenderer =
  (loadedAt: number) =>
  (entry: { timestamp: string; data?: ListData }, _o: unknown, theme: Theme) => {
    if (Date.parse(entry.timestamp) < loadedAt) return undefined;
    const dim = (s: string) => theme.fg("dim", s);
    const { title, rows: list = [] } = entry.data!;
    const lines = list.map(
      ([name, id, state, cwd, tags]) =>
        `${dim("•")} ${theme.fg("accent", name!)} ${dim(id!)} ${theme.fg("text", `· ${state} · ${cwd}`)}` +
        (tags ? ` ${theme.fg("accent", `· ${tags}`)}` : ""),
    );
    const box = new Container();
    box.addChild(new DynamicBorder());
    box.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
    box.addChild(new Spacer(1));
    box.addChild(new Text(lines.join("\n") || dim("No matching agents."), 1, 0));
    box.addChild(new DynamicBorder());
    return box;
  };
