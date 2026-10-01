/**
 * pi-bash-bg: background bash for pi.
 *
 * Replaces the bash tool with pi's own, run through a wrapper that writes output to a log file, so
 * a running call can move to the background (background: true, ctrl+shift+b, /background, or after
 * 120s) without restarting it. Jobs are identified by pid and outlive /reload, session switches
 * and a pi exit. When a watched job ends, the session gets a steer message shaped like a bash
 * result. Tools: bash_list, bash_watch. Command: /background [list | logs | kill] (see the README).
 *
 * Jobs live flat in ~/.pi/agent/bash-bg/: <id>.log, <id>.exit (exit code), <id>.json (written when
 * the call moves to the background) and <id>.watch.<sessionId> (empty; this session watches it).
 * Config (optional): ~/.pi/agent/extensions/pi-bash-bg.json
 *   { "autoBackgroundSeconds": 120, "shortcut": "ctrl+shift+b", "keepOnExit": true }
 * See docs/SPEC.md for the design.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  DynamicBorder,
  type CustomMessageEntryDraft,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  formatSize,
  getAgentDir,
  getShellConfig,
  highlightCode,
  keyText,
  SettingsManager,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  type KeyId,
  Spacer,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { constants, homedir } from "node:os";
import { join } from "node:path";
import { cut, FULL_SCREEN, LogViewer } from "./viewer.ts";

const DIR = join(getAgentDir(), "bash-bg");
const TYPE = "background job";
const DAY = 86_400_000;
const TAIL_BYTES = 1024 * 1024; // end messages read at most the log's last 1MB
const COLLAPSED_LINES = 4; // a collapsed end message's most lines
// $1 the command, $2 the exit file. `& wait` lets the trap run while the command runs; the trap
// stops the whole group, so plain `kill <pid>` takes `&` grandchildren down too.
const WRAPPER = `trap 'trap - TERM INT HUP; echo 143 > "$2"; kill -TERM 0' TERM INT HUP
(__cmd=$1; set --; eval "$__cmd") & wait $!; c=$?; echo $c > "$2"; exit $c`;
const SLEEP_TIP =
  "Tip: don't sleep to wait. Run long commands with background: true; you'll be notified when they exit.";

type Meta = { pid: number; command: string; cwd: string; startedAt: number; sessionId: string };
/** code: undefined while running, null when it ended without one (kill -9, reboot). */
type Job = Meta & { id: string; log: string; code?: number | null; endedAt?: number };
/** Why a call moved to the background: the agent asked, the user did, or it ran too long. */
type Reason = "agent" | "user" | "auto";
type Call = { startedAt: number; background: (reason: Reason) => void; abort: () => void };

// Survives /reload: which watched jobs this session has seen running, and the last herdr flag.
const g = ((globalThis as { __piBashBg?: unknown }).__piBashBg ??= {}) as {
  seen?: { sessionId: string; ids: Set<string> };
  herdr?: boolean;
  poke?: () => void;
  cleaned?: boolean;
};

