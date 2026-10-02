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
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

// The limits in pi's bash tool description: "Output is truncated to last 2000 lines or 50KB".
const LIMITS = /last \d+ lines or [\d.]+KB/;
// Pi's own byte cap. A last line longer than this gets pi's "(line is X)" notice.
const PI_MAX_BYTES = 50 * 1024;

// What pi appends after the output: the truncation notice, then (on errors) the status line.
const NOTICE = /\n\[Showing [^\n]*Full output: ([^\n]+)\]$/;
const STATUS =
  /\n?(Command (?:exited with code -?\d+|aborted|timed out after \S+ seconds|terminated without an exit code))$/;
// Pi's temp files: tmpdir()/pi-bash-<hex>.log.
const isSpill = (path: string) =>
  dirname(path) === tmpdir() && /^pi-bash-[0-9a-f]+\.log$/.test(basename(path));

function readConfig(): { maxLines?: unknown; maxBytes?: unknown } {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "extensions", "pi-bash-cap.json"), "utf8"));
  } catch {
    return {};
  }
}

const positive = (value: unknown, fallback: number) =>
  Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;

// The last `bytes` bytes of a file, and its size. The first line may be cut.
function readTail(path: string, bytes: number): { text: string; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, bytes));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return { text: buffer.toString("utf8"), size };
  } finally {
    closeSync(fd);
  }
}

export default function (pi: ExtensionAPI) {
  const config = readConfig();
  const maxLines = positive(config.maxLines, 1000);
  const maxBytes = positive(config.maxBytes, 25 * 1024);
  const size = formatSize(maxBytes);
  const limits = `last ${maxLines} lines or ${size}`;
  // pi-bash-bg asks for the limits (for its end messages) by emitting an object to fill in.
  pi.events.on("bash-cap:limits", (data) => Object.assign(data as object, { maxLines, maxBytes }));

  // The same notice pi writes, for these limits. `lineSize` is the size of a cut last line.
  function notice(t: ReturnType<typeof truncateTail>, path: string, lineSize: string): string {
    const end = t.totalLines;
    const start = end - t.outputLines + 1;
    if (t.lastLinePartial) {
      return `\n[Showing last ${formatSize(t.outputBytes)} of line ${end} (line is ${lineSize}). Full output: ${path}]`;
    }
    if (t.truncatedBy === "lines")
      return `\n[Showing lines ${start}-${end} of ${end}. Full output: ${path}]`;
    return `\n[Showing lines ${start}-${end} of ${end} (${size} limit). Full output: ${path}]`;
  }

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

    // Split pi's result back into output and status.
    let output = item.text;
    const status = event.isError ? output.match(STATUS) : null;
    if (status) output = output.slice(0, status.index);

    // If pi truncated, start from its full output. Trust the notice only if pi wrote it: on success
    // pi records the path in details; error results lose details, so the path must be pi's temp file.
    const found = output.match(NOTICE);
    const recorded = (event.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
    let path =
      found && (found[1] === recorded || (event.isError && isSpill(found[1])))
        ? found[1]
        : undefined;
    let total: number | undefined;
    let totalBytes: number | undefined;
    let lineSize: string | undefined;
    if (found && path) {
      // Pi's notice has the line count (and a cut last line's size), so only the file's tail is
      // read: enough for these limits plus one whole last line that pi did not cut.
      total = Number(found[0].match(/ of (?:line )?(\d+)/)?.[1]) || undefined;
      lineSize = found[0].match(/\(line is ([^)]+)\)/)?.[1];
      try {
        if (total) {
          const tail = readTail(path, Math.max(maxBytes, PI_MAX_BYTES) + 2);
          output = tail.text;
          totalBytes = tail.size;
        } else {
          output = readFileSync(path, "utf8");
        }
      } catch {
        return; // keep pi's result
      }
    }

    const t = truncateTail(output, { maxLines, maxBytes });
    if (!t.truncated && !path) return;

    let text = t.content;
    if (t.truncated) {
      if (!path) {
        path = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
        writeFileSync(path, output);
      }
      if (total) Object.assign(t, { totalLines: total, totalBytes });
      if (t.lastLinePartial && !lineSize) {
        const lastLine = output.replace(/\n$/, "");
        lineSize = formatSize(Buffer.byteLength(lastLine.slice(lastLine.lastIndexOf("\n") + 1)));
      }
      text += notice(t, path, lineSize ?? "");
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
