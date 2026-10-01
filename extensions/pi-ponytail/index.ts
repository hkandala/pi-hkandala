/**
 * pi-ponytail: the ponytail "lazy senior dev" ruleset, as a short <ponytail> system prompt section
 * (its gist, the mode, and the skill files the model must read before touching code).
 * Port of https://github.com/DietrichGebert/ponytail (skills/ copied as-is, not registered as pi
 * skills: /ponytail run sends them, and the section points the model at their files).
 *
 * /ponytail mode [lite|full|ultra|off] · status · run [ponytail|review|audit|debt|gain]
 *
 * The mode is not remembered: every session starts at defaultMode.
 * Config (optional): ~/.pi/agent/extensions/pi-ponytail.json  →  { "defaultMode": "full" }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODES = ["lite", "full", "ultra", "off"];
const SKILLS = ["ponytail", "review", "audit", "debt", "gain"];
const USAGE =
  "Usage: /ponytail mode [lite|full|ultra|off] · status · run [" + SKILLS.join("|") + "]";
const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "skills");
const skillPath = (name: string) =>
  join(skillsDir, name === "ponytail" ? name : `ponytail-${name}`, "SKILL.md");

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

/** SKILL.md body without frontmatter, keeping only this mode's intensity row and example. */
export function instructions(skill: string, mode: string): string {
  const body = stripFrontmatter(skill)
    .split("\n")
    .filter((line) => {
      const m =
        line.match(/^\| \*\*(lite|full|ultra)\*\* \|/) ?? line.match(/^- (lite|full|ultra): "/);
      return !m || m[1] === mode;
    })
    .join("\n");
  return `PONYTAIL MODE ACTIVE — level: ${mode}\n\n${body}`;
}

/**
 * The system prompt section: the gist, the mode's intensity row, and where the full rules are.
 * The model reads the ponytail skill file before code work, so the prompt stays short.
 */
export function gist(skill: string, mode: string): string {
  const row = skill.match(new RegExp(`^\\| \\*\\*${mode}\\*\\* \\| (.+?) \\|$`, "m"))?.[1];
  return [
    `PONYTAIL MODE ACTIVE — level: ${mode}${row ? `. ${row}` : ""}`,
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

  pi.on("session_start", () => {
    mode = defaultMode();
  });

  // A prompt section (not a full systemPrompt override), so a mode change is sent as a
  // section delta and the cached prefix survives.
  pi.on("before_agent_start", (event) => {
    if (mode === "off") delete event.systemPromptOptions.sections.ponytail;
    else event.systemPromptOptions.sections.ponytail = gist(skill, mode);
  });

  pi.registerCommand("ponytail", {
    description:
      "Ponytail: mode [lite|full|ultra|off], status, run [ponytail|review|audit|debt|gain]",
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
        const name = arg === "ponytail" ? arg : `ponytail-${arg}`;
        pi.sendUserMessage(
          `<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`,
          { deliverAs: ctx.isIdle() ? undefined : "followUp" },
        );
      } else {
        ctx.ui.notify(USAGE, "warning");
      }
    },
  });
}
