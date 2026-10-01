/**
 * pi-footer: minimal one-line footer inside a rounded input box; press ↓ at the end of the prompt,
 * run /footer [tab], or click a piece (fullscreen mode) to expand the dashboard below the box.
 *
 *    ╭── ⠋ Working ─────────────────────────────────────────────────────────────────────╮
 *    │ prompt                                                                            │
 *    │                                                                                   │
 *    │  pi-hkandala · 󰘬 master 󰁝2 󰁅1 · +42 -7   cold (~$0.46) · 󰫣 3 · 󰦖 2 · 󰪟 47k/200k · opus-5.5 · high │
 *    ╰───────────────────────────────────────────────────────────────────────────────────╯
 *
 * Right side: cold (only when the prompt cache is cold), the agents pi-herd watches, pi-bash-bg's
 * running jobs, context, model and effort. A click on a piece opens its tab (folder/git → git,
 * cold/context → usage, agents → agents, jobs → jobs, model/effort → session); a click on the
 * prompt's text closes the dashboard. The dashboard has tabs: overview (a line per area), session,
 * usage (after the first prompt), git (in a repo), agents (pi-herd) and jobs (pi-bash-bg). o (or
 * /footer full) opens the full view (full.ts): info, agents and jobs over the whole screen.
 * Narrow terminals drop git, then context. Folder, cold, agents, jobs and model always stay.
 * Config (optional): ~/.pi/agent/extensions/pi-footer.json
 *   { "promptEditor": "box" | "default", "disableEffortColors": true, "style": "color" | "white",
 *     "iconColor": "accent", "gitStatusPollMins": 0.5, "gitFetchPollMins": 30 }
 *   promptEditor "default" keeps pi's editor with the footer below it; disableEffortColors false
 *   lets the prompt border and the footer's level label follow pi's thinking-level colors instead
 *   of staying gray / text;
 *   iconColor: a theme color name or "#rrggbb"; a poll of 0 disables it.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor, estimateTokens, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { EMPTY_GIT, type Git, git, readGit } from "./git.ts";
import { fullView } from "./full.ts";
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
const DEFAULT_CACHE_TTL_S = 300; // pi's own default when a model declares no prompt-cache lifetime

type Color = Parameters<Theme["fg"]>[0];
type Config = {
  promptEditor?: "box" | "default";
  disableEffortColors?: boolean;
  style?: "color" | "white";
  iconColor?: string;
  gitStatusPollMins?: number;
  gitFetchPollMins?: number;
};
type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: {
    total: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};
type Entry = {
  type: string;
  kind?: string; // "cache_warm" on usage entries written by pi's cache warming
  timestamp?: string;
  usage?: Usage;
  message?: {
    role: string;
    usage?: Usage;
    timestamp?: number;
    content?: unknown;
    provider?: string;
    model?: string;
  };
};
type CacheModel = {
  cost?: { cacheRead: number; cacheWrite: number }; // $ per million tokens
  promptCache?: { short?: number; long?: number }; // lifetimes in seconds
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
/** A list's selection, and whether x was pressed once on its row. */
type Picked = Sel & { armed: boolean };
/** This session's pi-bash-bg jobs (all, running first), the running ones, and their selection. */
type Bg = Picked & { all: Job[]; list: Job[]; running: number };
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
  live: boolean; // false: it ended this session (state stopped or done)
};
/** pi-herd's agents (all), the live top-level ones, and their selection. */
type Herd = Picked & { all: Agent[]; list: Agent[]; watching: number };
/** The full view's lists: their selections, and whether `e` shows the ended agents and jobs. */
type Full = {
  rows: number; // body rows on screen
  files: Sel;
  agents: Picked & { showEnded: boolean };
  jobs: Picked & { showEnded: boolean };
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
    return JSON.parse(readFileSync(join(getAgentDir(), "extensions", "pi-footer.json"), "utf8"));
  } catch {
    return {};
  }
}

