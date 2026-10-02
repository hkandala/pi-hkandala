/**
 * pi-footer: a one-line footer inside a rounded prompt box (box.ts) that expands into a dashboard
 * of tabs (tabs.ts) below it. The numbers come from the session (stats.ts) and git (git.ts), the
 * agents and jobs from pi-herd and pi-bash-bg events. See README.md.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  BoxEditor,
  editorUnfocused,
  findEditor,
  type MouseEvent,
  type Node,
  pinBorderColor,
  promptAtEnd,
} from "./box.ts";
import { EMPTY_GIT, type Git, git, readGit } from "./git.ts";
import {
  type CacheModel,
  cacheState,
  contextUsage,
  noteFirstToken,
  perLeaf,
  sessionStats,
  type Stats,
} from "./stats.ts";
import { cut, type Sel, type Tab, Tabs, move } from "./tabs.ts";

const ICON = {
  folder: "\u{f024b}", // 󰉋 md-folder
  repo: "\u{f02a2}", // 󰊢 md-git
  worktree: "\u{f0645}", // 󰙅 md-file-tree
  branch: "\u{f062c}", // 󰘬 md-source-branch
  ahead: "\u{f005d}", // 󰁝 md-arrow-up-bold (commits to push)
  behind: "\u{f0045}", // 󰁅 md-arrow-down-bold (commits to pull)
  agents: "\u{f0ae3}", // 󰫣 md-star_four_points_outline (pi-herd agents watched)
  jobs: "\u{f0996}", // 󰦖 md-progress-clock (pi-bash-bg jobs running)
  sent: "\u{f1271}", // 󱉱 md-inbox-arrow-up-outline (messages sent to an agent)
  received: "\u{f1270}", // 󱉰 md-inbox-arrow-down-outline (messages received from it)
  watching: "\u{f0150}", // 󰅐 md-clock-outline (this session waits on the agent)
  other: "\u{f15a1}", // 󱖡 md-handshake-outline (an agent this session didn't start)
};
// Context pie in eighths: md-circle_outline, then md-circle_slice_1..8. Nerd Font glyphs, so they
// match in size (Unicode's ○ ◔ ◑ ◕ ● mix fonts).
const PIE = [
  "\u{f0766}",
  ...Array.from({ length: 8 }, (_, i) => String.fromCodePoint(0xf0a9e + i)),
];
const MARGIN = 3; // the dashboard's and statuses' right margin, like the box's and the transcript's
const CUBE = [0, 95, 135, 175, 215, 255]; // the xterm 256-color cube's levels
// Tools that never change the work tree: no git refresh after them.
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

type Color = Parameters<Theme["fg"]>[0];
type Paint = (color: Color, s: string) => string;
type Config = {
  promptEditor?: "box" | "default";
  disableEffortColors?: boolean;
  style?: "color" | "white";
  iconColor?: string;
  gitStatusPollMins?: number;
  gitFetchPollMins?: number;
};
/** A job from pi-bash-bg's bash-bg:update event. */
type Job = {
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  state: string;
};
/**
 * An agent from pi-herd's herd:update event: this session's children and the agents it watched,
 * and below them the agents they started.
 */
type Agent = {
  id: string;
  name: string;
  state: string;
  since: number;
  cwd: string;
  parent?: string;
  mine: boolean; // started by this session, at any depth: it can stop it
  watched: boolean;
  sent: number;
  received: number;
  live: boolean; // false: it ended this session (state stopped or exited)
};
/** A list tab's rows (live ones, then ended ones while `e` shows them) and its selection. */
type Ended<T> = Sel & {
  live: T[];
  ended: T[];
  showEnded: boolean;
  list: T[];
  armed: boolean; // x pressed once
};
/** This session's pi-bash-bg jobs. */
type Bg = Ended<Job> & { running: number };
/**
 * pi-herd's top-level agents (not under another listed agent), and how many live agents each has
 * below it.
 */
type Herd = Ended<Agent> & {
  placeholder?: string;
  below: Map<string, number>;
  watching: number;
  subagents: { cost: number; count: number }; // the agents below this one, ended ones too
};

const fmt = (n: number) =>
  n < 1000 ? `${n}` : n < 1e6 ? `${+(n / 1e3).toFixed(1)}k` : `${+(n / 1e6).toFixed(1)}M`;

const duration = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

const tilde = (p: string) =>
  p === homedir() || p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p;

/** Pads `x` with spaces to `w` columns (display width, for the glyphs). */
const pad = (x: string, w: number) => x + " ".repeat(Math.max(0, w - visibleWidth(x)));

/** Line changes: `+42 -7`, either side left out at 0. */
const plusMinus = (paint: Paint, a: number, r: number) =>
  [a ? paint("success", `+${a}`) : "", r ? paint("error", `-${r}`) : ""].filter(Boolean).join(" ");

