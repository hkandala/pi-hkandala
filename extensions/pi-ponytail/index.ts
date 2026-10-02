/**
 * pi-ponytail: the ponytail "lazy senior dev" ruleset, as a short <ponytail> system prompt section
 * (its gist, the mode, and the skill files the model must read before touching code).
 * Port of https://github.com/DietrichGebert/ponytail (skills/ copied as-is, not registered as pi
 * skills: /ponytail run sends them, and the section points the model at their files).
 *
 * /ponytail mode <lite|full|ultra|off> · status · run [ponytail|review|audit|debt|gain]
 *
 * The mode is not remembered: every session starts at defaultMode.
 * Config (optional): ~/.pi/agent/extensions/pi-ponytail.json  →  { "defaultMode": "full" }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODES = ["lite", "full", "ultra", "off"];
const SKILLS = ["ponytail", "review", "audit", "debt", "gain"];
const USAGE =
  "Usage: /ponytail mode <lite|full|ultra|off> · status · run [" + SKILLS.join("|") + "]";
const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "skills");
const skillName = (name: string) => (name === "ponytail" ? name : `ponytail-${name}`);
const skillPath = (name: string) => join(skillsDir, skillName(name), "SKILL.md");

function defaultMode(): string {
  try {
    const { defaultMode } = JSON.parse(
      readFileSync(join(getAgentDir(), "extensions", "pi-ponytail.json"), "utf8"),
    );
    if (MODES.includes(defaultMode)) return defaultMode;
  } catch {}
  return "full";
}

const stripFrontmatter = (text: string) => text.replace(/^---[\s\S]*?---\s*/, "").trim();

// A mode's intensity table row and example line in the ponytail SKILL.md.
const ROW = /^\| \*\*(lite|full|ultra)\*\* \| (.+?) \|$/;
const EXAMPLE = /^- (lite|full|ultra): "/;
const header = (mode: string) => `PONYTAIL MODE ACTIVE — level: ${mode}`;

/** SKILL.md body without frontmatter, keeping only this mode's intensity row and example. */
function instructions(skill: string, mode: string): string {
  const body = stripFrontmatter(skill)
    .split("\n")
    .filter((line) => {
      const m = line.match(ROW) ?? line.match(EXAMPLE);
      return !m || m[1] === mode;
    })
    .join("\n");
  return `${header(mode)}\n\n${body}`;
}

/**
 * The system prompt section: the gist, the mode's intensity row, and where the full rules are.
 * The model reads the ponytail skill file before code work, so the prompt stays short.
 */
function gist(skill: string, mode: string): string {
  const row = skill
    .split("\n")
    .map((line) => line.match(ROW))
    .find((m) => m?.[1] === mode)?.[2];
  return [
    `${header(mode)}${row ? `. ${row}` : ""}`,
    "",
    "You are a lazy senior developer: the simplest solution that works. Before writing code, ask in order: does it need to exist, is it already in this codebase, does the stdlib, the platform or an installed dependency cover it, can it be one line; only then write the minimum. Fix root causes, not symptoms. No unrequested abstractions; deletion over addition; the shortest correct diff, but only after reading the code it touches.",
    "",
    "You must read the ponytail skill file before writing, changing or reviewing code: it has the full rules and the output style. Read the others when the user asks for a ponytail review, audit, debt ledger, or gain.",
    ...SKILLS.map((s) => `- ${s}: ${skillPath(s)}`),
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  const skill = readFileSync(skillPath("ponytail"), "utf8");
  let mode = defaultMode();
  let pending: ReturnType<typeof setInterval> | undefined;
  const stopPending = () => {
    clearInterval(pending);
    pending = undefined;
  };

  /**
   * During a compaction with no run (a manual /compact), pi would start a run beside it for a custom
   * message, and refuses a prompt. Then `send` waits until it ends (checked every 100 ms) and this
   * returns true; one waits at a time.
   */
  function afterCompaction(ctx: ExtensionContext, send: () => void): boolean {
    const compacting = () => !ctx.isIdle() && !ctx.signal;
    if (!compacting()) return false;
    stopPending();
    ctx.ui.notify("Queued until compaction ends", "info");
    pending = setInterval(() => {
      try {
        if (compacting()) return;
        stopPending();
        send();
      } catch {
        stopPending(); // the session was replaced: ctx is stale
      }
    }, 100);
    return true;
  }

  pi.on("session_start", () => {
    mode = defaultMode();
  });
  pi.on("session_shutdown", stopPending);

  // A prompt section (not a full systemPrompt override), so a mode change is sent as a
  // section delta and the cached prefix survives.
  pi.on("before_agent_start", (event) => {
    if (mode === "off") delete event.systemPromptOptions.sections.ponytail;
    else event.systemPromptOptions.sections.ponytail = gist(skill, mode);
  });

  pi.registerCommand("ponytail", {
    description:
      "Ponytail: mode <lite|full|ultra|off>, status, run [ponytail|review|audit|debt|gain]",
    getArgumentCompletions: (prefix) => {
      const all = [...MODES.map((m) => `mode ${m}`), "status", ...SKILLS.map((s) => `run ${s}`)];
      const items = all.filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [cmd, arg = "ponytail"] = args.trim().toLowerCase().split(/\s+/);
      if (cmd === "mode" && MODES.includes(arg)) {
        mode = arg;
        ctx.ui.notify(`Ponytail mode set to ${mode}.`, "info");
      } else if (cmd === "status") {
        ctx.ui.notify(`Ponytail mode: ${mode} (default: ${defaultMode()}).`, "info");
      } else if (cmd === "run" && SKILLS.includes(arg)) {
        // The same block pi sends for /skill:<name>; the main ruleset keeps only this mode's rows.
        const path = skillPath(arg);
        const text = readFileSync(path, "utf8");
        const body =
          arg === "ponytail"
            ? instructions(text, mode === "off" ? "full" : mode)
            : stripFrontmatter(text);
        const message = `<skill name="${skillName(arg)}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`;
        // When idle, pi ignores deliverAs and sends it now.
        const send = () => pi.sendUserMessage(message, { deliverAs: "followUp" });
        if (!afterCompaction(ctx, send)) send();
      } else {
        ctx.ui.notify(USAGE, "warning");
      }
    },
  });
}