function sessionStats(ctx: ExtensionContext) {
  const s = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costParts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    turnCost: 0, // since the last user message: the running turn, or the last one
    cacheHit: undefined as number | undefined,
    responses: 0,
    userMessages: 0,
    toolCalls: 0,
    compactions: 0,
    lastSpeed: undefined as number | undefined,
    streamMs: 0,
    streamOutput: 0,
    lastTtft: undefined as number | undefined,
    ttftMs: 0,
    ttftCount: 0,
    workingMs: 0,
    lastTurnMs: 0, // the last run, from its user message to its last entry
    startedAt: undefined as number | undefined,
    cachedAt: undefined as number | undefined, // last response or warm refresh that used the cache
    lastCached: false, // last response read or wrote the prompt cache
    lastModel: undefined as string | undefined, // provider/model of the last response
    compactedSince: false, // compaction after the last response: history no longer matches the cache
  };
  let runStart: number | undefined;
  let runEnd = 0;
  for (const e of ctx.sessionManager.getEntries() as Entry[]) {
    const ts = e.timestamp ? Date.parse(e.timestamp) : undefined;
    if (ts !== undefined) {
      s.startedAt ??= ts;
      // Working time: from each user message to the last entry before the next one.
      if (e.type === "message" && e.message?.role === "user") {
        s.userMessages++;
        s.turnCost = 0;
        if (runStart !== undefined) s.workingMs += runEnd - runStart;
        runStart = runEnd = ts;
      } else if (runStart !== undefined) runEnd = ts;
    }
    if (e.type === "compaction") {
      s.compactions++;
      s.compactedSince = true;
    }
    const usage =
      e.type === "usage"
        ? e.usage
        : e.type === "message" && e.message?.role !== "user"
          ? e.message?.usage
          : undefined;
    if (!usage) continue;
    s.input += usage.input;
    s.output += usage.output;
    s.cacheRead += usage.cacheRead;
    s.cacheWrite += usage.cacheWrite;
    s.cost += usage.cost?.total ?? 0;
    s.turnCost += usage.cost?.total ?? 0;
    for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const)
      s.costParts[k] += usage.cost?.[k] ?? 0;
    if (e.type === "usage" && e.kind === "cache_warm") s.cachedAt = ts ?? s.cachedAt; // refresh extends the cache
    if (e.message?.role !== "assistant") continue;
    s.lastCached = usage.cacheRead + usage.cacheWrite > 0;
    if (s.lastCached) s.cachedAt = ts ?? s.cachedAt;
    s.lastModel = `${e.message.provider}/${e.message.model}`;
    s.compactedSince = false;
    s.responses++;
    if (Array.isArray(e.message.content))
      s.toolCalls += e.message.content.filter((c) => c?.type === "toolCall").length;
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    if (prompt > 0) s.cacheHit = (usage.cacheRead / prompt) * 100;
    // Time to first token, and tokens per second from it to saved (this session's responses only).
    const sent = e.message.timestamp ?? 0;
    const first = firstTokenAt.get(sent);
    if (first === undefined || ts === undefined) continue;
    s.lastTtft = first - sent;
    s.ttftMs += s.lastTtft;
    s.ttftCount++;
    // Output arrives in bursts (a short reply can land in one chunk), so skip sub-second streams.
    const ms = ts - first;
    if (ms >= 1000 && usage.output > 0) {
      s.lastSpeed = usage.output / (ms / 1000);
      s.streamMs += ms;
      s.streamOutput += usage.output;
    }
  }
  if (runStart !== undefined) {
    s.lastTurnMs = runEnd - runStart;
    s.workingMs += s.lastTurnMs;
  }
  return s;
}

// After a compaction pi reports no context tokens until the next response (e.g. a session resumed
// right after an auto-compaction). Estimate them the way pi does (chars / 4, the system message
// including its tools), once per leaf entry.
let estimate: { leaf: string | null; tokens: number } | undefined;
function contextUsage(ctx: ExtensionContext) {
  const usage = ctx.getContextUsage();
  if (usage?.tokens !== null) return usage && { ...usage, estimated: false };
  const leaf = ctx.sessionManager.getLeafId();
  if (estimate?.leaf !== leaf) {
    const { messages } = ctx.sessionManager.buildSessionContext();
    estimate = { leaf, tokens: messages.reduce((n, m) => n + estimateTokens(m), 0) };
  }
  const { tokens } = estimate;
  return { ...usage, tokens, percent: (tokens / usage.contextWindow) * 100, estimated: true };
}

/**
 * Prompt cache: alive for its lifetime after the last cached response (or warm refresh); cold
 * once that passes, the model changed, or the history was compacted: the next message re-bills.
 */
function cacheState(ctx: ExtensionContext, s: ReturnType<typeof sessionStats>) {
  const model = ctx.model;
  const ttlMs =
    ((model as CacheModel | undefined)?.promptCache?.[
      process.env.PI_CACHE_RETENTION === "long" ? "long" : "short"
    ] ?? DEFAULT_CACHE_TTL_S) * 1000;
  const cacheAge = s.cachedAt !== undefined ? Date.now() - s.cachedAt : 0;
  const expired = cacheAge > ttlMs;
  const modelChanged = !!model && !!s.lastModel && s.lastModel !== `${model.provider}/${model.id}`;
  return {
    ttlMs,
    cacheAge,
    expired,
    cold: s.lastCached && (expired || modelChanged || s.compactedSince),
  };
}

