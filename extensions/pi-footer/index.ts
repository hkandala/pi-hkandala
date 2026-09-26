/**
 * pi-footer: minimal one-line footer inside a rounded input box; click it (fullscreen mode),
 * press ctrl+shift+s, or run /dashboard to expand the dashboard below the box.
 *
 *    ╭── ⠋ Working ──────────────────────────────────────────────────────────────────────────────────────╮
 *    │ prompt                                                                                             │
 *    │                                                                                                    │
 *    │  pi-hkandala · 󰘬 master 󰁝2 󰁅1 · +42 -7   ↑116 ↓29.6k (99% · 4m) · $1.24 · 󰪟 47k/200k · opus-5.5 · high │
 *    ╰────────────────────────────────────────────────────────────────────────────────────────────────────╯
 *
 * Narrow terminals drop whole sections: usage, cost, git, context. Folder and model always stay.
 * Config (optional): ~/.pi/agent/extensions/pi-footer.json
 *   { "promptEditor": "box" | "default", "disableEffortColors": true, "style": "color" | "white",
 *     "iconColor": "accent", "gitStatusPollMins": 0.5, "gitFetchPollMins": 30 }
 *   promptEditor "default" keeps pi's editor with the footer below it; disableEffortColors false
 *   lets the prompt border follow pi's thinking-level colors instead of staying gray;
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
import { Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { EMPTY_GIT, type Git, git, readGit } from "./git.ts";

const ICON = {
  folder: "\uf07b", //  fa-folder
  repo: "\u{f02a2}", // 󰊢 md-git
  worktree: "\u{f0645}", // 󰙅 md-file-tree
  branch: "\u{f062c}", // 󰘬 md-source-branch
  ahead: "\u{f005d}", // 󰁝 md-arrow-up-bold (commits to push)
  behind: "\u{f0045}", // 󰁅 md-arrow-down-bold (commits to pull)
};
// Context pie in eighths: md-circle_outline, then md-circle_slice_1..8. Nerd Font glyphs, so they
// match in size (Unicode's ○ ◔ ◑ ◕ ● mix fonts).
const PIE = [
  "\u{f0766}",
  ...Array.from({ length: 8 }, (_, i) => String.fromCodePoint(0xf0a9e + i)),
];
const MAX_FILES = 5; // changes listed in the dashboard
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
  cost?: { total: number };
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
    cacheHit: undefined as number | undefined,
    responses: 0,
    userMessages: 0,
    toolCalls: 0,
    compactions: 0,
    lastSpeed: undefined as number | undefined,
    streamMs: 0,
    streamOutput: 0,
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
    // Tokens per second from message start to saved, so it includes the time to first token.
    const ms = ts !== undefined && e.message.timestamp ? ts - e.message.timestamp : 0;
    if (ms > 0 && usage.output > 0) {
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

/** When the running turn started (agent_start), while one runs. */
let turnStartedAt: number | undefined;

