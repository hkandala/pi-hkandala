/**
 * pi-header: minimal startup header with the official pi logo.
 * Collapsed shows resource counts; ctrl+o expands the lists; /loaded prints full paths.
 * Clicking the logo (fullscreen TUI mode) toggles color/white and saves the choice; clicking the
 * text expands or collapses the header, like ctrl+o.
 * Before the first message, pi's "Tool output: …" line for ctrl+o is hidden (the header expanding
 * is the feedback); every other status line and notice shows.
 *
 * Config (optional): ~/.pi/agent/extensions/pi-header.json
 *   →  { "logo": "color" | "white", "compact": false }  (compact: 2-row half-block logo)
 * Pair with "quietStartup": true in ~/.pi/agent/settings.json to hide pi's built-in listing.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  DefaultPackageManager,
  DynamicBorder,
  getAgentDir,
  getMarkdownTheme,
  keyText,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi,
  Container,
  foregroundAnsi,
  getCellDimensions,
  Markdown,
  mixColors,
  rgbColor,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

type RGB = [number, number, number];
const LOGO = ["SSS.", "B.S.", "BB.Y", "B..Y"];
const COLORS: Record<string, RGB> = { S: [240, 144, 130], B: [78, 154, 191], Y: [241, 190, 88] }; // sRGB, measured from the official logo
const WHITE: RGB = [255, 255, 255];
const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]; // left-aligned k/8 of a cell
const SPACING = 1.5; // logo pixels left/right of the logo
// Blank rows above/below, in whole rows closest to SPACING: 2 (1-row pixels), 1 compact (half-row).
const rowsFor = (compact: boolean) => (compact ? 1 : 2);
// Unless quietStartup is true, pi adds a blank row above the header and one below it.
const topRows = (compact: boolean, quiet: boolean) => rowsFor(compact) - (quiet ? 0 : 1);
const SECTIONS = ["context", "skills", "prompts", "extensions", "themes"] as const;
type Resources = Record<(typeof SECTIONS)[number], { name: string; path: string }[]>;

type Mode = ReturnType<Theme["getColorMode"]>;
const fg = (c: RGB, mode: Mode) => foregroundAnsi(rgbColor(...c), mode);
const bg = (c: RGB, mode: Mode) => backgroundAnsi(rgbColor(...c), mode);

/**
 * Each logo pixel is one row tall and exactly one cell-height wide (measured via
 * pi-tui's cell size), with edges placed in 1/8 cells. SPACING logo pixels of space
 * on each side. Returns lines padded to the text column.
 */
function renderLogo(white: boolean, compact: boolean, mode: Mode) {
  if (compact) return renderCompactLogo(white, mode);
  const { widthPx, heightPx } = getCellDimensions();
  const px = (8 * heightPx) / widthPx;
  const column = Math.round(((LOGO.length + 2 * SPACING) * px) / 8);
  const offset = Math.round((column * 8 - LOGO.length * px) / 2);
  const edges = [0, 1, 2, 3, 4].map((c) => offset + Math.round(c * px));
  const colorAt = (row: string, e: number): RGB | undefined => {
    if (e < edges[0] || e >= edges[4]) return undefined;
    const color = COLORS[row[edges.findLastIndex((x) => x <= e)]];
    return color && white ? WHITE : color;
  };

  const lines = LOGO.map((row) => {
    let line = "";
    for (let cell = 0; cell < column; cell++) {
      const start = cell * 8;
      const split = edges.find((e) => e > start && e < start + 8); // pixels ≥ 1 cell, so at most one
      const l = colorAt(row, start);
      const r = split === undefined ? l : colorAt(row, split);
      const glyph = split === undefined ? "" : BLOCKS[split - start];
      if (!l && !r) line += " ";
      else if (l === r) line += `${fg(l!, mode)}█\x1b[39m`;
      else if (!r) line += `${fg(l!, mode)}${glyph}\x1b[39m`;
      else if (!l) line += `\x1b[7m${fg(r, mode)}${glyph}\x1b[27;39m`; // reverse: glyph takes the terminal background
      else line += `${fg(l, mode)}${bg(r, mode)}${glyph}\x1b[39;49m`;
    }
    return line;
  });
  return { lines, pad: Math.floor(offset / 8), column };
}