/** When the running turn started (agent_start), while one runs. */
let turnStartedAt: number | undefined;
/** First token time by assistant message timestamp (set just before its request). Not saved. */
const firstTokenAt = new Map<number, number>();

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
  full?: Full,
): Rendered {
  const white = config.style === "white";
  const paint = (color: Color, s: string) => theme.fg(white ? "text" : color, s);
  const iconColor = config.iconColor ?? "accent";
  const icon = (s: string) => {
    if (/^#[0-9a-f]{6}$/i.test(iconColor) && !white)
      return `\x1b[38;2;${[1, 3, 5].map((i) => parseInt(iconColor.slice(i, i + 2), 16)).join(";")}m${s}\x1b[39m`;
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
    const diff = [
      g.added ? paint("success", `+${g.added}`) : "",
      g.removed ? paint("error", `-${g.removed}`) : "",
    ].filter(Boolean);
    gitPiece =
      `${repo}${icon(ICON.branch)} ${paint("text", branch)}` +
      (sync ? ` ${dim(sync)}` : "") +
      (diff.length ? dot + diff.join(" ") : "");
  }
  const model = ctx.model;
  const cacheModel = (model ?? {}) as CacheModel;
  const ctxUsage = contextUsage(ctx);
  const approx = ctxUsage?.estimated ? "~" : "";
  // Only a cold cache shows (the next message re-bills the context): "cold (~$0.46)".
  const { cold } = cacheState(ctx, s);
  const coldExtra =
    ((ctxUsage?.tokens ?? 0) *
      ((cacheModel.cost?.cacheWrite ?? 0) - (cacheModel.cost?.cacheRead ?? 0))) /
    1e6;
  const coldPiece = cold
    ? paint("warning", "cold") + (coldExtra >= 0.01 ? dim(` (~$${coldExtra.toFixed(2)})`) : "")
    : undefined;
  const pct = ctxUsage?.percent ?? undefined;
  const window = ctxUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const ctxColor: Color = (pct ?? 0) > 90 ? "error" : (pct ?? 0) > 75 ? "warning" : "dim";
  const contextPiece = ctxUsage?.tokens
    ? paint(
        ctxColor,
        `${PIE[Math.min(8, Math.round((pct ?? 0) / 12.5))]} ${approx}${fmt(ctxUsage.tokens)}/${fmt(window)}`,
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

  const agentsPiece = herd?.watching ? dim(`${ICON.agents} ${herd.watching}`) : undefined;
  const jobsPiece = bg?.running ? dim(`${ICON.jobs} ${bg.running}`) : undefined;

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
  // Clicks open the matching tab: folder and git → git, cold and context → usage, agents → agents,
  // jobs → jobs, model and effort → session.
  const spans: Span[] = [{ x0: 0, x1: visibleWidth(left), tab: "git" }];
  const tabOf = ["usage", "agents", "jobs", "usage", "session"];
  let x = visibleWidth(left) + Math.max(2, width - visibleWidth(left + rightText));
  right.forEach((piece, i) => {
    if (!piece) return;
    spans.push({ x0: x, x1: (x += visibleWidth(piece)), tab: tabOf[i]! });
    x += visibleWidth(dot);
  });
  left += " ".repeat(Math.max(2, width - visibleWidth(left + rightText)));
  const lines = [cut(left + rightText, width)];

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
    tabs: full
      ? tabData(pi, ctx, paint, bg, herd, branch, g, s, width, full)
      : tabData(pi, ctx, paint, bg, herd, branch, g, s, width - MARGIN),
  };
}

/** A piece of the footer line (its columns) and the dashboard tab a click on it opens. */
type Span = { x0: number; x1: number; tab: string };
/** What the collapsed footer draws, and the dashboard's tabs. */
type Rendered = {
  lines: string[];
  spans: Span[]; // lines[0]'s pieces and the tab each opens
  paint: (color: Color, s: string) => string;
  tabs: Tab[];
};

/**
 * The dashboard's tabs, as data (tabs.ts draws them): overview (a line per area), session, usage
 * (after the first prompt), git (in a repo), agents while pi-herd reports live ones, and jobs
 * while pi-bash-bg reports running ones. With `full`, the full view's tabs instead: info (all but
 * agents and jobs, and the changed files), and agents (a tree) and jobs with ended ones on `e`.
 */
function tabData(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  paint: (color: Color, s: string) => string,
  bg: Bg | undefined,
  herd: Herd | undefined,
  branch: string | null,
  g: Git,
  s: ReturnType<typeof sessionStats>,
  width: number,
  full?: Full,
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
  const plusMinus = (a: number, r: number) =>
    [a ? paint("success", `+${a}`) : "", r ? paint("error", `-${r}`) : ""]
      .filter(Boolean)
      .join(" ");
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
  const changes = files ? val(plural(files, "file")) + dot + plusMinus(g.added, g.removed) : "";

  const overview = [
    branch
      ? row("repo", join([basename(ctx.cwd), upstream]) + (changes && dot + changes))
      : row("path", val(tilde(ctx.cwd))),
  ];
  if (model) overview.push(row("model", join([modelName, thinking, context])));
  if (s.responses)
    overview.push(
      row(
        "usage",
        join([
          `↑${fmt(s.input)} ↓${fmt(s.output)}`,
          s.cost > 0 && `$${s.cost.toFixed(2)}`,
          ...cache,
        ]),
      ),
    );
  overview.push(row("session", join([...messages, `${duration(s.workingMs)} working`])));
  // What the agent still waits on: the agents it watches and the jobs it watches running.
  const pending = [
    herd?.watching && plural(herd.watching, "agent"),
    bg?.running && plural(bg.running, "job"),
  ];
  const waiting = pending.some(Boolean) ? row("waiting", join(pending)) : undefined;
  if (waiting) overview.push(waiting);

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
            plusMinus(g.added, g.removed),
        ),
      );
    }
  }

  // Session: model, messages, time, speed. Usage (after the first prompt): context, tokens, cost,
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
  // Cost: the total, the running or last turn's, then split like the tokens row.
  if (s.cost > 0) {
    const usd = (n: number) => `$${n.toFixed(2)}`;
    const c = s.costParts;
    usage.push(
      row(
        "cost",
        join([
          `${usd(s.cost)} total`,
          `${usd(s.turnCost)} ${turnStartedAt ? "this" : "last"} turn`,
          `input ${usd(c.input)}`,
          `output ${usd(c.output)}`,
          `cache ${usd(c.cacheRead)} read, ${usd(c.cacheWrite)} write`,
        ]),
      ),
    );
  }
  if (s.lastCached) {
    const price = cold ? cacheModel.cost?.cacheWrite : cacheModel.cost?.cacheRead;
    const next = ((ctxUsage?.tokens ?? 0) * (price ?? 0)) / 1e6;
    usage.push(row("cache", join([...cache, next >= 0.01 && `next message ~$${next.toFixed(2)}`])));
  }

  /** `e`'s hint: how many ended ones it would show, or that it hides them. */
  type Ended = { count: number; shown: boolean; toggle: () => void };
  const endedKey = (e: Ended) =>
    e.count ? (e.shown ? "e hide ended" : `e show ended (${e.count})`) : "";

  /** The agents tab: a row per agent, each with its tree guide (full view; "" at the top). */
  const agentsTab = (
    rows: { a: Agent; guide: string }[],
    sel: Picked,
    page?: number,
    ended?: Ended,
  ): Tab => {
    const list = rows.map((r) => r.a);
    const picked = list[sel.selected];
    // Like the jobs tab: the status colored only while it needs a look, the time dim.
    const stateColor = (st: string): Color =>
      st === "working" ? "accent" : st === "blocked" ? "warning" : "dim";
    const when = (a: Agent) => duration(Date.now() - a.since) + (a.live ? "" : " ago");
    // Markers after the name: a top-level agent this session didn't start, and it waits on it.
    const marks = (r: { a: Agent; guide: string }) =>
      [!r.a.mine && !r.guide && ICON.other, r.a.watched && ICON.watching].filter(Boolean).join(" ");
    const named = (r: { a: Agent; guide: string }) =>
      r.guide + [cut(r.a.name, 28), marks(r)].filter(Boolean).join(" ");
    const counts = (a: Agent) =>
      a.sent + a.received ? `${ICON.sent} ${a.sent} ${ICON.received} ${a.received}` : "";
    // Columns padded to their widest cell (by display width, for the glyphs).
    const pad = (x: string, w: number) => x + " ".repeat(Math.max(0, w - visibleWidth(x)));
    const widest = (f: (a: Agent) => string) => Math.max(0, ...list.map((a) => visibleWidth(f(a))));
    const nameW = Math.max(0, ...rows.map((r) => visibleWidth(named(r))));
    const [stateW, timeW] = [widest((a) => a.state), widest(when)];
    const cwdW = Math.min(
      32,
      widest((a) => tilde(a.cwd)),
    );
    return {
      id: "agents",
      label: "agents",
      lines: list.length ? [] : [`   ${dim("no live agents")}`],
      list: {
        sel,
        length: list.length,
        page,
        row: (i, marker) => {
          const r = rows[i]!;
          const mark = marks(r);
          return (
            `   ${marker} ${dim(r.guide)}${val(cut(r.a.name, 28))}${mark ? ` ${dim(mark)}` : ""}` +
            `${pad("", nameW - visibleWidth(named(r)))}  ` +
            `${paint(stateColor(r.a.state), pad(r.a.state, stateW))}  ` +
            `${dim(pad(when(r.a), timeW))}  ` +
            `${dim(pad(cut(tilde(r.a.cwd), cwdW), cwdW))}  ` +
            dim(counts(r.a))
          );
        },
        keys: [
          list.length && "↑↓ select",
          picked?.live && "enter view",
          picked?.live && picked.mine && "x stop",
          ended && endedKey(ended),
        ]
          .filter(Boolean)
          .join(" · "),
        note: sel.armed ? paint("warning", `press x again to stop ${picked?.name}`) : undefined,
        // enter views it; x twice stops it (live, and started by this session); e shows or hides
        // ended ones (full view); any other key disarms x.
        onKey: (data, i) => {
          if (ended?.count && matchesKey(data, "e")) return (ended.toggle(), true);
          const a = list[i];
          if (!a) return false;
          if (matchesKey(data, Key.enter) && a.live) pi.events.emit("herd:attach", { id: a.id });
          else if (matchesKey(data, "x") && a.live && a.mine) {
            if (sel.armed) pi.events.emit("herd:stop", { id: a.id });
            sel.armed = !sel.armed;
            return true;
          } else return (sel.armed = false);
          sel.armed = false;
          return true;
        },
        onPick: (i) => list[i]!.live && pi.events.emit("herd:attach", { id: list[i]!.id }),
      },
    };
  };

  /** The jobs tab: a row per job. */
  const jobsTab = (list: Job[], sel: Picked, page?: number, ended?: Ended): Tab => {
    const cmdWidth = Math.max(10, Math.min(40, width - 42));
    const selected = list[sel.selected];
    return {
      id: "jobs",
      label: "jobs",
      lines: list.length ? [] : [`   ${dim("no running jobs")}`],
      list: {
        sel,
        length: list.length,
        page,
        row: (i, marker) => {
          const j = list[i]!;
          const color: Color =
            j.state === "running"
              ? "accent"
              : j.state === "exit 0"
                ? "success"
                : j.state === "killed"
                  ? "warning"
                  : "error";
          return (
            `   ${marker} ${val(String(j.pid).padEnd(7))}` +
            `${paint(color, j.state.padEnd(9))}${dim(duration((j.endedAt ?? Date.now()) - j.startedAt).padEnd(8))}` +
            `${val(cut(j.command.split("\n")[0]!.padEnd(cmdWidth), cmdWidth))}  ${dim(tilde(j.cwd))}`
          );
        },
        keys: [
          list.length && "↑↓ select · enter logs",
          selected?.state === "running" && "x kill",
          ended && endedKey(ended),
        ]
          .filter(Boolean)
          .join(" · "),
        note: sel.armed ? paint("warning", `press x again to kill ${selected?.pid}`) : undefined,
        // enter opens the log; x twice kills; e shows or hides finished jobs (full view); any
        // other key disarms x.
        onKey: (data, i) => {
          if (ended?.count && matchesKey(data, "e")) return (ended.toggle(), true);
          const j = list[i];
          if (!j) return false;
          if (matchesKey(data, Key.enter)) pi.events.emit("bash-bg:logs", { pid: j.pid });
          else if (matchesKey(data, "x") && j.state === "running") {
            if (sel.armed) pi.events.emit("bash-bg:kill", { pid: j.pid });
            sel.armed = !sel.armed;
            return true;
          } else return (sel.armed = false);
          sel.armed = false;
          return true;
        },
        onPick: (i) => pi.events.emit("bash-bg:logs", { pid: list[i]!.pid }),
      },
    };
  };

  if (full) return fullTabs();
  const tabs: Tab[] = [
    { id: "overview", label: "overview", lines: overview },
    { id: "session", label: "session", lines: session },
  ];
  if (s.userMessages) tabs.push({ id: "usage", label: "usage", lines: usage });
  if (branch) tabs.push({ id: "git", label: "git", lines: git });
  if (herd?.list.length)
    tabs.push(
      agentsTab(
        herd.list.map((a) => ({ a, guide: "" })),
        herd,
      ),
    );
  if (bg?.list.length) tabs.push(jobsTab(bg.list, bg));
  return tabs;

  /** The full view's tabs; each list shows as many rows as fit under its tab's lines. */
  function fullTabs(): Tab[] {
    const f = full!;
    const fit = (lines: number) => Math.max(1, f.rows - lines - 2); // its hint takes 2 rows
    const info = [
      ...session,
      ...(waiting ? [waiting] : []),
      ...(s.userMessages ? ["", ...usage] : []),
      ...(branch ? ["", ...git] : []),
    ];
    // The changed files, under the git rows: status letter, path, lines added and removed.
    const pathW = Math.min(60, Math.max(0, ...g.files.map((x) => x.path.length)));
    const color = (st: string): Color =>
      st === "A" || st === "?" ? "success" : st === "D" ? "error" : "warning";
    const tabs: Tab[] = [
      {
        id: "info",
        label: "info",
        lines: info,
        list: g.files.length
          ? {
              sel: f.files,
              length: g.files.length,
              page: fit(info.length),
              row: (i, marker) => {
                const x = g.files[i]!;
                return `   ${marker} ${paint(color(x.status), x.status.padEnd(2))}${val(cut(x.path, pathW).padEnd(pathW))}  ${plusMinus(x.added, x.removed)}`;
              },
              keys: "↑↓ scroll",
            }
          : undefined,
      },
    ];
    if (herd?.all.length) {
      const shownAll = f.agents.showEnded ? herd.all : herd.all.filter((a) => a.live);
      tabs.push(
        agentsTab(tree(shownAll), f.agents, fit(shownAll.length ? 0 : 1), {
          count: herd.all.filter((a) => !a.live).length,
          shown: f.agents.showEnded,
          toggle: () => (f.agents.showEnded = !f.agents.showEnded),
        }),
      );
    }
    if (bg?.all.length) {
      const jobs = f.jobs.showEnded ? bg.all : bg.list;
      tabs.push(
        jobsTab(jobs, f.jobs, fit(jobs.length ? 0 : 1), {
          count: bg.all.length - bg.list.length,
          shown: f.jobs.showEnded,
          toggle: () => (f.jobs.showEnded = !f.jobs.showEnded),
        }),
      );
    }
    // Keep each selection on a row that still exists.
    for (const t of tabs)
      if (t.list) move(t.list.sel, t.list.sel.selected, t.list.length, t.list.page);
    return tabs;
  }
}