/** Generic rules: provider/x → x, drop "claude-", drop date suffixes, trailing -4-7 → -4.7. */
const shortModel = (id: string) =>
  id
    .split("/")
    .pop()!
    .replace(/^claude-/, "")
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/-(\d{1,2})-(\d{1,2})$/, "-$1.$2");

function readConfig(): Config {
  try {
    const c = JSON.parse(readFileSync(join(getAgentDir(), "extensions", "pi-footer.json"), "utf8"));
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

/** A poll in minutes as ms; setInterval treats anything over 2^31-1 ms as 1 ms. */
const pollMs = (mins: number | undefined, fallback: number) =>
  Math.min(2 ** 31 - 1, (mins ?? fallback) * 60_000);

/** When the running turn started (agent_start), while one runs. */
let turnStartedAt: number | undefined;

function render(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  theme: Theme,
  config: Config,
  bg: Bg | undefined,
  herd: Herd | undefined,
  branch: string | null,
  g: Git,
  statuses: ReadonlyMap<string, string>,
  width: number,
  withTabs = true, // the prompt box takes just the first line
): Rendered {
  const white = config.style === "white";
  const paint: Paint = (color, s) => theme.fg(white ? "text" : color, s);
  const iconColor = config.iconColor ?? "accent";
  const icon = (s: string) => {
    if (/^#[0-9a-f]{6}$/i.test(iconColor) && !white) {
      const rgb = [1, 3, 5].map((i) => parseInt(iconColor.slice(i, i + 2), 16));
      // Like pi's theme colors: 24-bit, or the nearest 256-color cube entry.
      const nearest = (v: number) =>
        CUBE.reduce((best, c, i) => (Math.abs(v - c) < Math.abs(v - CUBE[best]!) ? i : best), 0);
      const [r, gr, b] = rgb.map(nearest) as [number, number, number];
      const code =
        theme.getColorMode?.() !== "256color"
          ? `38;2;${rgb.join(";")}`
          : `38;5;${16 + 36 * r + 6 * gr + b}`;
      return `\x1b[${code}m${s}\x1b[39m`;
    }
    try {
      return paint(iconColor as Color, s);
    } catch {
      return paint("accent", s); // unknown theme color name
    }
  };
  const dim = (s: string) => paint("dim", s);
  const dot = dim(" · ");
  const s = sessionStats(ctx);
  const folder = basename(ctx.cwd);

  // Collapsed line pieces.
  let gitPiece: string | undefined;
  if (branch) {
    const repoName = g.repo?.split("/").pop();
    const repo =
      g.worktree || (repoName && repoName !== folder)
        ? `${icon(g.worktree ? ICON.worktree : ICON.repo)} ${paint("text", repoName ?? "")}${dot}`
        : "";
    const sync = [
      g.ahead ? `${ICON.ahead}${g.ahead}` : "",
      g.behind ? `${ICON.behind}${g.behind}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const diff = plusMinus(paint, g.added, g.removed);
    gitPiece =
      `${repo}${icon(ICON.branch)} ${paint("text", branch)}` +
      (sync ? ` ${dim(sync)}` : "") +
      (diff ? dot + diff : "");
  }
  const model = ctx.model;
  const cacheModel = (model ?? {}) as CacheModel;
  const ctxUsage = contextUsage(ctx);
  const approx = ctxUsage?.estimated ? "~" : "";
  // Only a cold cache shows: "cold (~$0.46)", what the next message costs over a warm cache.
  const { cold } = cacheState(ctx, s);
  const coldExtra =
    ((ctxUsage?.tokens ?? 0) *
      ((cacheModel.cost?.cacheWrite ?? 0) - (cacheModel.cost?.cacheRead ?? 0))) /
    1e6;
  const coldPiece = cold
    ? paint("warning", "cold") +
      (coldExtra >= 0.01 ? paint("text", ` (~$${coldExtra.toFixed(2)})`) : "")
    : undefined;
  const pct = ctxUsage?.percent ?? 0;
  const window = ctxUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const ctxColor: Color = pct > 90 ? "error" : pct > 75 ? "warning" : "text";
  const contextPiece = ctxUsage?.tokens
    ? paint(
        ctxColor,
        `${PIE[Math.min(8, Math.round(pct / 12.5))]} ${approx}${fmt(ctxUsage.tokens)}/${fmt(window)}`,
      )
    : undefined;
  const level = pi.getThinkingLevel();
  const levelColor: Color =
    config.disableEffortColors === false
      ? (`thinking${level[0].toUpperCase()}${level.slice(1)}` as Color)
      : "text";
  const modelPiece =
    (model ? paint("text", shortModel(model.id)) : dim("no model")) +
    (model?.reasoning ? dot + paint(levelColor, level) : "");

  const agentsPiece = herd?.watching
    ? `${icon(ICON.agents)} ${paint("text", String(herd.watching))}`
    : undefined;
  const jobsPiece = bg?.running
    ? `${icon(ICON.jobs)} ${paint("text", String(bg.running))}`
    : undefined;

  // Left: folder and git. Right: cold, agents, jobs, context, model. Drop whole sections until the
  // line fits: git, then context; folder, cold, agents, jobs and model always stay.
  const groups = (gs: (string | undefined)[]) => gs.filter(Boolean).join(dot);
  let left = "";
  let right: (string | undefined)[] = [];
  for (const drop of [[], ["git"], ["git", "context"]]) {
    left = groups([
      `${icon(ICON.folder)} ${paint("text", folder)}`,
      drop.includes("git") ? undefined : gitPiece,
    ]);
    right = [
      coldPiece,
      agentsPiece,
      jobsPiece,
      drop.includes("context") ? undefined : contextPiece,
      modelPiece,
    ];
    if (visibleWidth(left) + 2 + visibleWidth(groups(right)) <= width) break;
  }
  const rightText = groups(right);
  left = cut(left, Math.max(8, width - visibleWidth(rightText) - 2));
  const gap = Math.max(2, width - visibleWidth(left + rightText));
  // Clicks open the matching tab: folder and git → git, cold and context → usage, agents → agents,
  // jobs → jobs, model and effort → session.
  const spans: Span[] = [{ x0: 0, x1: visibleWidth(left), tab: "git" }];
  const tabOf = ["usage", "agents", "jobs", "usage", "session"];
  let x = visibleWidth(left) + gap;
  right.forEach((piece, i) => {
    if (!piece) return;
    spans.push({ x0: x, x1: (x += visibleWidth(piece)), tab: tabOf[i]! });
    x += visibleWidth(dot);
  });
  const lines = [cut(left + " ".repeat(gap) + rightText, width)];

  if (statuses.size) {
    const line = [...statuses.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => text.replace(/[\r\n\t]+/g, " "))
      .join(dot);
    const room = Math.max(1, width - MARGIN);
    const w = visibleWidth(line);
    lines.push(cut(w < room ? " ".repeat(room - w) + line : line, room));
  }
  return {
    lines,
    spans,
    paint,
    tabs: withTabs ? tabData(pi, ctx, paint, bg, herd, branch, g, s, width - MARGIN) : [],
  };
}

/** A piece of the footer line (its columns) and the dashboard tab a click on it opens. */
type Span = { x0: number; x1: number; tab: string };
/** What the collapsed footer draws, and the dashboard's tabs. */
type Rendered = {
  lines: string[];
  spans: Span[]; // lines[0]'s pieces and the tab each opens
  paint: Paint;
  tabs: Tab[];
};

/** A tab's rows: the running ones, then the ended ones while `e` shows them. */
const rowsOf = <T>(b: Ended<T>) => (b.showEnded ? [...b.live, ...b.ended] : b.live);
/** Selects a job or agent row (and disarms x). */
const select = <T>(b: Ended<T>, i: number) => {
  move(b, i, b.list.length);
  b.armed = false;
};
/** `e` on the agents or jobs tab: shows or hides the ended rows, keeping the selection in range. */
const toggleEnded = <T>(b: Ended<T>) => {
  b.showEnded = !b.showEnded;
  b.list = rowsOf(b);
  select(b, b.selected);
};
const endedHint = <T>(b: Ended<T>) =>
  b.ended.length ? (b.showEnded ? "e hide ended" : `e show ended (${b.ended.length})`) : "";
const hint = (parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" · ");
/**
 * A list tab's own keys: enter (and a click on the selected row) runs `open`; x twice runs `stop`
 * where `canStop`; e shows or hides ended rows; any other key disarms x.
 */
const listKeys = <T>(
  b: Ended<T>,
  open: (x: T) => void,
  canStop: (x: T) => boolean,
  stop: (x: T) => void,
) => ({
  onKey: (data: string, i: number) => {
    const x = b.list[i];
    if (matchesKey(data, "e") && (b.ended.length || b.showEnded)) toggleEnded(b);
    else if (x === undefined) return false;
    else if (matchesKey(data, Key.enter)) open(x);
    else if (matchesKey(data, "x") && canStop(x)) {
      if (b.armed) stop(x);
      b.armed = !b.armed;
      return true;
    } else return (b.armed = false);
    b.armed = false;
    return true;
  },
  onPick: (i: number) => {
    const x = b.list[i];
    if (x !== undefined) open(x);
  },
});

/**
 * The dashboard's tabs, as data (tabs.ts draws them): overview (a line per area), session, usage
 * (after the first response), git (in a repo), jobs while pi-bash-bg reports any, and agents while
 * pi-herd lists any (last).
 */
function tabData(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  paint: Paint,
  bg: Bg | undefined,
  herd: Herd | undefined,
  branch: string | null,
  g: Git,
  s: Stats,
  width: number,
): Tab[] {
  const dim = (x: string) => paint("dim", x);
  const dot = dim(" · ");
  const val = (x: string) => paint("text", x);
  const LABEL = 11;
  const row = (label: string, value: string) =>
    cut(`   ${paint("muted", label.padEnd(LABEL))}${value}`, width);
  const join = (parts: (string | false | null | undefined | 0)[]) =>
    parts
      .filter(Boolean)
      .map((p) => val(p as string))
      .join(dot);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const model = ctx.model;
  const cacheModel = (model ?? {}) as CacheModel;
  const ctxUsage = contextUsage(ctx);
  const level = pi.getThinkingLevel();
  const context =
    ctxUsage?.tokens &&
    `${ctxUsage.estimated ? "~" : ""}${fmt(ctxUsage.tokens)} / ${fmt(ctxUsage.contextWindow ?? 0)}` +
      (ctxUsage.percent != null ? ` (${Math.round(ctxUsage.percent)}%)` : "");
  const modelName = model && `${model.provider}/${model.id}`;
  const thinking = model?.reasoning && `thinking ${level}`;
  const { cold, expired, ttlMs, cacheAge } = cacheState(ctx, s);
  const cache = s.lastCached
    ? [
        s.cacheHit !== undefined && `${Math.round(s.cacheHit)}% last hit`,
        cold
          ? `cold${expired ? ` · expired ${duration(cacheAge - ttlMs)} ago` : ""}`
          : `expires in ${duration(ttlMs - cacheAge)}`,
      ]
    : [];
  const messages = [
    `${s.userMessages} user`,
    `${s.responses} assistant`,
    plural(s.toolCalls, "tool call"),
  ];
  const upstream = branch && branch + (g.upstream ? ` → ${g.upstream}` : "");
  const files = g.files.length;
  const changes = files
    ? val(plural(files, "file")) + dot + plusMinus(paint, g.added, g.removed)
    : "";

  const overview = [
    branch
      ? row("repo", join([basename(ctx.cwd), upstream]) + (changes && dot + changes))
      : row("path", val(tilde(ctx.cwd))),
  ];
  if (model) overview.push(row("model", join([modelName, thinking, context])));
  // Cost: this session's and its agents' (any depth, ended ones too).
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const subs = herd?.subagents ?? { cost: 0, count: 0 };
  const total = s.cost + subs.cost;
  if (s.responses)
    overview.push(
      row(
        "usage",
        join([`↑${fmt(s.input)} ↓${fmt(s.output)}`, total > 0 && `${usd(total)} total`, ...cache]),
      ),
    );
  overview.push(row("session", join([...messages, `${duration(s.workingMs)} working`])));

  // Git: only in a git repo. The repo's URL and the folder share a line.
  const git: string[] = [];
  if (branch) {
    const where = g.url ?? g.repo;
    git.push(
      row("repo", where ? `${val(where)} ${dim(`(${tilde(ctx.cwd)})`)}` : val(tilde(ctx.cwd))),
    );
    if (g.worktrees.length > 1) {
      const label = (w: string) => (w === g.worktrees[0] ? `${w} (main)` : w);
      const others = g.worktrees.filter((w) => w !== g.current).map(label);
      git.push(
        row(
          "worktree",
          join([label(g.current), `${plural(others.length, "other")}: ${others.join(", ")}`]),
        ),
      );
    }
    const sync = !g.current
      ? [] // git not read (untrusted project)
      : !g.upstream
        ? ["no upstream"]
        : [
            g.ahead && `${g.ahead} to push`,
            g.behind && `${g.behind} to pull`,
            !g.ahead && !g.behind && "up to date",
            g.fetchedAt ? `fetched ${duration(Date.now() - g.fetchedAt)} ago` : "never fetched",
          ];
    git.push(row("branch", join([upstream, ...sync])));
    if (g.commit) git.push(row("commit", join([g.commit, g.commitAge])));
    if (files) {
      // A = added, ? = untracked (both new), D = deleted, anything else was modified.
      const count = (test: (st: string) => boolean) => g.files.filter((f) => test(f.status)).length;
      const created = count((st) => st === "A" || st === "?");
      const deleted = count((st) => st === "D");
      git.push(
        row(
          "changes",
          join([
            plural(files, "file"),
            [
              created && `${created} created`,
              files - created - deleted && `${files - created - deleted} modified`,
              deleted && `${deleted} deleted`,
            ]
              .filter(Boolean)
              .join(", "),
          ]) +
            dot +
            plusMinus(paint, g.added, g.removed),
        ),
      );
    }
  }

  // Session: model, messages, time, speed. Usage (after the first response): context, tokens, cost,
  // cache.
  const session: string[] = [];
  if (model) session.push(row("model", join([modelName, thinking])));
  session.push(row("messages", join(messages)));
  if (s.startedAt)
    session.push(
      row(
        "time",
        join([
          turnStartedAt
            ? `${duration(Date.now() - turnStartedAt)} this turn`
            : s.lastTurnMs && `${duration(s.lastTurnMs)} last turn`,
          `${duration(s.workingMs)} working`,
          `${duration(Date.now() - s.startedAt)} since start`,
        ]),
      ),
    );
  session.push(
    row(
      "speed",
      s.lastTtft === undefined
        ? val("n/a")
        : join([
            s.lastSpeed !== undefined && `${Math.round(s.lastSpeed)} t/s last`,
            s.lastSpeed !== undefined &&
              `${Math.round(s.streamOutput / (s.streamMs / 1000))} t/s avg`,
            `${(s.lastTtft / 1000).toFixed(1)}s ttft last`,
            `${(s.ttftMs / s.ttftCount / 1000).toFixed(1)}s ttft avg`,
          ]),
    ),
  );

  const usage: string[] = [];
  if (context)
    usage.push(row("context", join([context, s.compactions && `compacted ${s.compactions}×`])));
  if (s.responses)
    usage.push(
      row(
        "tokens",
        join([
          `↑${fmt(s.input)} input`,
          `↓${fmt(s.output)} output`,
          `cache ${fmt(s.cacheRead)} read, ${fmt(s.cacheWrite)} write`,
        ]),
      ),
    );
  // Cost: the total, this session's and its agents' when it has any, then the running or last turn's.
  if (total > 0)
    usage.push(
      row(
        "cost",
        join([
          `${usd(total)} total`,
          subs.count > 0 && `${usd(s.cost)} session`,
          subs.count > 0 && `${usd(subs.cost)} subagents (${subs.count})`,
          `${usd(s.turnCost)} ${turnStartedAt ? "this" : "last"} turn`,
        ]),
      ),
    );
  if (s.lastCached) {
    const price = cold ? cacheModel.cost?.cacheWrite : cacheModel.cost?.cacheRead;
    const next = ((ctxUsage?.tokens ?? 0) * (price ?? 0)) / 1e6;
    usage.push(row("cache", join([...cache, next >= 0.01 && `next message ~$${next.toFixed(2)}`])));
  }

  const tabs: (Tab | undefined)[] = [
    { id: "overview", label: "overview", lines: overview },
    { id: "session", label: "session", lines: session },
    s.responses || total > 0 ? { id: "usage", label: "usage", lines: usage } : undefined,
    branch ? { id: "git", label: "git", lines: git } : undefined,
    bg && jobsTab(pi, bg, paint, width),
    herd && agentsTab(pi, herd, paint), // always the last tab
  ];
  return tabs.filter((t): t is Tab => !!t);
}

/** The agents tab (with pi-herd): its running agents, and ended ones while `e` shows them. */
function agentsTab(pi: ExtensionAPI, herd: Herd, paint: Paint): Tab | undefined {
  if (!(herd.live.length + herd.ended.length)) return undefined;
  const dim = (x: string) => paint("dim", x);
  const list = herd.list;
  const picked = list[herd.selected];
  // Like the jobs tab: the status colored only while it needs a look, the time dim.
  const stateColor = (st: string): Color =>
    st === "working" ? "accent" : st === "blocked" ? "warning" : "dim";
  const when = (a: Agent) => duration(Date.now() - a.since); // plain, for every status
  // Markers after the name: another session's agent, and this session waits on it.
  const marks = (a: Agent) =>
    [!a.mine && ICON.other, a.watched && ICON.watching].filter(Boolean).join(" ");
  // A live agent's count of live agents below it, dim after its name: `reviewer +2`.
  const below = (a: Agent) => (herd.below.get(a.id) ? `+${herd.below.get(a.id)}` : "");
  const named = (a: Agent) => [cut(a.name, 28), below(a), marks(a)].filter(Boolean).join(" ");
  const counts = (a: Agent) =>
    a.sent + a.received ? `${ICON.sent} ${a.sent} ${ICON.received} ${a.received}` : "";
  // Columns padded to their widest cell (by display width, for the glyphs) among the rows e can
  // show, so e doesn't move them. The status has a fixed width, and the time (it grows) goes last.
  const every = [...herd.live, ...herd.ended];
  const widest = (f: (a: Agent) => string) => Math.max(0, ...every.map((a) => visibleWidth(f(a))));
  const nameW = widest(named);
  const stateW = 7; // working, blocked, unknown, stopped
  const cwdW = Math.min(
    32,
    widest((a) => tilde(a.cwd)),
  );
  const countsW = widest(counts);
  const attach = (a: Agent) => a.live && pi.events.emit("herd:attach", { id: a.id });
  return {
    id: "agents",
    label: herd.watching ? `agents ${herd.watching}` : "agents", // the agents it waits on
    lines: [],
    list: {
      sel: herd,
      length: list.length,
      row: (i, marker) => {
        const a = list[i]!;
        return (
          `   ${marker} ${paint("text", cut(a.name, 28))}` +
          `${dim([below(a), marks(a)].map((x) => x && ` ${x}`).join(""))}` +
          `${pad("", nameW - visibleWidth(named(a)))}  ` +
          `${paint(stateColor(a.state), pad(a.state, stateW))}  ` +
          `${dim(pad(cut(tilde(a.cwd), cwdW), cwdW))}  ` +
          `${countsW ? `${dim(pad(counts(a), countsW))}  ` : ""}${dim(when(a))}`
        );
      },
      keys: hint([
        list.length > 0 && "↑↓ select",
        picked?.live && "enter view",
        picked?.live && picked.mine && "x stop",
        endedHint(herd),
      ]),
      empty: "no running agents",
      note: herd.armed ? paint("warning", `press x again to stop ${picked?.name}`) : undefined,
      // enter opens it in a popup; x twice stops it (started by this session).
      ...listKeys(
        herd,
        attach,
        (a) => a.live && a.mine,
        (a) => pi.events.emit("herd:stop", { id: a.id }),
      ),
    },
  };
}

/** The jobs tab (with pi-bash-bg): its running jobs, and finished ones while `e` shows them. */
function jobsTab(pi: ExtensionAPI, bg: Bg, paint: Paint, width: number): Tab | undefined {
  if (!(bg.live.length + bg.ended.length)) return undefined;
  const dim = (x: string) => paint("dim", x);
  const cmdWidth = Math.max(10, Math.min(40, width - 42));
  // Over every job e can show, so e doesn't move the columns.
  const every = [...bg.live, ...bg.ended];
  const pidW = Math.max(7, ...every.map((j) => String(j.pid).length + 1));
  const cwdW = Math.min(32, Math.max(0, ...every.map((j) => visibleWidth(tilde(j.cwd)))));
  const selected = bg.list[bg.selected];
  return {
    id: "jobs",
    label: bg.running ? `jobs ${bg.running}` : "jobs",
    lines: [],
    list: {
      sel: bg,
      length: bg.list.length,
      row: (i, marker) => {
        const j = bg.list[i]!;
        const color: Color =
          j.state === "running"
            ? "accent"
            : j.state === "exit 0"
              ? "success"
              : j.state === "killed"
                ? "warning"
                : "error";
        // Control characters (a tab, \r, ESC) would move the cursor or restyle the row.
        // oxlint-disable-next-line no-control-regex
        const command = j.command.split("\n")[0]!.replace(/[\x00-\x1f\x7f]/g, " ");
        // The time last (it grows), as on the agents tab.
        return (
          `   ${marker} ${paint("text", String(j.pid).padEnd(pidW))}${paint(color, j.state.padEnd(9))}` +
          `${paint("text", pad(cut(command, cmdWidth), cmdWidth))}  ` +
          `${dim(pad(cut(tilde(j.cwd), cwdW), cwdW))}  ` +
          dim(duration((j.endedAt ?? Date.now()) - j.startedAt))
        );
      },
      keys: hint([
        bg.list.length > 0 && "↑↓ select",
        bg.list.length > 0 && "enter logs",
        selected?.state === "running" && "x kill",
        endedHint(bg),
      ]),
      empty: "no running jobs",
      note: bg.armed ? paint("warning", `press x again to kill ${selected?.pid}`) : undefined,
      // enter opens the log; x twice kills a running one.
      ...listKeys(
        bg,
        (j) => pi.events.emit("bash-bg:logs", { pid: j.pid }),
        (j) => j.state === "running",
        (j) => pi.events.emit("bash-bg:kill", { pid: j.pid }),
      ),
    },
  };
}

export default function (pi: ExtensionAPI) {
  const config = readConfig();
  const statusPollMs = pollMs(config.gitStatusPollMins, 0.5);
  const fetchPollMs = pollMs(config.gitFetchPollMins, 30);

  let g: Git = EMPTY_GIT;
  const tabs = new Tabs(); // the dashboard: open, focus, active tab
  let shown: Tab[] = []; // the tabs as last rendered, for keys and clicks
  let bg: Bg | undefined;
  let herd: Herd | undefined;
  // Watches or running jobs: open on their tab.
  tabs.pick = () => (herd?.watching ? "agents" : bg?.running ? "jobs" : undefined);
  let footerRow = -1; // the footer line's row in the footer component (-1: in the prompt box)
  let dashRow = 0; // the dashboard's first row there
  let spans: Span[] = []; // the footer line's pieces
  let requestRender = () => {};
  let timers: ReturnType<typeof setInterval>[] = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let again = false;
  let session: ExtensionContext | undefined;
  // Git can run repo hooks, so only in trusted projects (re-checked each time: trust can change).
  const trusted = () => session?.isProjectTrusted() === true;
  // A /name adds an entry, so the leaf moves: read once per leaf, not on every frame.
  const sessionName = perLeaf(() => pi.getSessionName());

  const refresh = async (): Promise<void> => {
    if (!session || !trusted()) return;
    if (busy) {
      again = true; // something changed mid-refresh: run once more afterwards
      return;
    }
    busy = true;
    try {
      g = await readGit(session.cwd);
      requestRender();
    } finally {
      busy = false;
    }
    if (again) {
      again = false;
      return refresh();
    }
  };
  const refreshSoon = () => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 1000);
  };
  const gitFetch = async () => {
    if (!session || !trusted() || !g.upstream) return;
    const cwd = session.cwd;
    // Never prompt for credentials: fail quietly and show an older "fetched" time instead. Batch
    // mode is added to the user's own ssh command, so their keys still apply.
    const ssh =
      process.env.GIT_SSH_COMMAND ||
      (await git(cwd, ["config", "core.sshCommand"])).trim() ||
      "ssh";
    await git(
      cwd,
      ["fetch", "--quiet", "--no-tags"],
      { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes` },
      60_000,
    );
    await refresh();
  };
  let stopInput = () => {};
  const stop = () => {
    stopInput();
    timers.forEach(clearInterval);
    timers = [];
    clearTimeout(debounce);
  };
  const box = config.promptEditor !== "default";
  let footerLine: (width: number) => string = () => "";
  /** A click on the footer line: a piece opens its tab (see render); the rest of the line is inert. */
  const footerClick = (x: number) => {
    const tab = spans.find((sp) => x >= sp.x0 && x < sp.x1)?.tab;
    if (!tab || !shown.some((t) => t.id === tab)) return;
    tabs.show(tab);
    requestRender();
  };
  // ↓ has nothing left to do in the prompt, so it moves on to the dashboard (see promptAtEnd).
  let promptEnd = () => true;
  // An overlay (e.g. pi-bash-bg's log viewer) or a dialog in the editor's place gets its own keys.
  let tuiHasOverlay = () => false;
  // Reopening shows the top: running jobs and watched agents first.
  tabs.onClose = () => {
    if (bg) select(bg, 0);
    if (herd) select(herd, 0);
  };
  /** The selection follows its row (by key) while the tab is open, and starts at the top otherwise. */
  const reselect = <T>(
    old: Ended<T> | undefined,
    next: Ended<T>,
    tab: string,
    key: (x: T) => unknown,
  ) => {
    const open = tabs.expanded && tabs.tab === tab;
    const was = open ? old?.list[old.selected] : undefined;
    const at = was === undefined ? -1 : next.list.findIndex((x) => key(x) === key(was));
    next.top = open ? (old?.top ?? 0) : 0;
    select(next, Math.max(0, at));
    next.armed = !!old?.armed && at >= 0;
    requestRender();
  };

  // pi-herd sends the agents grouped (working, other live, ended). The tab shows the top-level ones
  // (not under another listed agent), each with how many live agents are below it.
  pi.events.on("herd:update", (data) => {
    const u = data as {
      agents: Agent[];
      watching: number;
      placeholder?: string;
      subagents?: { cost: number; count: number };
    };
    if (!Array.isArray(u?.agents)) return; // another pi-herd version
    // Top level: not under another listed agent. Live ones first, then ended (while e shows them).
    const ids = new Set(u.agents.map((a) => a.id));
    const top = u.agents.filter((a) => !(a.parent && ids.has(a.parent)));
    const live = u.agents.filter((a) => a.live);
    const byId = new Map(live.map((a) => [a.id, a]));
    const below = new Map<string, number>();
    for (const a of live)
      for (let p = a.parent, n = 0; p && byId.has(p) && n < 100; p = byId.get(p)!.parent, n++)
        below.set(p, (below.get(p) ?? 0) + 1);
    const next: Herd = {
      // A live agent whose listed parent ended is top-level too, until it ends with it.
      live: live.filter((a) => !(a.parent && byId.has(a.parent))),
      ended: top.filter((a) => !a.live),
      showEnded: herd?.showEnded ?? false,
      list: [],
      below,
      watching: u.watching,
      subagents: u.subagents ?? { cost: 0, count: 0 },
      placeholder: u.placeholder,
      selected: 0,
      top: 0,
      armed: false,
    };
    next.list = rowsOf(next);
    reselect(herd, next, "agents", (a) => a.id);
    herd = next;
  });

  pi.events.on("bash-bg:update", (data) => {
    const u = data as { jobs: Job[]; running: number };
    if (!Array.isArray(u?.jobs)) return; // another pi-bash-bg version
    const next: Bg = {
      // Each group in the order its jobs entered it: started, then ended.
      live: u.jobs.filter((j) => j.state === "running").sort((a, b) => a.startedAt - b.startedAt),
      ended: u.jobs
        .filter((j) => j.state !== "running")
        .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)),
      showEnded: bg?.showEnded ?? false,
      list: [],
      running: u.running,
      selected: 0,
      top: 0,
      armed: false,
    };
    next.list = rowsOf(next);
    reselect(bg, next, "jobs", (j) => j.pid);
    bg = next;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stop();
    session = ctx;
    g = EMPTY_GIT;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      let editor: Node | undefined; // pi's editor (or the box), once found
      let unpin = () => {};
      const unsubscribe = footerData.onBranchChange(refreshSoon);
      promptEnd = () => promptAtEnd(editor, tui);
      tuiHasOverlay = () => tui.hasOverlay() || editorUnfocused(editor);
      const draw = (w: number, withTabs?: boolean) =>
        render(
          pi,
          ctx,
          theme,
          config,
          bg,
          herd,
          footerData.getGitBranch(),
          g,
          footerData.getExtensionStatuses(),
          w,
          withTabs,
        );
      // The box draws the collapsed line at its own width, so its clicks map onto that line.
      footerLine = (w) => {
        const drawn = draw(w, false);
        spans = drawn.spans;
        return drawn.lines[0]!;
      };
      return {
        dispose() {
          unsubscribe();
          unpin();
        },
        invalidate() {},
        // Mouse events only arrive in fullscreen TUI mode. The footer line's pieces (below pi's
        // editor) open their tabs; inside the dashboard, tabs and list rows react.
        handleMouse(event: MouseEvent) {
          if (event.type !== "click" || event.button !== "left") return undefined;
          if (event.y === footerRow) return (footerClick(event.x), { handled: true });
          if (!tabs.expanded || !tabs.click(shown, event.x, event.y - dashRow)) return undefined;
          requestRender();
          return { handled: true };
        },
        render: (width: number) => {
          if (!editor) {
            editor = findEditor(tui);
            if (editor && config.disableEffortColors !== false)
              unpin = pinBorderColor(editor, theme);
          }
          const drawn = draw(width);
          if (!box) spans = drawn.spans;
          shown = drawn.tabs;
          // In box mode the collapsed line lives in the editor; the rest stays down here.
          const lines = box ? drawn.lines.slice(1) : drawn.lines;
          // Keep one blank row between pi's autocomplete list (drawn under the editor) and the
          // footer; the dashboard starts with one of its own.
          const gap = lines[0] && editor?.isShowingAutocomplete?.() ? 1 : 0;
          footerRow = box ? -1 : gap;
          dashRow = gap + lines.length + 1;
          if (tabs.expanded)
            lines.push("", ...tabs.render(shown, width - MARGIN, theme, drawn.paint));
          return gap ? ["", ...lines] : lines;
        },
      };
    });
    if (box)
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) =>
          new BoxEditor(tui, theme, keybindings, {
            footer: (w) => footerLine(w),
            clickFooter: footerClick,
            clickInput: () => {
              tabs.close();
              requestRender();
            },
            footerFocused: () => tabs.focus,
            name: () => sessionName(ctx),
            placeholder: () => herd?.placeholder && ctx.ui.theme.fg("dim", herd.placeholder),
          }),
      );
    if (box) pi.events.emit("footer:box", {}); // pi-herd: its popup hint goes in the placeholder
    // The dashboard's keys (see tabs.ts): ↓ at the end of the prompt opens it.
    stopInput = ctx.ui.onTerminalInput((data) => {
      if (!shown.length || !tabs.input(data, shown, promptEnd, tuiHasOverlay())) {
        if (!tabs.focus) requestRender(); // typing may have handed the keys back
        return undefined;
      }
      requestRender();
      return { consume: true };
    });
    timers.push(setInterval(() => requestRender(), 10_000)); // keeps the cache countdown current
    if (statusPollMs > 0) timers.push(setInterval(refresh, statusPollMs));
    if (fetchPollMs > 0) timers.push(setInterval(gitFetch, fetchPollMs));
    // Not awaited: pi runs session_start handlers one at a time, so the git read would hold up
    // the extensions after this one. Fetch at start when the last fetch is older than the poll.
    void refresh().then(() => {
      if (session === ctx && fetchPollMs > 0 && Date.now() - (g.fetchedAt ?? 0) > fetchPollMs)
        void gitFetch();
    });
  });
  pi.on("session_shutdown", async () => {
    stop();
    session = undefined;
    turnStartedAt = undefined;
  });

  // Anything that may have edited files or moved HEAD.
  pi.on("tool_result", async (event) => {
    if (!READ_ONLY_TOOLS.has(event.toolName)) refreshSoon();
  });
  pi.on("user_bash", async () => refreshSoon());
  pi.on("message_update", async ({ message }) => {
    if (message.role === "assistant") noteFirstToken(message.timestamp);
  });
  pi.on("agent_start", async () => {
    turnStartedAt = Date.now();
  });
  pi.on("agent_end", async () => {
    turnStartedAt = undefined;
    refreshSoon();
  });

  // /footer [tab]: opens at that tab, or like ↓ does; without a tab, it closes an open dashboard.
  pi.registerCommand("footer", {
    description: "Open the footer dashboard, optionally at a tab (↓ at the end of the prompt too)",
    getArgumentCompletions: (prefix) => {
      const items = shown.filter((t) => t.id.startsWith(prefix.trim()));
      return items.length ? items.map((t) => ({ value: t.id, label: t.id })) : null;
    },
    handler: async (args) => {
      const tab = args.trim();
      if (!tab && tabs.expanded) tabs.close();
      else tabs.show(shown.some((t) => t.id === tab) ? tab : (tabs.pick() ?? tabs.tab));
      requestRender();
    },
  });
}
