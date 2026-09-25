/**
 * pi-header: minimal startup header with the official pi logo.
 * Collapsed shows resource counts; ctrl+o expands the lists; /loaded prints full paths.
 * Clicking the logo (fullscreen TUI mode) toggles color/white and saves the choice; clicking the
 * text expands or collapses the header, like ctrl+o.
 * Status lines pi posts before the first message are hidden so nothing sits under the header.
 *
 * Config (optional): ~/.pi/agent/extensions/pi-header.json  →  { "logo": "color" | "white" }
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
  Container,
  getCellDimensions,
  Markdown,
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
const ROWS = 2; // blank rows above/below (whole rows only; 2 is closest to SPACING)
const SECTIONS = ["context", "skills", "prompts", "extensions", "themes"] as const;
type Resources = Record<(typeof SECTIONS)[number], { name: string; path: string }[]>;

const fg = (c: RGB) => `\x1b[38;2;${c.join(";")}m`;
const bg = (c: RGB) => `\x1b[48;2;${c.join(";")}m`;

/**
 * Each logo pixel is one row tall and exactly one cell-height wide (measured via
 * pi-tui's cell size), with edges placed in 1/8 cells. SPACING logo pixels of space
 * on each side. Returns lines padded to the text column.
 */
function renderLogo(white: boolean) {
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
      else if (l === r) line += `${fg(l!)}█\x1b[39m`;
      else if (!r) line += `${fg(l!)}${glyph}\x1b[39m`;
      else if (!l) line += `\x1b[7m${fg(r)}${glyph}\x1b[27;39m`; // reverse: glyph takes the terminal background
      else line += `${fg(l)}${bg(r)}${glyph}\x1b[39;49m`;
    }
    return line;
  });
  return { lines, pad: Math.floor(offset / 8), column };
}

function render(
  theme: Theme,
  res: Resources,
  expanded: boolean,
  white: boolean,
  quiet: boolean,
  width: number,
): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const muted = (s: string) => theme.fg("muted", s);
  const dot = dim(" · ");
  const key = (id: string) => keyText(id).replace("escape", "esc");
  const hint = (pairs: string[][]) => pairs.map(([k, d]) => `${muted(k)} ${dim(d)}`).join(dot);

  const hints = hint([
    [key("app.interrupt"), "interrupt"],
    ["/", "commands"],
    ["!", "bash"],
    [key("app.tools.expand"), expanded ? "collapse" : "expand"],
  ]);
  const counts = SECTIONS.filter((s) => res[s].length)
    .map(
      (s) =>
        `${theme.fg("text", String(res[s].length))} ${dim(res[s].length === 1 ? s.replace(/s$/, "") : s)}`,
    )
    .join(dot);

  const logo = renderLogo(white);
  const info = [theme.bold("pi") + dim(` v${VERSION}`), hints, "", counts];
  // Without quietStartup pi adds a blank row above the header and two below (after it, and before [Context]).
  const top = Array<string>(quiet ? ROWS : ROWS - 1).fill("");
  const bottom = Array<string>(quiet ? ROWS : ROWS - 2).fill("");
  const out = [...top, ...logo.lines.map((line, i) => line + info[i])];
  if (!expanded) return [...out, ...bottom];

  // Lists: label under the logo, items in the text column, packed so " · " never ends a line.
  out.push(...Array<string>(ROWS).fill(""));
  for (const s of SECTIONS) {
    const lines: string[] = [];
    for (const item of res[s].map((i) => dim(i.name))) {
      const last = lines.at(-1);
      if (last !== undefined && visibleWidth(last + dot + item) <= width - logo.column)
        lines[lines.length - 1] += dot + item;
      else lines.push(item);
    }
    lines.forEach((line, i) =>
      out.push(
        (i
          ? " ".repeat(logo.column)
          : " ".repeat(logo.pad) + muted(s.padEnd(logo.column - logo.pad - 1)) + " ") + line,
      ),
    );
  }
  out.push(
    "",
    " ".repeat(logo.column) +
      hint([
        ["/hotkeys", "all shortcuts"],
        ["/loaded", "full paths"],
      ]),
  );
  return [...out, ...bottom];
}

