/**
 * pi-ponytail: the ponytail "lazy senior dev" ruleset as a <ponytail> system prompt section.
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

// Where the full skill files live, so "use ponytail" or "ponytail review" in a prompt can be
// followed without the skills being registered.
const pointer = () =>
  "Ponytail skill files (read the matching one when the user asks to use ponytail or for a " +
  "ponytail review, audit, debt ledger, or gain):\n" +
  SKILLS.map((s) => `- ${s}: ${skillPath(s)}`).join("\n");

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
    else
      event.systemPromptOptions.sections.ponytail = `${instructions(skill, mode)}\n\n${pointer()}`;
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