/** Compact: each pixel is half a row tall (▀/▄ half blocks) and as wide as that in whole cells. */
function renderCompactLogo(white: boolean, mode: Mode) {
  const { widthPx, heightPx } = getCellDimensions();
  const w = Math.max(1, Math.round(heightPx / 2 / widthPx)); // cells per pixel
  const pad = Math.round(SPACING * w);
  const colorAt = (ch = "") => (COLORS[ch] && white ? WHITE : COLORS[ch]);
  const lines: string[] = [];
  for (let y = 0; y < LOGO.length; y += 2) {
    let line = " ".repeat(pad);
    for (let x = 0; x < LOGO[y].length; x++) {
      const t = colorAt(LOGO[y][x]);
      const b = colorAt(LOGO[y + 1]?.[x]);
      if (!t && !b) line += " ".repeat(w);
      else if (t === b) line += `${fg(t!, mode)}${"█".repeat(w)}\x1b[39m`;
      else if (!b) line += `${fg(t!, mode)}${"▀".repeat(w)}\x1b[39m`;
      else if (!t) line += `${fg(b, mode)}${"▄".repeat(w)}\x1b[39m`;
      else line += `${fg(t, mode)}${bg(b, mode)}${"▀".repeat(w)}\x1b[39;49m`;
    }
    lines.push(line + " ".repeat(pad));
  }
  return { lines, pad, column: 2 * pad + LOGO[0].length * w };
}

/** Cuts `text` to `width` with a … in the style at the cut (pi's truncateToWidth resets it). */
function cut(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  // Cut with no ellipsis, pi's result ends in a reset ("\x1b[0m", 4 chars): drop it, add the ….
  return width < 1 ? "" : `${truncateToWidth(text, width - 1, "").slice(0, -4)}…\x1b[0m`;
}

/** Text halfway between the theme's muted and text colors. */
function soft(theme: Theme): (s: string) => string {
  const color = mixColors(theme.colors.muted, theme.colors.text, 0.5, "srgb");
  return (s) => theme.style(s, { fg: color });
}

function render(
  theme: Theme,
  res: Resources,
  expanded: boolean,
  white: boolean,
  compact: boolean,
  quiet: boolean,
  width: number,
  blanksBelow: number,
): string[] {
  const gray = soft(theme);
  const dot = theme.fg("dim", " · ");
  const key = (id: string) => keyText(id).replace("escape", "esc");
  const hint = (pairs: string[][]) => pairs.map(([k, d]) => gray(`${k} ${d}`)).join(dot);

  const hints = hint([
    [key("app.interrupt"), "interrupt"],
    ["/", "commands"],
    ["!", "bash"],
    [key("app.tools.expand"), expanded ? "collapse" : "expand"],
  ]);
  const counts = SECTIONS.filter((s) => res[s].length)
    .map((s) => gray(`${res[s].length} ${res[s].length === 1 ? s.replace(/s$/, "") : s}`))
    .join(dot);

  const logo = renderLogo(white, compact, theme.getColorMode());
  const title = theme.bold("pi") + gray(` v${VERSION}`);
  const info = compact ? [title + dot + hints, counts] : [title, hints, "", counts];
  const rows = rowsFor(compact);
  // Blank lines the content below already starts with count toward the gap.
  const top = Array<string>(topRows(compact, quiet)).fill("");
  const bottom = Array<string>(Math.max(0, topRows(compact, quiet) - blanksBelow)).fill("");
  const out = [...top, ...logo.lines.map((line, i) => line + info[i])];
  if (!expanded) return [...out, ...bottom];

  // Lists: label under the logo, items in the text column (wider if a label needs it), packed so
  // " · " never ends a line.
  const column = Math.max(logo.column, logo.pad + Math.max(...SECTIONS.map((s) => s.length)) + 1);
  out.push(...Array<string>(rows).fill(""));
  for (const s of SECTIONS) {
    const lines: string[] = [];
    for (const item of res[s].map((i) => gray(i.name))) {
      const last = lines.at(-1);
      if (last !== undefined && visibleWidth(last + dot + item) <= width - column)
        lines[lines.length - 1] += dot + item;
      else lines.push(item);
    }
    lines.forEach((line, i) =>
      out.push(
        (i
          ? " ".repeat(column)
          : " ".repeat(logo.pad) + gray(s.padEnd(column - logo.pad - 1)) + " ") + line,
      ),
    );
  }
  out.push(
    "",
    " ".repeat(column) +
      hint([
        ["/hotkeys", "all shortcuts"],
        ["/loaded", "full paths"],
      ]),
  );
  return [...out, ...bottom];
}

const tilde = (path: string) =>
  path === homedir() || path.startsWith(`${homedir()}/`)
    ? `~${path.slice(homedir().length)}`
    : path;
const displayPath = (path: string, cwd: string) => {
  const rel = relative(cwd, path);
  return rel.startsWith("..") ? tilde(path) : rel;
};
const extensionName = (p: string) =>
  (/^index\.[jt]s$/.test(basename(p)) ? basename(dirname(p)) : basename(p)).replace(/\.[jt]s$/, "");

