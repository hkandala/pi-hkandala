/**
 * pi-header: minimal startup header with pi's own logo.
 * Collapsed shows the version and resource counts; ctrl+o expands the resource lists; /loaded
 * prints full paths.
 * Clicking the logo (fullscreen TUI mode) plays pi's 3D logo animation; clicking the text expands
 * or collapses the header, like ctrl+o.
 * Before the first message, pi's "Tool output: …" line for ctrl+o is hidden (the header expanding
 * is the feedback); every other status line and notice shows.
 *
 * Pair with "quietStartup": "header" in ~/.pi/agent/settings.json to hide pi's built-in listing
 * (with true, pi has no logo animation to borrow).
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  DefaultPackageManager,
  DynamicBorder,
  getAgentDir,
  getMarkdownTheme,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi,
  Container,
  foregroundAnsi,
  Markdown,
  mixColors,
  rgbColor,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";

const SECTIONS = ["context", "skills", "prompts", "extensions", "themes"] as const;
type Resources = Record<(typeof SECTIONS)[number], { name: string; path: string }[]>;
const PAD = 3; // columns left and right of the logo: the left lines it up with the transcript's text
const ROWS = 2; // blank rows above and below
// Unless quietStartup is true, pi adds a blank row above the header and one below it.
const topRows = (quiet: boolean) => ROWS - (quiet ? 0 : 1);

/**
 * pi's own header logo, which its 3D logo animation starts from (pi doesn't export it): 4 cells
 * wide and 2 rows tall, PAD columns on each side, so the text starts at COLUMN.
 */
const COLUMN = 4 + 2 * PAD;
const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);
function renderLogo(mode: ReturnType<Theme["getColorMode"]>) {
  const fg = (c: typeof CORAL) => foregroundAnsi(c, mode);
  const R = "\x1b[0m";
  const top = `${fg(CORAL)}${backgroundAnsi(BLUE, mode)}▀${R}${fg(CORAL)}▀█${R} `;
  const bottom = `${fg(BLUE)}█▀${R} ${fg(YELLOW)}█${R}`;
  const pad = " ".repeat(PAD);
  return [pad + top + pad, pad + bottom + pad];
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
  quiet: boolean,
  width: number,
  blanksBelow: number,
): string[] {
  const gray = soft(theme);
  const dot = theme.fg("dim", " · ");
  const counts = SECTIONS.filter((s) => res[s].length)
    .map((s) => gray(`${res[s].length} ${res[s].length === 1 ? s.replace(/s$/, "") : s}`))
    .join(dot);

  const info = [gray(`v${VERSION}`), counts];
  // Blank lines the content below already starts with count toward the gap.
  const top = Array<string>(topRows(quiet)).fill("");
  const bottom = Array<string>(Math.max(0, topRows(quiet) - blanksBelow)).fill("");
  const out = [...top, ...renderLogo(theme.getColorMode()).map((line, i) => line + info[i])];
  if (!expanded) return [...out, ...bottom];

  // Lists: label under the logo, items in the text column (wider if a label needs it), packed so
  // " · " never ends a line.
  const column = Math.max(COLUMN, PAD + Math.max(...SECTIONS.map((s) => s.length)) + 1);
  out.push(...Array<string>(ROWS).fill("")); // as far from the logo as the rows around it
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
        (i ? " ".repeat(column) : " ".repeat(PAD) + gray(s.padEnd(column - PAD - 1)) + " ") + line,
      ),
    );
  }
  out.push(
    "",
    " ".repeat(PAD) + gray("/hotkeys for all shortcuts") + dot + gray("/loaded for full paths"),
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
type LogoClick = (column: number, row: number) => void;

/**
 * pi's built-in header plays the 3D logo animation on a logo click, but pi doesn't export it. Our
 * header factory runs before ours replaces that header, so borrow its handler from the tree (after
 * /reload, from the previous pi-header, which keeps it as `onLogoClick` too).
 */
const findLogoClick = (node: Node): LogoClick | undefined => {
  const own = (node as { onLogoClick?: unknown }).onLogoClick;
  if (typeof own === "function") return own as LogoClick;
  for (const child of node.children ?? []) {
    const found = findLogoClick(child);
    if (found) return found;
  }
  return undefined;
};
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

export default function (pi: ExtensionAPI) {
  let res: Resources = { context: [], skills: [], prompts: [], extensions: [], themes: [] };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
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
      const onLogoClick = findLogoClick(tui as Node);
      const header = {
        onLogoClick,
        // pi calls this with its current state when the header is created or reloaded, and with the
        // new state on ctrl+o. A click may have flipped the header since, so ctrl+o flips it too.
        setExpanded(value: boolean) {
          expanded = piExpanded === undefined || value === piExpanded ? value : !expanded;
          piExpanded = value;
        },
        invalidate() {},
        // Mouse events only arrive in fullscreen TUI mode; x/y are relative to the header.
        handleMouse(event: {
          type: string;
          button: string;
          x: number;
          y: number;
          screenX: number;
          screenY: number;
        }) {
          if (event.type !== "click" || event.button !== "left") return undefined;
          const top = topRows(quiet);
          // The logo's 4 cells, from column PAD, in its 2 rows.
          if (event.y >= top && event.y < top + 2 && event.x < COLUMN) {
            const onLogo = event.x >= PAD && event.x < PAD + 4;
            if (!onLogo || !onLogoClick) return undefined; // quietStartup: true or Apple Terminal: pi has no animation
            onLogoClick(event.screenX - event.x + PAD, event.screenY - event.y + top); // the logo's screen cell
          } else if (visibleWidth(shown[event.y] ?? "")) expanded = !expanded;
          else return undefined; // the blank rows around it
          return { handled: true };
        },
        render: (width: number) => {
          // The header renders before the chat, so dropped lines never reach the screen.
          below = below.length ? below : containersBelow(tui, header);
          if (fresh) fresh = dropToolOutputStatus(below);
          const blanks = leadingBlanks(below, width, ROWS);
          shown = render(ctx.ui.theme, res, expanded, quiet, width, blanks).map((l) =>
            cut(l, width),
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
