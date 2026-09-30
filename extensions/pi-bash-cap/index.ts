/**
 * pi-bash-cap: configurable output limits for pi's built-in bash tool.
 *
 * Pi hardcodes the bash cap at 2000 lines / 50KB. This re-applies it with the limits from
 * ~/.pi/agent/extensions/pi-bash-cap.json (default 1000 lines / 25KB) and keeps pi's flow: the tail
 * of the output, the same "[Showing lines ...]" notice, the full output in a temp file, and the exit
 * status last. The bash tool description is rewritten to state the configured limits.
 */

import {
  type ExtensionAPI,
  formatSize,
  getAgentDir,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What pi appends after the output: the truncation notice, then (on errors) the status line.
// The limits in pi's bash tool description: "Output is truncated to last 2000 lines or 50KB".
const LIMITS = /last \d+ lines or [\d.]+KB/;
const NOTICE = /\n\[Showing [^\n]*Full output: ([^\n]+)\]$/;
const STATUS =
  /\n?(Command (?:exited with code -?\d+|aborted|timed out after \S+ seconds|terminated without an exit code))$/;

function readConfig(): { maxLines?: number; maxBytes?: number } {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "extensions", "pi-bash-cap.json"), "utf8"));
  } catch {
    return {};
  }
}

export default function (pi: ExtensionAPI) {
  const { maxLines = 1000, maxBytes = 25 * 1024 } = readConfig();
  const limits = `last ${maxLines} lines or ${formatSize(maxBytes)}`;
  // pi-bash-bg asks for the limits (for its end messages) by emitting an object to fill in.
  pi.events.on("bash-cap:limits", (data) => Object.assign(data as object, { maxLines, maxBytes }));

  // Tool declarations live on system messages; rewrite bash's for each request.
  pi.on("context_with_system", (event) => ({
    messages: event.messages.map((m) =>
      m.role === "system" && m.toolsAdded
        ? {
            ...m,
            toolsAdded: m.toolsAdded.map((t) =>
              t.name === "bash" ? { ...t, description: t.description.replace(LIMITS, limits) } : t,
            ),
          }
        : m,
    ),
  }));

  pi.on("tool_result", (event) => {
    const [item, ...rest] = event.content;
    if (event.toolName !== "bash" || rest.length > 0 || item?.type !== "text") return;

    // Split pi's result back into output and status. If pi already truncated, start from its full output.
    let output = item.text;
    const status = event.isError ? output.match(STATUS) : null;
    if (status) output = output.slice(0, status.index);
    let path = output.match(NOTICE)?.[1];
    if (path) output = readFileSync(path, "utf8");

    const t = truncateTail(output, { maxLines, maxBytes });
    if (!t.truncated && !path) return;

    let text = t.content;
    if (t.truncated) {
      if (!path) {
        path = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
        writeFileSync(path, output);
      }
      const end = t.totalLines;
      const start = end - t.outputLines + 1;
      if (t.lastLinePartial) {
        const lastLine = output.replace(/\n$/, "");
        const lineSize = formatSize(
          Buffer.byteLength(lastLine.slice(lastLine.lastIndexOf("\n") + 1)),
        );
        text += `\n[Showing last ${formatSize(t.outputBytes)} of line ${end} (line is ${lineSize}). Full output: ${path}]`;
      } else if (t.truncatedBy === "lines") {
        text += `\n[Showing lines ${start}-${end} of ${end}. Full output: ${path}]`;
      } else {
        text += `\n[Showing lines ${start}-${end} of ${end} (${formatSize(maxBytes)} limit). Full output: ${path}]`;
      }
    }
    if (status) text = text ? `${text}\n${status[1]}` : status[1];

    return {
      content: [{ type: "text", text }],
      // Keeps other details (e.g. pi-bash-bg's durationMs); replaces pi's truncation ones.
      details: {
        ...(event.details as object),
        truncation: t.truncated ? t : undefined,
        fullOutputPath: t.truncated ? path : undefined,
      },
    };
  });
}
