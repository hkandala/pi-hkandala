/**
 * pi's full-screen selection copies the screen as drawn. The layout's decoration comes off first:
 * box edges and sides, tree glyphs, bullets, timestamps, and toggle lines. Text wrapped to fit
 * (assistant text, boxes, lone thinking: it starts by column 5) joins back where the next line's
 * first word wouldn't have fit on the line. Tool content (from column 7, under the tree's │ or └:
 * code and output, cut off rather than wrapped) comes out as its own block, dedented, and a diff
 * as its code after the edit.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

type Copied = { line: string; end: number; lead: number; code?: boolean };

/**
 * Selected screen text, starting at column `start` of a `width`-wide screen, as plain text;
 * `reserve`: the columns text gives up for the time column.
 */
export function copied(text: string, start: number, width: number, reserve: number): string {
  const limit = width - 3 - reserve; // where text wraps: the right margin, and the time column
  const kept: Copied[] = [];
  let fence = -1; // the column of an open ``` fence in assistant text
  let tool = false; // in tool content: from a line with the tree's │ or └ until text is back left
  for (let [i, line] of text.split("\n").entries()) {
    if (!i) line = " ".repeat(start) + line; // columns line up with the full lines below
    const t = line.trim();
    const tree = line[3] === "│" || line[5] === "└";
    if (/^[╭╰]/.test(t) || /^[─┄]+.*[╮╯]$/.test(t)) continue; // a box's top or bottom edge
    // A timestamp ends 3 columns from the right, after its dotted leader.
    if (visibleWidth(line) === width - 3) line = line.replace(/ +·(?: ·)* +[^·]*$/, "");
    line = line
      .replace(/\s+[│┆]$/, "") // a box's right side
      .replace(/^[\s│┆├└●]+/, (m) => " ".repeat(m.length)); // box sides, tree, bullets
    if (/^\s*(?:↓ \d+ more lines?|↑ show less)$/.test(line)) continue;
    const end = visibleWidth(line.trimEnd());
    let lead = line.search(/\S/);
    if (t.startsWith("```")) fence = fence < 0 ? lead : -1;
    // pi indents a code block's lines 2 columns past its fence.
    else if (fence >= 0 && lead >= fence + 2)
      [line, lead] = [line.slice(0, fence) + line.slice(fence + 2), lead - 2];
    if (lead >= 0) tool = lead >= 7 && (tool || tree);
    kept.push({ line, end, lead, code: fence < 0 && tool && lead >= 7 });
  }
  const prose = kept.filter((k) => !k.code && k.lead >= 0);
  const indent = prose.length ? Math.min(...prose.map((k) => k.lead)) : 0;
  const out: string[] = [];
  let prev: Copied | undefined;
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i]!;
    if (k.code) {
      // The run of tool content, blank lines inside it included.
      let j = i;
      while (kept[j]?.code || (kept[j]?.lead === -1 && kept[j + 1]?.code)) j++;
      out.push(...codeOf(kept.slice(i, j)));
      [i, prev] = [j - 1, undefined];
      continue;
    }
    const word = k.line.trim().split(/\s/)[0]!;
    const wrapped =
      prev &&
      prev.lead >= 0 &&
      prev.lead <= 5 &&
      !prev.line.trimEnd().endsWith("…") &&
      prev.end + 1 + visibleWidth(word) > limit &&
      k.lead - prev.lead >= 0 &&
      k.lead - prev.lead <= 3 && // a paragraph's or list item's next line
      !/^(?:[-*+]|\d+[.)])\s/.test(k.line.trim()); // not a new list item
    if (wrapped) out[out.length - 1] += ` ${k.line.trim()}`;
    else out.push(k.line.slice(indent).trimEnd());
    prev = k;
  }
  return out.join("\n").replace(/^\n+|\n+$/g, "");
}

/** A run of tool content, dedented; a diff ("+12 code" lines, ⋮ between hunks) as its new code. */
function codeOf(run: Copied[]): string[] {
  const lines = run.map((k) => k.line).filter((l) => l.trim() !== "⋮");
  const dedent = (ls: string[]) => {
    const lead = Math.min(...ls.filter((l) => l.trim()).map((l) => l.search(/\S/)));
    return ls.map((l) => l.slice(lead).trimEnd());
  };
  // A blank line reads as a blank context line.
  const rows = dedent(lines).map((l) => (l ? /^([-+ ])( *\d+) (.*)$/.exec(l) : ["", " ", "", ""]));
  if (!rows.every(Boolean) || !rows.some((m) => m![1] !== " ")) return dedent(lines);
  return dedent(rows.filter((m) => m![1] !== "-").map((m) => m![3]!));
}
