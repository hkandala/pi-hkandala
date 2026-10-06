/**
 * pi-cache-keep: keeps the sections `before_agent_start` hooks add to the system prompt
 * (ponytail, meta_workspace, CLAUDE.md in project_context, mcp_servers, ...) in runs that an
 * extension message starts (`sendMessage` with `triggerTurn`: pi-herd, pi-bash-bg, pi-continue).
 *
 * pi runs those hooks only for a prompt. In a woken run it diffs its base options (no hook
 * sections) against the transcript on turn 2 and records a patch that removes them; the next
 * prompt adds them back. Models that fold system messages into the leading prompt lose the cache
 * after the tools on each of these patches, and the model works without the sections meanwhile.
 *
 * A marker section set in `before_agent_start` labels every patch pi builds in a prompt run; a
 * woken run's first patch removes it. Patches recorded while the marker is gone are untrusted:
 * their hook-owned keys are held back until the next prompt run's patch, which re-sets every key
 * a held value got wrong; the rest (real changes) are released there. Only what is sent changes;
 * the session file keeps pi's patches.
 *
 * A compaction in a woken run saves the state without the sections; the session file still has
 * them, so `keep()` reads them back from there (this survives a /reload).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Named before the rename to pi-cache-keep; sessions have it recorded, so it stays.
const MARK = "prompt_keep";
/** Sections only pi's base prompt builds: no hook edits them, so they apply at once. */
const BASE = new Set(["preamble", "tools", "rules", "docs", "skills", "cwd", "addendum"]);

type Sections = Record<string, string | null>;
type Msg = {
  role: string;
  sections?: Sections;
  content?: unknown;
  toolsAdded?: unknown[];
  toolsRemoved?: unknown[];
};
type Entry = { type: string; message?: Msg };

const apply = (state: Record<string, string>, sections: Sections) => {
  for (const [k, v] of Object.entries(sections)) {
    if (v === null) delete state[k];
    else state[k] = v;
  }
};

/** The messages to send: untrusted section patches held back, no-op entries and the marker removed. */
export function keep<T extends Msg>(messages: T[], branch?: () => Entry[]): T[] {
  const first = messages[0];
  const head = first?.sections;
  // A compaction in a woken run saved the state without the hook sections and the marker. Undo
  // that fold: send the state last marked before it, then the woken run's patch, which is held.
  if (branch && head && !(MARK in head) && messages[1]?.role === "compactionSummary") {
    const entries = branch();
    const state: Record<string, string> = {};
    let seed: Record<string, string> = {};
    const compaction = entries.findLastIndex((e) => e.type === "compaction");
    for (const e of entries.slice(0, compaction)) {
      if (e.message?.role !== "system") continue;
      apply(state, e.message.sections ?? {});
      if (MARK in state)
        seed = Object.fromEntries(Object.entries(state).filter(([k]) => !BASE.has(k)));
    }
    const back = Object.fromEntries(Object.keys(seed).map((k) => [k, head[k] ?? null]));
    const woken = { role: "system", content: "", sections: back } as T;
    messages = [{ ...first, sections: { ...head, ...seed } }, woken, ...messages.slice(1)];
  }
  const raw: Record<string, string> = {}; // what pi's transcript says
  const sent: Record<string, string> = {}; // what the model gets
  let held: Sections = {};
  let marked = false; // the marker was seen: from then on its absence means a woken run's patch
  const out: T[] = [];
  for (const m of messages) {
    if (m.role !== "system" || !m.sections) {
      out.push(m);
      continue;
    }
    apply(raw, m.sections);
    if (MARK in raw) marked = true;
    const trusted = !marked || MARK in raw; // before the marker (older history): pass through
    const patch: Sections = {};
    const emit = (k: string, v: string | null) => {
      if (k === MARK || (sent[k] ?? null) === v) return;
      patch[k] = v;
      if (v === null) delete sent[k];
      else sent[k] = v;
    };
    for (const [k, v] of Object.entries(m.sections)) {
      if (trusted || BASE.has(k)) {
        delete held[k];
        emit(k, v);
      } else held[k] = v;
    }
    if (trusted) {
      for (const [k, v] of Object.entries(held)) emit(k, v);
      held = {};
    }
    const { sections: _, ...rest } = m;
    const keepIt =
      out.length === 0 || // providers read the prompt and the first tools from the leading one
      Object.keys(patch).length > 0 ||
      (typeof rest.content === "string" ? rest.content : (rest.content as unknown[])?.length) ||
      rest.toolsAdded?.length ||
      rest.toolsRemoved?.length;
    if (keepIt) out.push({ ...rest, ...(Object.keys(patch).length && { sections: patch }) } as T);
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  let warned = false;

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections[MARK] = "1";
  });

  pi.on("context_with_system", (event, ctx) => {
    const messages = event.messages as Msg[];
    // A `context` handler that edits the list makes pi fold every system message into one
    // before this runs: nothing to filter then. Say so once.
    if (!warned && ctx.mode === "tui" && messages.filter((m) => m.role === "system").length === 1) {
      const branch = ctx.sessionManager.getBranch();
      const since = branch.findLastIndex((e) => e.type === "compaction");
      const notes = branch
        .slice(since + 1)
        .filter((e) => e.type === "message" && (e.message as Msg).sections).length;
      if (notes > 1) {
        warned = true;
        ctx.ui.notify(
          "pi-cache-keep: a `context` handler merged the system messages; prompt sections may drop in woken runs.",
          "warning",
        );
      }
    }
    const branch = () => ctx.sessionManager.getBranch() as Entry[];
    return { messages: keep(messages, branch) as typeof event.messages };
  });
}