function readResources(pi: ExtensionAPI, ctx: ExtensionContext, extensions: string[]): Resources {
  const byName = (items: { name: string; path: string }[]) =>
    items.sort((a, b) => a.name.localeCompare(b.name));
  const commands = (source: string) => pi.getCommands().filter((c) => c.source === source);
  return {
    context: [...ctx.getSystemPrompt().matchAll(/<project_instructions path="([^"]+)">/g)].map(
      ([, path]) => ({ name: displayPath(path, ctx.cwd), path }),
    ),
    skills: byName(
      commands("skill").map((c) => ({
        name: c.name.replace(/^skill:/, ""),
        path: c.sourceInfo.path,
      })),
    ),
    prompts: byName(
      commands("prompt").map((c) => ({ name: `/${c.name}`, path: c.sourceInfo.path })),
    ),
    extensions: byName(extensions.map((path) => ({ name: extensionName(path), path }))),
    themes: byName(
      ctx.ui
        .getAllThemes()
        .filter((t) => t.path && t.name !== "dark" && t.name !== "light")
        .map((t) => ({ name: t.name, path: t.path! })),
    ),
  };
}

/** Pi doesn't expose loaded extensions, so resolve them like pi does: CLI -e paths + settings/packages/auto-discovery. */
async function resolveExtensions(
  ctx: ExtensionContext,
  settingsManager: SettingsManager,
): Promise<string[]> {
  const argv = process.argv;
  const paths = argv.flatMap((a, i) =>
    (a === "-e" || a === "--extension") && argv[i + 1] ? [resolve(ctx.cwd, argv[i + 1])] : [],
  );
  // --no-extensions: pi loads only the -e paths.
  if (argv.includes("--no-extensions") || argv.includes("-ne")) return [...new Set(paths)];
  const resolved = await new DefaultPackageManager({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    settingsManager,
  }).resolve(async () => "skip");
  paths.push(...resolved.extensions.filter((e) => e.enabled).map((e) => e.path));
  return [...new Set(paths)];
}

type Node = { children?: Node[] };
const parentOf = (node: Node, target: Node): Node | undefined => {
  for (const child of node.children ?? []) {
    if (child === target) return node;
    const found = parentOf(child, target);
    if (found) return found;
  }
  return undefined;
};

/**
 * ctrl+o makes pi post "Tool output: expanded" to the chat as a Spacer + Text pair. Before the first
 * message the header expanding is the feedback, and the line would sit wedged under it, so drop it
 * there. Every other status line stays; they are told apart by Text's private `text` field.
 * Returns false once the conversation has started.
 */
function dropToolOutputStatus(below: Node[]): boolean {
  const chat = below[1] as Container | undefined;
  if (!chat) return false;
  const c = chat.children;
  let i = 0;
  while (c[i] instanceof Spacer && c[i + 1] instanceof Text) {
    // pi's ThemedText fills `text` from `build` only when it renders, after the header. Its status
    // lines all build from pi's latest status, so only a line not rendered yet reads `build`.
    const t = c[i + 1] as unknown as { text: string; build?: () => string };
    const text = t.text || t.build?.() || "";
    if (text.includes("Tool output: ")) c.splice(i, 2);
    else i += 2;
  }
  return i === c.length;
}

/** What follows the header in pi's document (header, loaded resources, chat). */
function containersBelow(tui: Node, header: Node): Node[] {
  const headerContainer = parentOf(tui, header);
  const document = headerContainer && parentOf(tui, headerContainer);
  return document?.children?.slice(document.children.indexOf(headerContainer!) + 1) ?? [];
}

/** Blank lines (up to rows) the content below the header starts with: a spacer, or a block's own. */
function leadingBlanks(below: Node[], width: number, rows: number): number {
  let n = 0;
  for (const container of below)
    for (const child of container.children ?? [])
      for (const line of (child as unknown as Container).render(width)) {
        if (n === rows || visibleWidth(line.replaceAll(" ", ""))) return n;
        n++;
      }
  return n;
}

const configPath = () => join(getAgentDir(), "extensions", "pi-header.json");