const file = (id: string, ext: string) => join(DIR, `${id}.${ext}`);
const readJson = (path: string): Record<string, any> => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};
const alive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const oneLine = (cmd: string) => {
  const lines = cmd.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : lines[0]!;
};
const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m`;
};
const killed = (code: number) => code === 129 || code === 130 || code === 143;
const state = (j: Job) =>
  j.code === undefined
    ? "running"
    : j.code === null
      ? "ended"
      : killed(j.code)
        ? "killed"
        : `exit ${j.code}`;
const elapsed = (j: Job) => duration((j.endedAt ?? Date.now()) - j.startedAt);
/** ● running, ✓ exit 0, ■ killed, ✗ anything else. */
const stateIcon = (theme: Theme, s: string) =>
  s === "running"
    ? theme.fg("accent", "●")
    : s === "exit 0"
      ? theme.fg("success", "✓")
      : s === "killed"
        ? theme.fg("warning", "■")
        : theme.fg("error", "✗");

/** Job ids whose file names end with the suffix, newest first. */
const ids = (suffix: string) => {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(suffix))
      .map((f) => f.slice(0, f.indexOf(".")))
      .sort((a, b) => parseInt(b) - parseInt(a));
  } catch {
    return [];
  }
};

// Meta files never change and an ended job stays ended, so both are read once.
const metas = new Map<string, Meta>();
const ended = new Map<string, Job>();
function job(id: string): Job | undefined {
  const done = ended.get(id);
  if (done) return done;
  let meta = metas.get(id);
  if (!meta) {
    const json = readJson(file(id, "json"));
    if (typeof json.pid !== "number") return undefined; // a foreground call, or not written yet
    metas.set(id, (meta = json as Meta));
  }
  const j: Job = { ...meta, id, log: file(id, "log") };
  const exitCode = () => {
    try {
      const text = readFileSync(file(id, "exit"), "utf8").trim(); // empty: being written
      return text ? Number(text) : undefined;
    } catch {
      return undefined;
    }
  };
  let code = exitCode();
  if (code === undefined && alive(meta.pid)) return j;
  code ??= exitCode(); // it may have exited between the two checks
  let endedAt = Date.now();
  try {
    endedAt = statSync(code === undefined ? j.log : file(id, "exit")).mtimeMs;
  } catch {}
  const result = { ...j, code: code ?? null, endedAt };
  ended.set(id, result);
  return result;
}
const jobs = (list: string[]) => list.map(job).filter((j): j is Job => !!j);
const byPid = (pid: number) => jobs(ids(".json")).find((j) => j.pid === pid);
const terminate = (j: Job) => {
  try {
    process.kill(-j.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
};

/** Lines in a file, counted in 1MB chunks. */
function lineCount(path: string): number {
  let n = 0;
  let last = 10;
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(1024 * 1024);
    for (let read; (read = readSync(fd, buf, 0, buf.length, null)) > 0; last = buf[read - 1]!)
      for (let i = buf.indexOf(10); i !== -1 && i < read; i = buf.indexOf(10, i + 1)) n++;
    closeSync(fd);
  } catch {}
  return last === 10 ? n : n + 1;
}

type Limits = { maxLines: number; maxBytes: number };
/** How a job ended: its output tail, capped like the bash tool's, and where the rest is. */
function ending(j: Job, limits: Limits) {
  let size = 0;
  let text = "";
  try {
    size = statSync(j.log).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(j.log, "r");
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the cut first line
  } catch {}
  const t = truncateTail(text, limits);
  const total = lineCount(j.log);
  return {
    pid: j.pid,
    command: j.command,
    code: j.code ?? null,
    state: state(j),
    elapsed: elapsed(j),
    output: t.content.replace(/\n$/, ""),
    note:
      t.outputLines < total
        ? `[Showing the last ${t.outputLines} of ${total} lines. Full output (${formatSize(size)}): ${j.log}]`
        : undefined,
  };
}
type Ending = ReturnType<typeof ending>;

/** The end message's text for the agent, shaped like a bash result. */
function endText(e: Ending): string {
  const what =
    e.code === null
      ? "ended without an exit code"
      : killed(e.code)
        ? "was killed"
        : `exited with code ${e.code}`;
  const lines = [`Background job ${e.pid} \`${oneLine(e.command)}\` ${what} after ${e.elapsed}.`];
  if (e.output) lines.push(e.output);
  if (e.note) lines.push(e.note);
  if (e.code) lines.push(`Command exited with code ${e.code}`);
  return lines.join("\n");
}

/** Deletes finished jobs' files after 7 days and crashed foreground calls' after a day. */
async function cleanup() {
  const files = await readdir(DIR).catch(() => [] as string[]);
  const byId = Map.groupBy(files, (f) => f.slice(0, f.indexOf(".")));
  for (const [id, names] of byId) {
    const j = names.includes(`${id}.json`) ? job(id) : undefined;
    const old = j
      ? j.endedAt !== undefined && Date.now() - j.endedAt > 7 * DAY
      : Date.now() - parseInt(id) > DAY;
    if (!old) continue;
    for (const name of names) await unlink(join(DIR, name)).catch(() => {});
    metas.delete(id);
    ended.delete(id);
  }
}