const tilde = (path: string) =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
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
async function resolveExtensions(ctx: ExtensionContext): Promise<string[]> {
  const argv = process.argv;
  const paths = argv.flatMap((a, i) =>
    (a === "-e" || a === "--extension") && argv[i + 1] ? [resolve(ctx.cwd, argv[i + 1])] : [],
  );
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const resolved = await new DefaultPackageManager({
    cwd: ctx.cwd,
    agentDir,
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
 * pi posts status lines ("Thinking level: xhigh", "Tool output: collapsed", …) to the chat as a
 * Spacer + Text pair. Before the first message they would sit wedged under the header, so drop them
 * there; errors and warnings (same shape) stay. Returns false once the conversation has started.
 * ponytail: relies on pi's layout (document = [header, loaded resources, chat]) and Text's private
 * `text` field; a no-op if the layout changes.
 */
function dropEarlyStatuses(tui: Node, header: Node): boolean {
  const headerContainer = parentOf(tui, header);
  const document = headerContainer && parentOf(tui, headerContainer);
  const chat = document?.children?.[document.children.indexOf(headerContainer!) + 2] as
    | Container
    | undefined;
  if (!chat) return false;
  const c = chat.children;
  let i = 0;
  while (c[i] instanceof Spacer && c[i + 1] instanceof Text) {
    const text = (c[i + 1] as unknown as { text: string }).text;
    if (/(Error|Warning): /.test(text)) i += 2;
    else c.splice(i, 2);
  }
  return i === c.length;
}

const configPath = () => join(getAgentDir(), "extensions", "pi-header.json");

function readConfig(): { logo?: string } {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

/** Persist the logo toggle into the config file, keeping any other keys. */
function saveLogo(white: boolean) {
  try {
    mkdirSync(dirname(configPath()), { recursive: true });
    const config = { ...readConfig(), logo: white ? "white" : "color" };
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
  } catch {} // unwritable config: the toggle still applies to this session
}

export default function (pi: ExtensionAPI) {
  let res: Resources = { context: [], skills: [], prompts: [], extensions: [], themes: [] };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    let white = readConfig().logo === "white";
    const quiet =
      !process.argv.includes("--verbose") &&
      SettingsManager.create(ctx.cwd, getAgentDir(), {
        projectTrusted: ctx.isProjectTrusted(),
      }).getQuietStartup();
    res = readResources(pi, ctx, []);
    let expanded = false;
    let shown: string[] = []; // the last rendered lines, to tell text rows from blank ones
    let requestRender = () => {};
    // Until the first message (resumed sessions start with their history).
    let fresh = !ctx.sessionManager.getEntries().some((e) => e.type === "message");

    ctx.ui.setHeader((tui) => {
      requestRender = () => tui.requestRender();
      const header = {
        setExpanded(value: boolean) {
          expanded = value; // pi calls this on ctrl+o, then renders
        },
        invalidate() {},
        // Mouse events only arrive in fullscreen TUI mode; x/y are relative to the header.
        handleMouse(event: { type: string; button: string; x: number; y: number }) {
          if (event.type !== "click" || event.button !== "left") return undefined;
          const top = quiet ? ROWS : ROWS - 1;
          const onLogo = event.y >= top && event.y < top + LOGO.length;
          if (onLogo && event.x < renderLogo(white).column) {
            white = !white;
            saveLogo(white);
          } else if (visibleWidth(shown[event.y] ?? "")) expanded = !expanded;
          else return undefined; // the blank rows around it
          return { handled: true };
        },
        render: (width: number) => {
          // The header renders before the chat, so dropped lines never reach the screen.
          if (fresh) fresh = dropEarlyStatuses(tui, header);
          shown = render(ctx.ui.theme, res, expanded, white, quiet, width).map((l) =>
            truncateToWidth(l, width),
          );
          return shown;
        },
      };
      return header;
    });

    // ponytail: one re-read when extensions resolve; also picks up skills added by resources_discover.
    resolveExtensions(ctx)
      .then((extensions) => {
        res = readResources(pi, ctx, extensions);
        requestRender();
      })
      .catch(() => {}); // session was replaced meanwhile
  });

  // Full paths, printed into the transcript like /hotkeys. Saved in the session (the only way into
  // the transcript) but never sent to the model, and, like /hotkeys, gone from a resumed or
  // reloaded session: the renderer skips entries from before this extension loaded.
  const loadedAt = Date.now();
  pi.registerCommand("loaded", {
    description:
      "Show loaded context files, skills, prompts, extensions, and themes with full paths",
    handler: async () => {
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