function render(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  theme: Theme,
  config: Config,
  expanded: boolean,
  branch: string | null,
  g: Git,
  statuses: ReadonlyMap<string, string>,
  width: number,
): string[] {
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
  // Prompt cache: alive for its lifetime after the last cached response (or warm refresh);
  // cold once that passes, the model changed, or the history was compacted: the next message re-bills.
  const model = ctx.model;
  const cacheModel = (model ?? {}) as CacheModel;
  const ctxUsage = contextUsage(ctx);
  const approx = ctxUsage?.estimated ? "~" : "";
  const ttlMs =
    (cacheModel.promptCache?.[process.env.PI_CACHE_RETENTION === "long" ? "long" : "short"] ??
      DEFAULT_CACHE_TTL_S) * 1000;
  const cacheAge = s.cachedAt !== undefined ? Date.now() - s.cachedAt : 0;
  const expired = cacheAge > ttlMs;
  const modelChanged = !!model && !!s.lastModel && s.lastModel !== `${model.provider}/${model.id}`;
  const cold = s.lastCached && (expired || modelChanged || s.compactedSince);
  const perToken = (price = 0) => ((ctxUsage?.tokens ?? 0) * price) / 1e6;
  const coldExtra = perToken(
    (cacheModel.cost?.cacheWrite ?? 0) - (cacheModel.cost?.cacheRead ?? 0),
  );
  const cacheState = !s.lastCached
    ? undefined
    : cold
      ? paint("warning", "cold") + (coldExtra >= 0.01 ? dim(` · ~$${coldExtra.toFixed(2)}`) : "")
      : dim(`· ${duration(ttlMs - cacheAge)}`);
  const hit =
    s.cacheHit !== undefined && !cold
      ? paint(s.cacheHit < 90 ? "warning" : "dim", `${Math.round(s.cacheHit)}%`)
      : undefined;
  const usagePiece =
    s.input || s.output
      ? dim(`↑${fmt(s.input)} ↓${fmt(s.output)}`) +
        (hit || cacheState
          ? ` ${dim("(")}${[hit, cacheState].filter(Boolean).join(" ")}${dim(")")}`
          : "")
      : undefined;
  const costPiece = s.cost > 0 ? dim(`$${s.cost.toFixed(2)}`) : undefined;
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
  const levelColor = `thinking${level[0].toUpperCase()}${level.slice(1)}` as Color;
  const modelPiece =
    (model ? paint("text", shortModel(model.id)) : dim("no model")) +
    (model?.reasoning ? dot + paint(levelColor, level) : "");

  // Drop whole sections until the line fits; folder and model always stay.
  const groups = (gs: (string | undefined)[][]) =>
    gs
      .map((g) => g.filter(Boolean).join(dot))
      .filter(Boolean)
      .join(dot);
  const pieces = { usage: usagePiece, cost: costPiece, git: gitPiece, context: contextPiece };
  const drops = ["usage", "cost", "git", "context"] as const;
  let left = "";
  let right = "";
  for (let n = 0; n <= drops.length; n++) {
    const p = { ...pieces };
    for (const k of drops.slice(0, n)) p[k] = undefined;
    left = groups([[`${icon(ICON.folder)} ${paint("text", folder)}`], [p.git]]);
    right = groups([[p.usage, p.cost], [p.context], [modelPiece]]);
    if (visibleWidth(left) + 2 + visibleWidth(right) <= width) break;
  }
  left = truncateToWidth(left, Math.max(8, width - visibleWidth(right) - 2), "…");
  const lines = [
    truncateToWidth(
      left + " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right))) + right,
      width,
      "…",
    ),
  ];

  if (statuses.size) {
    const line = [...statuses.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => text.replace(/[\r\n\t]+/g, " "))
      .join(dot);
    const w = visibleWidth(line);
    lines.push(truncateToWidth(w < width ? " ".repeat(width - w) + line : line, width, "…"));
  }
  if (!expanded) return lines;

  // Dashboard: three blocks (where, model, session) separated by blank lines.
  const val = (s: string) => paint("text", s);
  const LABEL = 11;
  const row = (label: string, value: string) =>
    truncateToWidth(`   ${paint("muted", label.padEnd(LABEL))}${value}`, width, "…");
  const indent = " ".repeat(LABEL + 3);
  const blocks: string[][] = [];

  const where = [row("path", val(tilde(ctx.cwd)))];
  if (branch) {
    if (g.repo) where.push(row("repo", val(g.url ?? g.repo)));
    if (g.worktrees.length > 1) {
      const label = (w: string) => (w === g.worktrees[0] ? `${w} (main)` : w);
      const others = g.worktrees.filter((w) => w !== g.current).map(label);
      where.push(
        row(
          "worktree",
          val(label(g.current)) +
            dot +
            val(`${others.length} other${others.length > 1 ? "s" : ""}: ${others.join(", ")}`),
        ),
      );
    }
    const sync = !g.current
      ? [] // git not read (untrusted project)
      : !g.upstream
        ? ["no upstream"]
        : [
            g.ahead ? `${g.ahead} to push` : "",
            g.behind ? `${g.behind} to pull` : "",
            !g.ahead && !g.behind ? "up to date" : "",
            g.fetchedAt ? `fetched ${duration(Date.now() - g.fetchedAt)} ago` : "never fetched",
          ].filter(Boolean);
    where.push(
      row("branch", [branch + (g.upstream ? ` → ${g.upstream}` : ""), ...sync].map(val).join(dot)),
    );
    if (g.commit) where.push(row("commit", val(g.commit) + dot + val(g.commitAge ?? "")));
    if (g.files.length) {
      const plusMinus = (a: number, r: number) =>
        [a ? paint("success", `+${a}`) : "", r ? paint("error", `-${r}`) : ""]
          .filter(Boolean)
          .join(" ");
      where.push(
        row(
          "changes",
          val(`${g.files.length} file${g.files.length > 1 ? "s" : ""}`) +
            dot +
            plusMinus(g.added, g.removed),
        ),
      );
      const shown = g.files.slice(0, MAX_FILES);
      const pathWidth = Math.min(
        Math.max(...shown.map((f) => f.path.length)),
        Math.max(10, width - LABEL - 17),
      );
      const statusColor: Record<string, Color> = { A: "success", D: "error", "?": "muted" };
      for (const f of shown) {
        const path =
          f.path.length > pathWidth
            ? `…${f.path.slice(-(pathWidth - 1))}`
            : f.path.padEnd(pathWidth);
        where.push(
          truncateToWidth(
            `${indent}${paint(statusColor[f.status] ?? "warning", f.status)}  ${val(path)}  ${plusMinus(f.added, f.removed)}`,
            width,
            "…",
          ),
        );
      }
      if (g.files.length > MAX_FILES)
        where.push(indent + val(`+${g.files.length - MAX_FILES} more`));
    }
  }
  blocks.push(where);

  const brain: string[] = [];
  if (model)
    brain.push(
      row(
        "model",
        val(`${model.provider}/${model.id}`) +
          (model.reasoning ? dot + val(`thinking ${level}`) : ""),
      ),
    );
  if (ctxUsage?.tokens)
    brain.push(
      row(
        "context",
        val(`${approx}${fmt(ctxUsage.tokens)} / ${fmt(window)}`) +
          (pct !== undefined ? val(` (${Math.round(pct)}%)`) : "") +
          (s.compactions ? dot + val(`compacted ${s.compactions}×`) : ""),
      ),
    );
  if (s.responses)
    brain.push(
      row(
        "tokens",
        [
          `↑${fmt(s.input)} input`,
          `↓${fmt(s.output)} output`,
          `cache ${fmt(s.cacheRead)} read, ${fmt(s.cacheWrite)} write`,
          s.cost > 0 ? `$${s.cost.toFixed(2)}` : "",
        ]
          .filter(Boolean)
          .map(val)
          .join(dot),
      ),
    );
  if (s.lastCached) {
    const next = perToken(cold ? cacheModel.cost?.cacheWrite : cacheModel.cost?.cacheRead);
    brain.push(
      row(
        "cache",
        [
          s.cacheHit !== undefined ? `${Math.round(s.cacheHit)}% last hit` : "",
          cold
            ? `cold${expired ? ` · expired ${duration(cacheAge - ttlMs)} ago` : ""}`
            : `expires in ${duration(ttlMs - cacheAge)}`,
          next >= 0.01 ? `next message ~$${next.toFixed(2)}` : "",
        ]
          .filter(Boolean)
          .map(val)
          .join(dot),
      ),
    );
  }
  if (s.lastSpeed !== undefined)
    brain.push(
      row(
        "speed",
        val(`${Math.round(s.lastSpeed)} t/s last`) +
          dot +
          val(`${Math.round(s.streamOutput / (s.streamMs / 1000))} t/s avg`),
      ),
    );
  blocks.push(brain);

  const name = pi.getSessionName();
  const session = [
    row(
      "session",
      [
        name,
        `${s.userMessages} user`,
        `${s.responses} assistant`,
        `${s.toolCalls} tool call${s.toolCalls === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .map((x) => val(x!))
        .join(dot),
    ),
  ];
  if (s.startedAt)
    session.push(
      row(
        "time",
        [
          turnStartedAt
            ? `${duration(Date.now() - turnStartedAt)} this turn`
            : s.lastTurnMs && `${duration(s.lastTurnMs)} last turn`,
          `${duration(s.workingMs)} working`,
          `${duration(Date.now() - s.startedAt)} since start`,
        ]
          .filter(Boolean)
          .map((x) => val(x!))
          .join(dot),
      ),
    );
  blocks.push(session);

  for (const block of blocks) lines.push("", ...block);
  lines.push(""); // matches the blank row above it
  return lines;
}

type MouseEvent = { type: string; button: string; x: number; y: number; width: number };

/**
 * pi's editor drawn six columns narrower inside a rounded box set a column in on each side (so
 * the text lines up with the transcript's), with the footer as its last row.
 * Assumes pi's editor layout: top border, text rows, bottom border, then the autocomplete list.
 */
class BoxEditor extends CustomEditor {
  footer: (width: number) => string;
  onFooterClick: () => void;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    footer: (width: number) => string,
    onFooterClick: () => void,
  ) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.footer = footer;
    this.onFooterClick = onFooterClick;
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
    const footer = truncateToWidth(this.footer(inner), inner, "…");
    return [
      b(" ╭─") + lines[0] + b("─╮ "),
      ...lines.slice(1, bottom).map(side),
      side(" ".repeat(inner)),
      side(footer + " ".repeat(Math.max(0, inner - visibleWidth(footer)))),
      b(" ╰─") + lines[bottom] + b("─╯ "),
      ...lines.slice(bottom + 1).map((line) => `   ${line}   `), // autocomplete list, below the box
    ];
  }

  // Map clicks back onto pi's editor: three columns for margin, border and padding, two rows for
  // the footer.
  handleMouse(event: MouseEvent) {
    if (event.width < 10) return super.handleMouse(event);
    const shifted = { ...event, x: event.x - 3, width: event.width - 6 };
    if (event.y <= this.rows) return super.handleMouse(shifted);
    if (event.y === this.rows + 2 && event.type === "click" && event.button === "left") {
      this.onFooterClick();
      return { handled: true };
    }
    if (event.y <= this.rows + 2) return { handled: true, focus: true };
    return super.handleMouse({ ...shifted, y: event.y - 2 });
  }
}

type Node = { children?: Node[]; isShowingAutocomplete?: () => boolean; getText?: () => string };
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
  let expanded = false;
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
  const stop = () => {
    timers.forEach(clearInterval);
    timers = [];
    clearTimeout(debounce);
  };
  const box = config.promptEditor !== "default";
  let footerLine: (width: number) => string = () => "";
  const toggle = () => {
    expanded = !expanded;
    requestRender();
  };

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
        // Mouse events only arrive in fullscreen TUI mode.
        handleMouse(event: MouseEvent) {
          if (event.type !== "click" || event.button !== "left") return undefined;
          toggle();
          return { handled: true };
        },
        render: (width: number) => {
          if (!editor) {
            editor = findEditor(tui);
            if (editor && config.disableEffortColors !== false) pinBorderColor(editor, theme);
          }
          const draw = (w: number, open: boolean) =>
            render(
              pi,
              ctx,
              theme,
              config,
              open,
              footerData.getGitBranch(),
              g,
              footerData.getExtensionStatuses(),
              w,
            );
          footerLine = (w) => draw(w, false)[0];
          // In box mode the collapsed line lives in the editor; the rest stays down here.
          const lines = box ? draw(width, expanded).slice(1) : draw(width, expanded);
          // Keep one blank row between pi's autocomplete list (drawn under the editor) and the
          // footer; the dashboard already starts with one.
          return lines[0] && editor?.isShowingAutocomplete?.() ? ["", ...lines] : lines;
        },
      };
    });
    if (box)
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) =>
          new BoxEditor(tui, theme, keybindings, (w) => footerLine(w), toggle),
      );
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
  pi.on("agent_start", async () => {
    turnStartedAt = Date.now();
  });
  pi.on("agent_end", async () => {
    turnStartedAt = undefined;
    refreshSoon();
  });

  pi.registerCommand("dashboard", {
    description: "Expand or collapse the footer dashboard",
    handler: async () => toggle(),
  });
  pi.registerShortcut(Key.ctrlShift("s"), {
    description: "Expand or collapse the footer dashboard",
    handler: async () => toggle(),
  });
}