export default function (pi: ExtensionAPI) {
  const config = {
    autoBackgroundSeconds: 120,
    shortcut: "ctrl+shift+b",
    keepOnExit: true,
    ...readJson(join(getAgentDir(), "extensions", "pi-bash-bg.json")),
  };
  let ctx: ExtensionContext | undefined;
  let sessionId = "";
  let settings: SettingsManager | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let pokeTimer: ReturnType<typeof setTimeout> | undefined;
  let waking: ReturnType<typeof setTimeout> | undefined; // an end message is waking an idle agent
  let busy = false; // an agent run is going
  let settling: CustomMessageEntryDraft[] | undefined; // print mode: end messages go into agent_before_settle
  let lastUpdate = "";
  const calls = new Set<Call>(); // running foreground calls

  const seen = () => g.seen?.ids ?? new Set<string>();
  /** The bash tool's output limits: pi-bash-cap's when it's loaded (it fills them in), else pi's. */
  const limits = () => {
    const l: Limits = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };
    pi.events.emit("bash-cap:limits", l);
    return l;
  };
  const watchedIds = () => (sessionId ? ids(`.watch.${sessionId}`) : []);
  type Scope = "watching" | "all";
  type Status = "running" | "finished" | "any";
  /** bash_list's and /background list's filter: whose jobs, and in which state. */
  const find = (which: Scope, status: Status) =>
    jobs(which === "all" ? ids(".json") : watchedIds()).filter(
      (j) => status === "any" || (j.code === undefined) === (status === "running"),
    );
  const running = (list: Job[]) => list.filter((j) => j.code === undefined);
  /** Watched jobs, then other sessions' running ones: what the pickers and completions offer. */
  const listed = (watched = watchedIds()) => [
    ...jobs(watched),
    ...running(jobs(ids(".json").filter((id) => !watched.includes(id)))),
  ];

  // herdr (optional patch, see herdr/README.md at the repo root): working while watched jobs run.
  // It plays "done" on every working → idle change, so it must never see a gap.
  const emitHerdr = (active: boolean) => {
    g.herdr = active;
    pi.events.emit("herdr:working", { source: "pi-bash-bg", active });
  };
  if (g.herdr) emitHerdr(true); // /reload: before herdr's new runtime publishes its first state

  /** Recomputes the running and waiting counts; tells pi-footer, pi-working and herdr. */
  const refresh = () => {
    if (!ctx) return;
    const mine = jobs(watchedIds());
    const count = running(mine).length;
    const waiting = busy ? 0 : count;
    const update = {
      jobs: mine.map((j) => ({
        pid: j.pid,
        command: j.command,
        cwd: j.cwd,
        startedAt: j.startedAt,
        endedAt: j.endedAt,
        state: state(j),
      })),
      running: count,
      waiting,
      shortcut: config.shortcut,
    };
    const json = JSON.stringify(update);
    if (json !== lastUpdate) pi.events.emit("bash-bg:update", update);
    lastUpdate = json;
    // Also during the turn: herdr publishes idle when the turn settles, before this could say
    // otherwise, and an agent watching this one would take that as finished.
    const active = count > 0 || !!waking;
    if (active !== g.herdr) emitHerdr(active);
  };

  /** Sends the end message for watched jobs that ended since the last check. */
  const check = () => {
    if (!ctx) return;
    const done = jobs([...seen()]).filter((j) => j.code !== undefined);
    for (const j of done) seen().delete(j.id);
    if (done.length) {
      const endings = done.map((j) => ending(j, limits()));
      const message = {
        customType: TYPE,
        content: endings.map(endText).join("\n\n"),
        display: true as const,
        details: { jobs: endings },
      };
      if (settling) settling.push({ type: "custom_message", ...message });
      else {
        if (!busy) {
          // Keep herdr working until the woken run starts.
          clearTimeout(waking);
          waking = setTimeout(() => {
            waking = undefined;
            refresh();
          }, 2000);
        }
        pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
      }
    }
    refresh();
  };

  /** Runs one bash call through the wrapper; resolves early when it moves to the background. */
  const run = (
    command: string,
    cwd: string,
    opts: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
    shown: string,
    background: boolean,
    tip: boolean,
    onBackground: (text: string) => void,
  ) =>
    new Promise<{ exitCode: number | null }>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new Error("aborted"));
      if (!existsSync(cwd))
        return reject(
          new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`),
        );
      mkdirSync(DIR, { recursive: true });
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const log = file(id, "log");
      const out = openSync(log, "a");
      const child = spawn(
        getShellConfig(settings?.getShellPath()).shell,
        ["-c", WRAPPER, "bash", command, file(id, "exit")],
        { cwd, env: opts.env, detached: true, stdio: ["ignore", out, out] },
      );
      closeSync(out);
      const input = openSync(log, "r");
      let offset = 0;
      const pump = () => {
        for (let n = 1; n > 0;) {
          const buf = Buffer.alloc(64 * 1024);
          n = readSync(input, buf, 0, buf.length, offset);
          offset += n;
          if (n > 0) opts.onData(buf.subarray(0, n));
        }
      };
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {}
      };
      let timedOut = false;
      const timer = opts.timeout
        ? setTimeout(() => {
            timedOut = true;
            kill(calls.has(call) ? "SIGKILL" : "SIGTERM"); // a background job records its end
          }, opts.timeout * 1000).unref()
        : undefined;
      const onAbort = () => kill("SIGKILL");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const poll = setInterval(pump, 250);
      const auto =
        config.autoBackgroundSeconds > 0
          ? setTimeout(() => call.background("auto"), config.autoBackgroundSeconds * 1000)
          : undefined;
      const stop = () => {
        clearInterval(poll);
        clearTimeout(auto);
        closeSync(input);
        opts.signal?.removeEventListener("abort", onAbort);
        calls.delete(call);
      };
      const call: Call = {
        startedAt: Date.now(),
        abort: onAbort,
        background: (reason) => {
          if (!calls.has(call) || !child.pid) return;
          stop();
          const meta: Meta = {
            pid: child.pid,
            command: shown,
            cwd,
            startedAt: call.startedAt,
            sessionId,
          };
          writeFileSync(file(id, "json"), JSON.stringify(meta));
          writeFileSync(file(id, `watch.${sessionId}`), "");
          seen().add(id);
          child.unref();
          const where = `as pid ${child.pid} (log: ${log})`;
          onBackground(
            (reason === "agent"
              ? `Running in background ${where}.`
              : reason === "user"
                ? `The user moved this command to the background while it ran. It keeps running ${where}; its output so far is in the log.`
                : `Still running after ${config.autoBackgroundSeconds}s, so it moved to the background automatically. It keeps running ${where}; its output so far is in the log.`) +
              " You'll be notified when it exits; don't wait, sleep or poll on it.",
          );
          resolve({ exitCode: 0 });
          refresh();
        },
      };
      calls.add(call);
      const forget = () => {
        for (const ext of ["log", "exit"])
          try {
            unlinkSync(file(id, ext));
          } catch {}
      };
      child.on("error", (err) => {
        if (!calls.has(call)) return;
        stop();
        clearTimeout(timer);
        forget();
        reject(err);
      });
      child.on("exit", (code, sig) => {
        clearTimeout(timer);
        if (!calls.has(call)) return g.poke?.(); // a background job: whichever runtime is live checks
        pump();
        // Part of the output, so it survives truncation and stays ahead of pi's status line.
        if (tip) opts.onData(Buffer.from(`\n${SLEEP_TIP}`));
        stop();
        forget();
        if (opts.signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${opts.timeout}`));
        else resolve({ exitCode: code ?? 128 + (sig ? (constants.signals[sig] ?? 0) : 0) });
      });
      if (background) call.background("agent");
    });

  const base = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...base,
    description: `${base.description} Set background: true to run it in the background: it returns right away with the pid and log path, and you are notified when it exits.`,
    // One grouped rule, so the system prompt's rules read as sections (pi-herd's "Agents" too).
    promptGuidelines: [
      ...(base.promptGuidelines ?? []),
      [
        "Background bash (bash, bash_list, bash_watch):",
        "    - Run servers, watchers, long builds, or anything that takes a while with bash `background: true`. Never use `&`.",
        ...(config.autoBackgroundSeconds > 0
          ? [
              `    - Bash calls still running after ${config.autoBackgroundSeconds}s move to the background automatically.`,
            ]
          : []),
        "    - You are notified when a background job exits: don't sleep, poll or wait on it.",
        "    - Stop a background job with `kill <pid>`; bash_list lists them.",
      ].join("\n"),
    ],
    parameters: Type.Object({
      ...base.parameters.properties,
      background: Type.Optional(
        Type.Boolean({
          description:
            "Run in the background and return right away; you are notified when it exits",
        }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, c) {
      const { command, timeout, background } = params;
      let moved: string | undefined;
      const tip = [...command.matchAll(/\bsleep\s+(\d+)/g)].some((m) => Number(m[1]) >= 5);
      const tool = createBashToolDefinition(c.cwd, {
        commandPrefix: settings?.getShellCommandPrefix(),
        operations: {
          exec: (cmd, cwd, opts) =>
            run(cmd, cwd, opts, command, background === true, tip, (text) => (moved = text)),
        },
      });
      const started = Date.now();
      const result = await tool.execute(toolCallId, { command, timeout }, signal, onUpdate, c);
      // How long the call held the turn (until it ended or moved to the background). pi saves a
      // batch of parallel results together, so this is the only exact duration for history.
      const durationMs = Date.now() - started;
      return moved
        ? { content: [{ type: "text", text: moved }], details: { durationMs } }
        : { ...result, details: { ...result.details, durationMs } };
    },
  });

  const jobLine = (j: Job) =>
    `${j.pid}  ${state(j).padEnd(7)}  ${elapsed(j).padEnd(6)}  ${oneLine(j.command)}  ${tilde(j.cwd)}  log: ${j.log}`;

  pi.registerTool({
    name: "bash_list",
    label: "bash list",
    description:
      "List background bash jobs, newest first: pid, state, elapsed time, command, cwd, log path.",
    promptSnippet: "List background bash jobs",
    parameters: Type.Object({
      jobs: Type.Optional(
        StringEnum(["watching", "all"], {
          description:
            '"watching" (default): jobs this session gets end messages for. "all": every background job.',
        }),
      ),
      status: Type.Optional(
        StringEnum(["running", "finished", "any"], { description: 'Default "any"' }),
      ),
    }),
    async execute(_id, { jobs: which = "watching", status = "any" }) {
      const list = find(which as Scope, status as Status);
      const lines = list.slice(0, 100).map(jobLine);
      if (list.length > 100)
        lines.push(
          `Showing 100 of ${list.length}. All jobs are in ${tilde(DIR)}/ (<id>.json has pid and command).`,
        );
      return {
        content: [{ type: "text", text: lines.join("\n") || "No matching background jobs." }],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "bash_watch",
    label: "bash watch",
    description:
      "Get the end message of a background bash job started elsewhere (another session). Returns right away; if the job already ended, returns its result.",
    promptSnippet: "Watch a background bash job from another session",
    parameters: Type.Object({ pid: Type.Number({ description: "The job's pid" }) }),
    async execute(_id, { pid }) {
      const j = byPid(pid);
      if (!j)
        throw new Error(
          `pid ${pid} is not a pi-bash-bg background job. See bash_list({ jobs: "all" }).`,
        );
      writeFileSync(file(j.id, `watch.${sessionId}`), "");
      if (j.code === undefined) seen().add(j.id);
      const text =
        j.code === undefined
          ? `Watching pid ${pid}. You'll be notified when it exits; don't wait, sleep or poll on it.`
          : endText(ending(j, limits()));
      refresh();
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  // Collapsed like pi's compaction message, in at most 4 lines: one per job, its command cut to
  // fit. Expanded, the whole command, then its output.
  pi.registerMessageRenderer<{ jobs: Ending[] }>(TYPE, (message, { expanded }, theme) => {
    const list = message.details?.jobs ?? [];
    const dim = (s: string) => theme.fg("dim", s);
    const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
    const rows = list.map((j) => ({
      icon: stateIcon(theme, j.state),
      command: highlightCode(j.command.trim(), "bash"),
      meta: dim(` · pid ${j.pid} · ${j.state} · ${j.elapsed}`),
      j,
    }));
    if (!expanded) {
      const shown = rows.length > COLLAPSED_LINES ? rows.slice(0, COLLAPSED_LINES - 1) : rows;
      const more = rows.length - shown.length;
      const hint = dim(` (${keyText("app.tools.expand")} to expand)`);
      box.addChild({
        invalidate() {},
        render: (width: number) => {
          const lines = shown.map((r, i) => {
            const tail = r.meta + (!more && i === shown.length - 1 ? hint : "");
            const room = Math.max(1, width - 2 - visibleWidth(tail));
            const cmd = r.command.length > 1 ? `${r.command[0]} …` : r.command[0]!;
            return cut(`${r.icon} ${cut(cmd, room)}${tail}`, width);
          });
          if (more) lines.push(cut(dim(`+${more} more`) + hint, width));
          return lines;
        },
      });
      return box;
    }
    // Like pi-content-layout's open bash row: a command on more than one line continues under
    // a │ and gets a │ line before its output, which hangs off a └. Kept per width: pi renders
    // the whole chat on every frame in full screen, and the output can run to a thousand lines.
    let last: { width: number; lines: string[] } | undefined;
    box.addChild({
      invalidate: () => (last = undefined),
      render: (width: number) => {
        if (last?.width === width) return last.lines;
        const fit = Math.max(1, width - 2);
        const lines: string[] = [];
        for (const { icon, command, meta, j } of rows) {
          const cmd = [...command.slice(0, -1), command.at(-1) + meta].flatMap((l) =>
            wrapTextWithAnsi(l, fit),
          );
          lines.push(...cmd.map((l, i) => `${i ? dim("│") : icon} ${l}`));
          if (cmd.length > 1) lines.push(dim("│"));
          const out = [j.output?.trim() && j.output, j.note].filter(Boolean).join("\n");
          const outLines = (out ? out.split("\n") : ["(no output)"]).flatMap((l) =>
            wrapTextWithAnsi(theme.fg(out ? "toolOutput" : "dim", l), fit),
          );
          lines.push(...outLines.map((l, i) => `${i ? " " : dim("└")} ${l}`), "");
        }
        lines.pop();
        last = { width, lines };
        return lines;
      },
    });
    return box;
  });

  // /background list: printed like /hotkeys, never sent to the model, gone after a reload. A
  // bullet per job, newest first: state, pid, start time, how long, cwd, and (listing all jobs)
  // whether this session watches it; its log dim under it. Commands stay out: they're long.
  type Row = {
    pid: number;
    state: string;
    startedAt: number;
    elapsed: string;
    cwd: string;
    log: string;
    watching?: boolean;
  };
  const clock = (ms: number) => {
    const d = new Date(ms);
    const time = d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return d.toDateString() === new Date().toDateString()
      ? time
      : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  };
  const loadedAt = Date.now();
  pi.registerEntryRenderer<{ title: string; jobs: Row[]; more: number }>(
    "bash-bg-list",
    (entry, _o, theme) => {
      if (Date.parse(entry.timestamp) < loadedAt) return undefined;
      const { title, jobs: rows = [], more = 0 } = entry.data!;
      const dim = (s: string) => theme.fg("dim", s);
      const lines = rows.flatMap((j) => [
        `${dim("•")} ${stateIcon(theme, j.state)} ${theme.fg("accent", String(j.pid))} ` +
          theme.fg(
            "text",
            `· ${clock(j.startedAt)} · ${j.state} · ${j.elapsed} · ${tilde(j.cwd)}`,
          ) +
          (j.watching ? ` ${theme.fg("accent", "· watching")}` : ""),
        dim(`    ${tilde(j.log)}`),
      ]);
      if (more) lines.push(dim(`+${more} more in ${tilde(DIR)}/`));
      const box = new Container();
      box.addChild(new DynamicBorder());
      box.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
      box.addChild(new Spacer(1));
      box.addChild(new Text(lines.join("\n") || dim("No matching background jobs."), 1, 0));
      box.addChild(new DynamicBorder());
      return box;
    },
  );

  const moveAll = () => {
    if (!calls.size)
      return ctx?.ui.notify("No running bash call to move to the background.", "info");
    for (const call of calls) call.background("user");
  };
  const kill = (j: Job) => {
    if (j.code !== undefined || !terminate(j))
      return ctx?.ui.notify(`pid ${j.pid} is not running.`, "warning");
    ctx?.ui.notify(`Killed pid ${j.pid}.`, "info");
  };
  const openLogs = async (j: Job) => {
    if (ctx?.mode !== "tui") return;
    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) =>
        new LogViewer(
          tui,
          theme,
          j.log,
          () => {
            const now = job(j.id) ?? j;
            return {
              pid: now.pid,
              command: now.command,
              detail: `${state(now)} · ${elapsed(now)} · ${tilde(now.cwd)}`,
              running: now.code === undefined,
            };
          },
          () => kill(job(j.id) ?? j),
          () => done(),
        ),
      FULL_SCREEN,
    );
  };
  const pick = async (title: string, list: Job[]) => {
    if (!list.length) return ctx?.ui.notify("No background jobs.", "info");
    const choice = await ctx?.ui.select(title, list.map(jobLine));
    return list.find((j) => choice?.startsWith(`${j.pid} `));
  };

  pi.registerCommand("background", {
    description: "Move running bash calls to the background, or list, view, and kill jobs",
    getArgumentCompletions: (prefix) => {
      const [sub = "", arg, ...more] = prefix.split(/\s+/);
      if (arg === undefined)
        return ["list", "logs", "kill"]
          .filter((s) => s.startsWith(sub))
          .map((s) => ({ value: s, label: s }));
      if (sub === "list") {
        // First param: whose jobs; second: their state.
        if (more.length > 1) return null;
        const [head, last, options] = more.length
          ? [`list ${arg}`, more[0]!, ["running", "finished", "any"]]
          : ["list", arg, ["watching", "all"]];
        const items = options.filter((o) => o.startsWith(last));
        return items.length ? items.map((o) => ({ value: `${head} ${o}`, label: o })) : null;
      }
      const items =
        sub === "logs" || sub === "kill"
          ? listed()
              .filter((j) => sub === "logs" || j.code === undefined)
              .map((j) => ({
                value: `${sub} ${j.pid}`,
                label: String(j.pid),
                description: oneLine(j.command),
              }))
              .concat(
                sub === "kill"
                  ? [{ value: "kill all", label: "all", description: "this session's jobs" }]
                  : [],
              )
          : [];
      const matching = items.filter((i) => i.label.startsWith(arg));
      return matching.length ? matching : null;
    },
    handler: async (args, c) => {
      const [sub = "", arg = "", arg2 = ""] = args.trim().split(/\s+/);
      if (!sub) return moveAll();
      if (sub === "list") {
        // bash_list's two params, in order: jobs (watching | all), status (running | finished |
        // any). Defaults: watching, running.
        const which: Scope = arg === "all" ? "all" : "watching";
        const status: Status = arg2 === "finished" || arg2 === "any" ? arg2 : "running";
        const list = find(which, status);
        const scope = which === "all" ? "all sessions" : "this session";
        const watched = which === "all" ? watchedIds() : [];
        return pi.appendEntry("bash-bg-list", {
          title: `Background jobs · ${status === "any" ? "all" : status} · ${scope}`,
          jobs: list.slice(0, 100).map((j) => ({
            pid: j.pid,
            state: state(j),
            startedAt: j.startedAt,
            watching: watched.includes(j.id),
            elapsed: elapsed(j),
            cwd: j.cwd,
            log: j.log,
          })),
          more: Math.max(0, list.length - 100),
        });
      }
      if (sub === "logs") {
        const j = arg ? byPid(Number(arg)) : await pick("Open logs", listed());
        if (arg && !j) return c.ui.notify(`pid ${arg} is not a background job.`, "warning");
        if (j) await openLogs(j);
        return;
      }
      if (sub === "kill" && arg === "all") {
        const n = running(jobs(watchedIds())).filter(terminate).length;
        return c.ui.notify(`Killed ${n} background job${n === 1 ? "" : "s"}.`, "info");
      }
      if (sub === "kill") {
        const j = byPid(Number(arg));
        return j ? kill(j) : c.ui.notify(`pid ${arg} is not a background job.`, "warning");
      }
      c.ui.notify(
        "Usage: /background [list [watching|all] [running|finished|any] | logs [pid] | kill <pid|all>]",
        "warning",
      );
    },
  });
  pi.registerShortcut(config.shortcut as KeyId, {
    description: "Move running bash calls to the background",
    handler: () => moveAll(),
  });

  // From pi-footer's jobs tab.
  pi.events.on("bash-bg:kill", (data) => {
    const j = byPid((data as { pid: number }).pid);
    if (j) kill(j);
  });
  pi.events.on("bash-bg:logs", (data) => {
    const j = byPid((data as { pid: number }).pid);
    if (j) void openLogs(j);
  });

  pi.on("session_start", (event, c) => {
    ctx = c;
    sessionId = c.sessionManager.getSessionId();
    settings = SettingsManager.create(c.cwd);
    lastUpdate = "";
    // Only jobs running now can send an end message; a /reload keeps the list, so jobs that ended
    // during it still do.
    if (event.reason !== "reload" || g.seen?.sessionId !== sessionId)
      g.seen = {
        sessionId,
        ids: new Set(running(jobs(watchedIds())).map((j) => j.id)),
      };
    g.poke = () => {
      clearTimeout(pokeTimer);
      pokeTimer = setTimeout(check, 250); // jobs ending together share a message
    };
    // Only while a watched job runs: otherwise nothing can change.
    tick = setInterval(() => seen().size && check(), 1000);
    g.herdr = undefined; // refresh() below emits the current value
    check();
    if (!g.cleaned) {
      g.cleaned = true;
      void cleanup();
    }
  });

  pi.on("agent_start", () => {
    busy = true;
    clearTimeout(waking);
    waking = undefined;
    refresh();
  });
  pi.on("agent_settled", () => {
    busy = false;
    refresh();
  });

  // Print and json modes end when the agent settles: wait for watched jobs, then continue with
  // their end messages so `pi -p` ends with the results.
  pi.on("agent_before_settle", async (_event, c) => {
    const waiting = () => running(jobs([...seen()])).length > 0;
    if (c.mode === "tui" || c.mode === "rpc" || !waiting()) return;
    settling = [];
    while (waiting()) await new Promise((r) => setTimeout(r, 250));
    check();
    const entries = settling;
    settling = undefined;
    return { entries, continue: true };
  });

  pi.on("session_shutdown", (event, c) => {
    clearInterval(tick);
    clearTimeout(pokeTimer);
    clearTimeout(waking);
    waking = undefined;
    g.poke = undefined;
    for (const call of calls) call.abort(); // foreground calls end with the session
    const mine = running(jobs(watchedIds()));
    if (event.reason !== "reload" && !config.keepOnExit) mine.forEach((j) => terminate(j));
    // pi has stopped the TUI by now and prints its resume hint right after this line.
    if (event.reason === "quit" && c.mode === "tui" && mine.length) {
      const n = mine.length;
      process.stdout.write(
        `pi-bash-bg: ${n} background job${n === 1 ? "" : "s"} ${config.keepOnExit ? "still running" : n === 1 ? "was killed" : "were killed"} (pid${n === 1 ? "" : "s"} ${mine.map((j) => j.pid).join(", ")}). Logs: ${tilde(DIR)}\n`,
      );
    }
    ctx = undefined;
  });
}