/**
 * Agents as a tree: each one's children (by parent) right under it, with guides (`├ └ │`). At every
 * level, stopped ones go last; otherwise pi-herd's order (the order it first listed them).
 */
function tree(agents: Agent[]): { a: Agent; guide: string }[] {
  const ids = new Set(agents.map((a) => a.id));
  const kids = Map.groupBy(agents, (a) => (a.parent && ids.has(a.parent) ? a.parent : ""));
  const out: { a: Agent; guide: string }[] = [];
  const seen = new Set<string>(); // guards against a parent loop
  const walk = (parent: string, indent: string) => {
    const level = (kids.get(parent) ?? []).filter((a) => !seen.has(a.id));
    const sorted = [
      ...level.filter((a) => a.state !== "stopped"),
      ...level.filter((a) => a.state === "stopped"),
    ];
    sorted.forEach((a, i) => {
      const last = i === sorted.length - 1;
      seen.add(a.id);
      out.push({ a, guide: parent ? indent + (last ? "└ " : "├ ") : "" });
      walk(a.id, parent ? indent + (last ? "  " : "│ ") : "");
    });
  };
  walk("", "");
  return out;
}

type MouseEvent = { type: string; button: string; x: number; y: number; width: number };

/** What the box needs from the footer: its line, where clicks go, whether the dashboard has the keys. */
type BoxHooks = {
  footer: (width: number) => string;
  clickFooter: (x: number) => void;
  clickInput: () => void;
  footerFocused: () => boolean;
};