/** The parsed config file: {} when missing, undefined when it isn't a JSON object. */
function parseConfig(): { logo?: string; compact?: boolean } | undefined {
  let text: string;
  try {
    text = readFileSync(configPath(), "utf8");
  } catch {
    return {};
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const readConfig = () => parseConfig() ?? {};

/** Persist the logo toggle into the config file, keeping any other keys. */
function saveLogo(white: boolean) {
  try {
    const current = parseConfig();
    if (!current) return; // broken config: don't overwrite it, the toggle applies to this session
    mkdirSync(dirname(configPath()), { recursive: true });
    const config = { ...current, logo: white ? "white" : "color" };
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
  } catch {} // unwritable config: the toggle still applies to this session
}

export default function (pi: ExtensionAPI) {
  let res: Resources = { context: [], skills: [], prompts: [], extensions: [], themes: [] };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const config = readConfig();
    let white = config.logo === "white";
    const compact = config.compact === true;
    const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    // pi 1.0's quietStartup "header" still shows the header (and its blank rows).
    const quiet = !process.argv.includes("--verbose") && settingsManager.getQuietStartup() === true;
    res = readResources(pi, ctx, []);
    let expanded = false;
    let piExpanded: boolean | undefined; // pi's ctrl+o state, which a click doesn't change
    let shown: string[] = []; // the last rendered lines, to tell text rows from blank ones
    let below: Node[] = [];
    let requestRender = () => {};
    // Until the first message (resumed sessions start with their history).
    let fresh = !ctx.sessionManager.getEntries().some((e) => e.type === "message");

    ctx.ui.setHeader((tui) => {
      requestRender = () => tui.requestRender();
      const header = {
        // pi calls this with its current state when the header is created or reloaded, and with the
        // new state on ctrl+o. A click may have flipped the header since, so ctrl+o flips it too.
        setExpanded(value: boolean) {
          expanded = piExpanded === undefined || value === piExpanded ? value : !expanded;
          piExpanded = value;
        },
        invalidate() {},
        // Mouse events only arrive in fullscreen TUI mode; x/y are relative to the header.
        handleMouse(event: { type: string; button: string; x: number; y: number }) {
          if (event.type !== "click" || event.button !== "left") return undefined;
          const top = topRows(compact, quiet);
          const logo = renderLogo(white, compact, ctx.ui.theme.getColorMode());
          const onLogo = event.y >= top && event.y < top + logo.lines.length;
          if (onLogo && event.x < logo.column) {
            white = !white;
            saveLogo(white);
          } else if (visibleWidth(shown[event.y] ?? "")) expanded = !expanded;
          else return undefined; // the blank rows around it
          return { handled: true };
        },
        render: (width: number) => {
          // The header renders before the chat, so dropped lines never reach the screen.
          below = below.length ? below : containersBelow(tui, header);
          if (fresh) fresh = dropToolOutputStatus(below);
          const blanks = leadingBlanks(below, width, rowsFor(compact));
          shown = render(ctx.ui.theme, res, expanded, white, compact, quiet, width, blanks).map(
            (l) => cut(l, width),
          );
          return shown;
        },
      };
      return header;
    });

    // Re-read once extensions resolve, which also picks up skills added by resources_discover.
    resolveExtensions(ctx, settingsManager)
      .then((extensions) => {
        res = readResources(pi, ctx, extensions);
        requestRender();
      })
      .catch(() => {}); // session was replaced meanwhile
  });

  // Full paths, printed like /hotkeys. A session entry is an extension's only way into the
  // transcript; it is never sent to the model, and the renderer skips entries from before this load,
  // so like /hotkeys it is gone after a restart or /reload.
  const loadedAt = Date.now();
  pi.registerCommand("loaded", {
    description:
      "Show loaded context files, skills, prompts, extensions, and themes with full paths",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return; // the list is read in TUI mode only, and only the TUI renders it
      const sections = SECTIONS.filter((s) => res[s].length).map((s) => [
        s,
        res[s].map((i) => tilde(i.path)),
      ]);
      pi.appendEntry("pi-header-loaded", { sections });
    },
  });

  pi.registerEntryRenderer("pi-header-loaded", (entry, _options, theme) => {
    if (Date.parse(entry.timestamp) < loadedAt) return undefined;
    const { sections } = entry.data as { sections: [string, string[]][] };
    const markdown = sections
      .map(
        ([s, paths]) =>
          `**${s[0].toUpperCase()}${s.slice(1)}**\n\n${paths.map((p) => `- \`${p}\``).join("\n")}`,
      )
      .join("\n\n");
    const box = new Container(); // pi's entry wrapper spaces it from the chat
    box.addChild(new DynamicBorder());
    box.addChild(new Text(theme.bold(theme.fg("accent", "Loaded Resources")), 1, 0));
    box.addChild(new Spacer(1));
    box.addChild(new Markdown(markdown, 1, 1, getMarkdownTheme()));
    box.addChild(new DynamicBorder());
    return box;
  });
}
