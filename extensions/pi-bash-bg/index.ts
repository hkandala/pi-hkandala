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
 * The job store is in jobs.ts, the renderers in render.ts, the log viewer in viewer.ts.
 * See docs/SPEC.md for the design.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type CustomMessageEntryDraft,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  getShellConfig,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import {
  byPid,
  cleanup,
  DIR,
  elapsed,
  type Ending,
  endText,
  ending,
  file,
  ids,
  type Job,
  job,
  jobs,
  type Limits,
  type Meta,
  oneLine,
  readJson,
  state,
  terminate,
  tilde,
} from "./jobs.ts";
import { endMessage, listEntry, type Row } from "./render.ts";
import { FULL_SCREEN, LogViewer } from "./viewer.ts";

const TYPE = "background job";
const PUMP_BYTES = 4 * 1024 * 1024; // the most log bytes a call passes on per event-loop turn
const LIST_MAX = 100; // bash_list's and /background list's most rows
// $1 the command, $2 the exit file. `& wait` lets the trap run while the command runs; the trap
// stops the whole group, so plain `kill <pid>` takes `&` grandchildren down too.
const WRAPPER = `trap 'trap - TERM INT HUP; echo 143 > "$2"; kill -TERM 0' TERM INT HUP
(__cmd=$1; set --; eval "$__cmd") & wait $!; c=$?; echo $c > "$2"; exit $c`;
const NOTIFIED = "You'll be notified when it exits; don't wait, sleep or poll on it.";
const SLEEP_TIP =
  "Tip: don't sleep to wait. Run long commands with background: true; you'll be notified when they exit.";

/** Why a call moved to the background: the agent asked, the user did, or it ran too long. */
type Reason = "agent" | "user" | "auto";
type Call = { background: (reason: Reason) => void; abort: () => void };

// Survives /reload: the watched jobs this session has seen running, the last herdr flag, the live
// runtime's check and abort hooks, and whether cleanup already ran in this process.
const g = ((globalThis as { __piBashBg?: unknown }).__piBashBg ??= {}) as {
  seen?: { sessionId: string; ids: Set<string> };
  herdr?: boolean;
  poke?: () => void;
  abortAll?: () => void;
  cleaned?: boolean;
};