/**
 * pi's editor drawn six columns narrower inside a rounded box set a column in on each side (so
 * the text lines up with the transcript's), with the footer as its last row.
 * Assumes pi's editor layout: top border, text rows, bottom border, then the autocomplete list.
 */
class BoxEditor extends CustomEditor {
  hooks: BoxHooks;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, hooks: BoxHooks) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.hooks = hooks;
  }

  // Text rows pi's editor rendered last frame (private in pi, but set on every render).
  private get rows(): number {
    return (this as unknown as { renderedVisibleLineCount: number }).renderedVisibleLineCount;
  }

  render(width: number): string[] {
    if (width < 10) return super.render(width);
    const inner = width - 6;
    const lines = super.render(inner);
    const bottom = this.rows + 1;
    const b = (s: string) => this.borderColor(s);
    const side = (line: string) => ` ${b("│")} ${line} ${b("│")} `;
    const footer = cut(this.hooks.footer(inner), inner);
    // While the dashboard has the keys, drop pi's cursor (an inverse cell, and the hardware
    // cursor's marker) so it's clear typing isn't going to the prompt.
    const text = lines.slice(1, bottom);
    // oxlint-disable-next-line no-control-regex
    const inverse = /\x1b\[7m(.*?)\x1b\[0m/;
    const rows = !this.hooks.footerFocused()
      ? text
      : text.map((l) => l.replace(CURSOR_MARKER, "").replace(inverse, "$1"));
    return [
      b(" ╭─") + lines[0] + b("─╮ "),
      ...rows.map(side),
      side(" ".repeat(inner)),
      side(footer + " ".repeat(Math.max(0, inner - visibleWidth(footer)))),
      b(" ╰─") + lines[bottom] + b("─╯ "),
      ...lines.slice(bottom + 1).map((line) => `   ${line}   `), // autocomplete list, below the box
    ];
  }

  // Clicks map back onto pi's editor: three columns for margin, border and padding, two rows for
  // the footer. One on the text (or the blank row under it) also gives the prompt the keys back
  // and closes the dashboard; one on the footer line goes to the footer (its pieces open tabs).
  handleMouse(event: MouseEvent) {
    if (event.width < 10) return super.handleMouse(event);
    const shifted = { ...event, x: event.x - 3, width: event.width - 6 };
    const click = event.type === "click" && event.button === "left";
    if (click && event.y <= this.rows + 1) this.hooks.clickInput();
    if (event.y <= this.rows) return super.handleMouse(shifted);
    if (event.y === this.rows + 1) return { handled: true, focus: true };
    if (event.y === this.rows + 2) {
      if (click) this.hooks.clickFooter(event.x - 3);
      return { handled: true };
    }
    return super.handleMouse({ ...shifted, y: event.y - 2 });
  }
}

type Node = { children?: Node[]; isShowingAutocomplete?: () => boolean; getText?: () => string };
/** pi's editor, for where its cursor is (historyIndex is private: -1 when not browsing history). */
type PromptEditor = {
  getLines?: () => string[];
  getCursor?: () => { line: number; col: number };
  historyIndex?: number;
  focused?: boolean; // false while a selector (e.g. /tree) replaces it
};
// Found by duck typing; if pi's layout changes, the autocomplete gap and border pinning just stop
// applying.
const findEditor = (node: Node): Node | undefined => {
  if (typeof node.isShowingAutocomplete === "function") return node;
  for (const child of node.children ?? []) {
    const found = findEditor(child);
    if (found) return found;
  }
  return undefined;
};

// pi reassigns editor.borderColor on thinking-level changes; a no-op setter pins it.
const pinBorderColor = (editor: Node, theme: Theme) =>
  Object.defineProperty(editor, "borderColor", {
    configurable: true,
    get: () => (s: string) =>
      theme.fg(editor.getText?.().trimStart().startsWith("!") ? "bashMode" : "muted", s),
    set: () => {},
  });

export default function (pi: ExtensionAPI) {
  const config = readConfig();
  const statusPollMs = (config.gitStatusPollMins ?? 0.5) * 60_000;
  const fetchPollMs = (config.gitFetchPollMins ?? 30) * 60_000;

  let g: Git = EMPTY_GIT;
  const tabs = new Tabs(); // the dashboard: open, focus, active tab
  let shown: Tab[] = []; // the tabs as last rendered, for keys and clicks
  let bg: Bg | undefined;
  let herd: Herd | undefined;
  // The full view (o, /footer full): its lists' selections and `e` settings, kept until pi exits.
  const full: Full = {
    rows: 0,
    files: { selected: 0, top: 0 },
    agents: { selected: 0, top: 0, armed: false, showEnded: false },
    jobs: { selected: 0, top: 0, armed: false, showEnded: false },
  };
  let fullTabs: ((width: number, rows: number) => Rendered) | undefined; // set with the footer
  let fullOpen = false;
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
    // Never prompt for credentials: fail quietly and show an older "fetched" time instead.
    await git(
      session.cwd,
      ["fetch", "--quiet", "--no-tags"],
      {
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      },
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
  // The cursor is at the end of the prompt's text (not browsing history), with no autocomplete
  // list or overlay, and the prompt has focus (not /tree etc.): ↓ has nothing left to do there, so it moves on to the dashboard.
  let promptEnd = () => true;
  let tuiHasOverlay = () => false; // e.g. pi-bash-bg's log viewer, which gets its own keys
  type List<T = unknown> = Picked & { list: readonly T[] };
  /** Selects a job or agent row (and disarms x). */
  const select = (b: List, i: number) => {
    move(b, i, b.list.length);
    b.armed = false;
  };
  // Reopening shows the top: running jobs and watched agents first.
  tabs.onClose = () => {
    if (bg) select(bg, 0);
    if (herd) select(herd, 0);
  };
  /** The selection follows its row (by key) while the tab is open, and starts at the top otherwise. */
  const reselect = <T>(
    old: List<T> | undefined,
    next: List<T>,
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

  // pi-herd lists agents in the order it first saw them. The dashboard shows the live top-level
  // ones (not under another listed agent); the full view, all of them.
  pi.events.on("herd:update", (data) => {
    const u = data as { agents: Agent[]; watching: number };
    const ids = new Set(u.agents.map((a) => a.id));
    const list = u.agents.filter((a) => a.live && !(a.parent && ids.has(a.parent)));
    const next: Herd = {
      all: u.agents,
      list,
      watching: u.watching,
      selected: 0,
      top: 0,
      armed: false,
    };
    reselect(herd, next, "agents", (a) => a.id);
    herd = next;
  });

  // The dashboard shows the running jobs; the full view, finished ones too.
  pi.events.on("bash-bg:update", (data) => {
    const u = data as { jobs: Job[]; running: number };
    const list = u.jobs.filter((j) => j.state === "running");
    const all = [...list, ...u.jobs.filter((j) => j.state !== "running")];
    const next: Bg = { all, list, running: u.running, selected: 0, top: 0, armed: false };
    reselect(bg, next, "jobs", (j) => j.pid);
    bg = next;
  });

  /** Opens the full view at `tab` (info, agents or jobs); the dashboard stays as it was. */
  const openFull = (tab: string) => {
    if (!session || !fullTabs || fullOpen) return;
    fullOpen = true;
    const build = fullTabs;
    void session.ui
      .custom<void>((tui, theme, _kb, done) => fullView(tui, theme, build, tab, done), {
        overlay: true,
        overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
      })
      .finally(() => {
        fullOpen = false;
        requestRender();
      });
  };
  const fullTab = (tab: string) => (tab === "agents" || tab === "jobs" ? tab : "info");
  tabs.onExpand = (tab) => openFull(fullTab(tab));

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stop();
    session = ctx;
    g = EMPTY_GIT;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      let editor: Node | undefined;
      const unsubscribe = footerData.onBranchChange(refreshSoon);
      return {
        dispose: unsubscribe,
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
            if (editor && config.disableEffortColors !== false) pinBorderColor(editor, theme);
            tuiHasOverlay = () => tui.hasOverlay();
            promptEnd = () => {
              const e = editor as Node & PromptEditor;
              const lines = e.getLines?.() ?? [""];
              const cursor = e.getCursor?.() ?? { line: 0, col: 0 };
              return (
                e.focused !== false &&
                cursor.line === lines.length - 1 &&
                cursor.col === lines.at(-1)!.length &&
                (e.historyIndex ?? -1) === -1 &&
                !e.isShowingAutocomplete?.() &&
                !tui.hasOverlay()
              );
            };
          }
          const draw = (w: number, f?: Full) =>
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
              f,
            );
          fullTabs = (w, rows) => draw(w, Object.assign(full, { rows }));
          footerLine = (w) => draw(w).lines[0]!;
          const drawn = draw(width);
          spans = drawn.spans;
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
          }),
      );
    // The dashboard's keys (see tabs.ts): ↓ at the end of the prompt opens it.
    stopInput = ctx.ui.onTerminalInput((data) => {
      if (!shown.length || !tabs.input(data, shown, promptEnd, tuiHasOverlay())) {
        if (!tabs.focus) requestRender(); // typing may have handed the keys back
        return undefined;
      }
      requestRender();
      return { consume: true };
    });
    await refresh();
    timers.push(setInterval(() => requestRender(), 10_000)); // keeps the cache countdown current
    if (statusPollMs > 0) timers.push(setInterval(refresh, statusPollMs));
    if (fetchPollMs > 0) {
      timers.push(setInterval(gitFetch, fetchPollMs));
      if (!g.fetchedAt || Date.now() - g.fetchedAt > fetchPollMs) void gitFetch();
    }
  });
  pi.on("session_shutdown", async () => {
    stop();
    session = undefined;
    turnStartedAt = undefined;
  });

  // Anything that may have edited files or moved HEAD.
  pi.on("tool_result", async () => refreshSoon());
  pi.on("user_bash", async () => refreshSoon());
  pi.on("message_update", async ({ message }) => {
    if (message.role === "assistant" && !firstTokenAt.has(message.timestamp))
      firstTokenAt.set(message.timestamp, Date.now());
  });
  pi.on("agent_start", async () => {
    turnStartedAt = Date.now();
  });
  pi.on("agent_end", async () => {
    turnStartedAt = undefined;
    refreshSoon();
  });

  // /footer [tab]: opens at that tab, or like ↓ does; without a tab, it closes an open dashboard.
  // /footer full: the full view (at the tab ↓ would open).
  pi.registerCommand("footer", {
    description:
      "Open the footer dashboard, optionally at a tab, or the full view with full (↓ and o too)",
    getArgumentCompletions: (prefix) => {
      const items = [...shown.map((t) => t.id), "full"].filter((id) =>
        id.startsWith(prefix.trim()),
      );
      return items.length ? items.map((id) => ({ value: id, label: id })) : null;
    },
    handler: async (args) => {
      const tab = args.trim();
      if (tab === "full") return openFull(fullTab(tabs.pick() ?? ""));
      if (!tab && tabs.expanded) tabs.close();
      else tabs.show(shown.some((t) => t.id === tab) ? tab : (tabs.pick() ?? tabs.tab));
      requestRender();
    },
  });
}
