// Self-check for keep(): node extensions/pi-prompt-keep/test.ts
import { deepStrictEqual as eq } from "node:assert";
import { keep } from "./index.ts";

type S = Record<string, string | null>;
const sys = (sections: S) => ({ role: "system", content: "", sections });
const user = { role: "user" };
const tool = { role: "toolResult" };
const asst = { role: "assistant" };
const wake = { role: "custom" };

/** The prompt a model that folds system messages sees after each message. */
const heads = (messages: { role: string; sections?: S }[]) => {
  const head: Record<string, string> = {};
  return messages.map((m) => {
    for (const [k, v] of Object.entries(m.sections ?? {})) {
      if (v === null) delete head[k];
      else head[k] = v;
    }
    return JSON.stringify(head);
  });
};
const sent = (ms: { role: string; sections?: S }[]) => heads(keep(ms)).at(-1);

const base = { preamble: "p", tools: "t", project_context: "ctx", cwd: "/w" };
const P0 = sys({
  ...base,
  project_context: "ctx+claude",
  mw: "repo",
  pt: "rules",
  prompt_keep: "1",
});
const W = sys({ project_context: "ctx", mw: null, pt: null, prompt_keep: null });
const full = JSON.stringify({ ...base, project_context: "ctx+claude", mw: "repo", pt: "rules" });

// A woken run's patch is held; the next prompt's re-add is a no-op: the head never changes.
const run = [P0, user, asst, wake, asst, tool, W, asst];
eq(sent(run), full);
const reAdd = sys({ project_context: "ctx+claude", mw: "repo", pt: "rules", prompt_keep: "1" });
eq(new Set(heads(keep([...run, reAdd, user, asst]))).size, 1);

// The same when a user steer or follow-up lands right after the woken run's patch.
eq(sent([P0, user, asst, wake, asst, tool, W, user, asst]), full);
eq(sent([P0, user, asst, wake, asst, W, user]), full);

// Base sections apply at once, even in a woken run's patch.
const Wt = sys({ tools: "t2", mw: null, pt: null, prompt_keep: null });
eq(JSON.parse(sent([P0, user, asst, wake, asst, tool, Wt])!).tools, "t2");

// A real change recorded in a woken run waits for the next prompt, then applies.
const Wreal = sys({ project_context: "ctx2", mw: null, pt: null, prompt_keep: null });
const P1 = sys({ project_context: "ctx2+claude", mw: "repo", pt: "rules", prompt_keep: "1" });
eq(JSON.parse(sent([P0, user, wake, asst, tool, Wreal])!).project_context, "ctx+claude");
eq(JSON.parse(sent([P0, user, wake, asst, tool, Wreal, P1, user])!).project_context, "ctx2+claude");

// ponytail turned off between: the prompt doesn't set pt again, so the held removal applies.
const Poff = sys({ project_context: "ctx+claude", mw: "repo", prompt_keep: "1" });
eq(JSON.parse(sent([P0, user, wake, asst, tool, W, Poff, user])!).pt, undefined);

// History from before the marker passes through unchanged.
const old = [sys({ ...base, mw: "repo" }), user, wake, asst, tool, sys({ mw: null }), asst];
eq(heads(keep(old)), heads(old));

// The marker never reaches the model, and the leading system message stays.
eq(
  keep(run).some((m) => "sections" in m && m.sections && "prompt_keep" in m.sections),
  false,
);
eq(keep([sys({ prompt_keep: "1" }), user])[0].role, "system");

console.log("pi-prompt-keep: ok");