export default function (pi: ExtensionAPI) {
  const defaults = { autoBackgroundSeconds: 120, shortcut: "ctrl+shift+b", keepOnExit: true };
  const user = readJson(join(getAgentDir(), "extensions", "pi-bash-bg.json"));
  // A key of the wrong type keeps its default.
  const config = Object.fromEntries(
    Object.entries(defaults).map(([k, v]) => [k, typeof user[k] === typeof v ? user[k] : v]),
  ) as typeof defaults;
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
  const durations = new Map<string, number>(); // failed bash calls' durations, by tool call id
  // pi kills its own bash calls when it exits without a session_shutdown (a crash, a lost
  // terminal); one exit hook per process, for whichever runtime is live.
  if (!g.abortAll) process.on("exit", () => g.abortAll?.());
  g.abortAll = () => calls.forEach((call) => call.abort());

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
  const listed = (watched = watchedIds()) => {
    const mine = new Set(watched);
    return [...jobs(watched), ...running(jobs(ids(".json").filter((id) => !mine.has(id))))];
  };

  // herdr (optional patch, see herdr/README.md at the repo root): working while watched jobs run.
  // Its pane goes idle at once on a working → idle change (the done toast and sound follow later),
  // and an agent watching the pane takes any idle as finished, so it must never see a gap.
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
    // Jobs that ended but whose end message isn't sent yet still count, so there is no gap.
    const pending = Math.max(count, jobs([...seen()]).length);
    const waiting = busy ? 0 : pending;
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
    const active = pending > 0 || !!waking;
    if (active !== g.herdr) emitHerdr(active);
  };

  /** Sends the end message for watched jobs that ended since the last check. */
  const check = () => {
    if (!ctx) return;
    const done: Job[] = [];
    for (const id of seen()) {
      const j = job(id);
      if (j && j.code === undefined) continue;
      seen().delete(id); // ended, or its files were deleted
      if (j) done.push(j);
    }
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
      // pi's own checks: setTimeout fires at once on a negative or too large delay.
      const t = opts.timeout;
      if (t !== undefined && (!Number.isFinite(t) || t <= 0))
        return reject(new Error("Invalid timeout: must be a finite number of seconds"));
      if (t !== undefined && t > 2147483.647)
        return reject(new Error("Invalid timeout: maximum is 2147483.647 seconds"));
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
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      /** Passes new log bytes on, at most PUMP_BYTES a turn; returns whether more are left. */
      const pump = () => {
        for (let sent = 0; sent < PUMP_BYTES; sent += chunk.length) {
          const n = readSync(input, chunk, 0, chunk.length, offset);
          if (n <= 0) return false;
          offset += n;
          opts.onData(Buffer.from(chunk.subarray(0, n))); // a copy: pi keeps the chunks
        }
        return true;
      };
      const signal = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {}
      };
      let timedOut = false;
      const timer = opts.timeout
        ? setTimeout(() => {
            timedOut = true;
            signal(calls.has(call) ? "SIGKILL" : "SIGTERM"); // a background job records its end
          }, opts.timeout * 1000).unref()
        : undefined;
      const onAbort = () => signal("SIGKILL");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const poll = setInterval(pump, 250);
      const auto =
        config.autoBackgroundSeconds > 0
          ? setTimeout(() => call.background("auto"), config.autoBackgroundSeconds * 1000)
          : undefined;
      const stop = () => {
        clearInterval(poll);
        clearTimeout(auto);
        opts.signal?.removeEventListener("abort", onAbort);
        calls.delete(call);
      };
      const startedAt = Date.now();
      const call: Call = {
        abort: onAbort,
        background: (reason) => {
          if (!calls.has(call) || !child.pid) return;
          stop();
          closeSync(input);
          const meta: Meta = { pid: child.pid, command: shown, cwd, startedAt, sessionId };
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
              ` ${NOTIFIED}`,
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
        closeSync(input);
        clearTimeout(timer);
        forget();
        reject(err);
      });
      child.on("exit", (code, sig) => {
        clearTimeout(timer);
        if (!calls.has(call)) return g.poke?.(); // a background job: whichever runtime is live checks
        stop();
        // The rest of the log, a turn at a time, so a big backlog doesn't hold the event loop.
        const finish = () => {
          if (pump()) return void setImmediate(finish);
          closeSync(input);
          // Part of the output, so it survives truncation and stays ahead of pi's status line.
          if (tip) opts.onData(Buffer.from(`\n${SLEEP_TIP}`));
          forget();
          if (opts.signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${opts.timeout}`));
          else resolve({ exitCode: code ?? 128 + (sig ? (constants.signals[sig] ?? 0) : 0) });
        };
        finish();
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
      // How long the call held the turn (until it ended or moved to the background). pi saves a
      // batch of parallel results together, so this is the only exact duration for history.
      const started = Date.now();
      let result;
      try {
        result = await tool.execute(toolCallId, { command, timeout }, signal, onUpdate, c);
      } catch (err) {
        durations.set(toolCallId, Date.now() - started); // added to pi's error result below
        throw err;
      }
      const durationMs = Date.now() - started;
      if (!moved) return { ...result, details: { ...result.details, durationMs } };
      // structuredContent fits bash's outputSchema, so codemode scripts get an object too.
      const structuredContent = {
        output: moved,
        truncated: false,
        exit_code: 0,
        wall_time_seconds: Math.round(durationMs / 100) / 10,
      };
      return {
        content: [{ type: "text", text: moved }],
        details: { durationMs },
        structuredContent,
      };
    },
  });
  // pi turns a thrown error into a result with empty details: the duration goes there.
  pi.on("tool_result", (event) => {
    const durationMs = durations.get(event.toolCallId);
    if (durationMs === undefined) return;
    durations.delete(event.toolCallId);
    return { details: { ...(event.details as object), durationMs } };
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
      const lines = list.slice(0, LIST_MAX).map(jobLine);
      if (list.length > LIST_MAX)
        lines.push(
          `Showing ${LIST_MAX} of ${list.length}. All jobs are in ${tilde(DIR)}/ (<id>.json has pid and command).`,
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
      else seen().delete(j.id); // this answer is its end message
      const text =
        j.code === undefined ? `Watching pid ${pid}. ${NOTIFIED}` : endText(ending(j, limits()));
      refresh();
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  pi.registerMessageRenderer<{ jobs: Ending[] }>(TYPE, endMessage);
  const loadedAt = Date.now();
  pi.registerEntryRenderer<{ title: string; jobs: Row[]; more: number }>(
    "bash-bg-list",
    (entry, _o, theme) => listEntry(entry, theme, loadedAt),
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
          jobs: list.slice(0, LIST_MAX).map((j) => ({
            pid: j.pid,
            state: state(j),
            startedAt: j.startedAt,
            watching: watched.includes(j.id),
            elapsed: elapsed(j),
            cwd: j.cwd,
            log: j.log,
          })),
          more: Math.max(0, list.length - LIST_MAX),
        });
      }
      if (sub === "logs") {
        const tui = c.mode === "tui";
        const j = arg ? byPid(Number(arg)) : tui ? await pick("Open logs", listed()) : undefined;
        if (arg && !j) return c.ui.notify(`pid ${arg} is not a background job.`, "warning");
        if (!tui)
          return c.ui.notify(`The log viewer needs the TUI. Log: ${j?.log ?? `${DIR}/`}`, "info");
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
    // Project settings only when pi trusts the project, as for pi's own bash.
    settings = SettingsManager.create(c.cwd, getAgentDir(), {
      projectTrusted: c.isProjectTrusted(),
    });
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
    refresh();
    // The wake-up ends after every extension's agent_start, so herdr's integration is working
    // first, whichever loaded first.
    setTimeout(() => {
      clearTimeout(waking);
      waking = undefined;
      refresh();
    }, 0);
  });
  pi.on("agent_settled", () => {
    busy = false;
    refresh();
  });

  // Print and json modes end when the agent settles: wait for watched jobs, then continue with
  // their end messages so `pi -p` ends with the results.
  pi.on("agent_before_settle", async (event, c) => {
    const waiting = () => running(jobs([...seen()])).length > 0;
    if (c.mode === "tui" || c.mode === "rpc" || !waiting()) return;
    settling = [];
    while (waiting()) await new Promise((r) => setTimeout(r, 250));
    check();
    const entries = settling;
    settling = undefined;
    return { entries: [...event.entries, ...entries], continue: true };
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
