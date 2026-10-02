/**
 * Code in open tool rows: colored by pi's own highlighter, in the theme's syntax colors, like code
 * blocks in assistant text. An edit's diff highlights each side whole, so multi-line strings and
 * comments keep their colors, then tints its lines with the theme's tool backgrounds, and the
 * changed words of a changed line with a stronger tint.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, mixColors } from "@earendil-works/pi-tui";

export const untab = (s: string) => s.replace(/\t/g, "   ");

/** Lines of `code` colored as `lang`, or in the text color without one. */
export function highlighted(code: string, lang: string | undefined, theme: Theme): string[] {
  if (!lang) return code.split("\n").map((l) => theme.fg("text", l));
  // pi splits the colored text into lines as is: a token across lines (a block comment, a template
  // string) needs its color reopened on each.
  let open = "";
  return highlightCode(code, lang).map((l) => {
    const line = open + l;
    // oxlint-disable-next-line no-control-regex
    const last = line.match(/\x1b\[(?:38;[\d;]*|39)m/g)?.at(-1) ?? "";
    open = last.startsWith("\x1b[38") ? last : "";
    return line;
  });
}

/** Code lines numbered from `first`, like a diff's unchanged lines (a blank sign column). */
export function numbered(lines: string[], first: number, theme: Theme): string[] {
  const width = String(first + lines.length - 1).length;
  return lines.map((l, i) => ` ${theme.fg("dim", String(first + i).padStart(width))} ${l}`);
}

/** Background codes for added and removed lines, and a stronger one for their changed words. */
function tints(theme: Theme) {
  const tint = (bg: "toolSuccessBg" | "toolErrorBg", fg: "toolDiffAdded" | "toolDiffRemoved") => {
    const line = theme.getBgAnsi(bg);
    // No line tint (the terminal's own background): no word tint either.
    if (line === "\x1b[49m") return { line, word: line };
    const word = mixColors(theme.colors[bg], theme.colors[fg], 0.25, "srgb");
    return { line, word: backgroundAnsi(word, theme.getColorMode()) };
  };
  return {
    "+": tint("toolSuccessBg", "toolDiffAdded"),
    "-": tint("toolErrorBg", "toolDiffRemoved"),
  };
}

/** Ranges of `a` not in `b`, by words, spaces, and punctuation; none when most of `a` changed. */
function changed(a: string, b: string): [number, number][] {
  const [x, y] = [a, b].map((s) => s.match(/\w+|\s+|[^\w\s]/g) ?? []) as [string[], string[]];
  if (x.length * y.length > 250_000) return [];
  // Longest common subsequence of tokens, walked forward.
  const lcs = Array.from({ length: x.length + 1 }, () => Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i]![j] =
        x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: [number, number][] = [];
  let [i, j, col, total] = [0, 0, 0, 0];
  while (i < x.length) {
    if (x[i] === y[j]) j++; // in both
    else if (j < y.length && lcs[i]![j + 1]! >= lcs[i + 1]![j]!) {
      j++; // only in b
      continue;
    } else {
      // only in a
      const last = out.at(-1);
      if (last?.[1] === col) last[1] += x[i]!.length;
      else out.push([col, col + x[i]!.length]);
      total += x[i]!.length;
    }
    col += x[i++]!.length;
  }
  return total > a.trim().length * 0.6 ? [] : out;
}

/** `s` with `on` and `off` around the given ranges of its visible characters. */
function emphasize(s: string, ranges: [number, number][], on: string, off: string): string {
  let [out, col] = ["", 0];
  // oxlint-disable-next-line no-control-regex
  for (const [, code, ch] of s.matchAll(/(\x1b\[[\d;]*m)|([\s\S])/g)) {
    if (code) out += code;
    else {
      if (ranges.some(([a]) => a === col)) out += on;
      out += ch;
      col++;
      if (ranges.some(([, b]) => b === col)) out += off;
    }
  }
  return out;
}

type DiffRow = { sign: string; num: string; text: string } | undefined; // undefined: a gap
/** An edit's diff, from pi's "+12 code" lines ("..." marks skipped lines; only gaps are kept). */
export function diffOf(diff: string, lang: string | undefined, theme: Theme): string[] {
  const rows: DiffRow[] = diff
    .replace(/^\s*\.\.\.\n|\n\s*\.\.\.$/g, "")
    .split("\n")
    .map((l) => {
      const m = /^([+\- ])(\s*\d+) (.*)$/.exec(l);
      return m ? { sign: m[1]!, num: m[2]!, text: untab(m[3]!) } : undefined;
    });
  const side = (skip: string) => {
    const kept = rows.filter((row) => row && row.sign !== skip);
    const lines = highlighted(kept.map((row) => row!.text).join("\n"), lang, theme);
    return new Map(kept.map((row, i) => [row, lines[i] ?? ""]));
  };
  const [before, after, tint] = [side("+"), side("-"), tints(theme)];
  const line = (row: NonNullable<DiffRow>, other?: DiffRow) => {
    const code = (row.sign === "+" ? after : before).get(row)!;
    const num = theme.fg("dim", row.num);
    if (row.sign === " ") return ` ${num} ${code}`;
    const t = tint[row.sign as "+" | "-"];
    const sign = theme.fg(row.sign === "+" ? "toolDiffAdded" : "toolDiffRemoved", row.sign);
    const marks = other ? changed(row.text, other.text) : [];
    // The tint stays open to the line's end: groupLines pads it across the row.
    return `${t.line}${sign}${num} ${marks.length ? emphasize(code, marks, t.word, t.line) : code}`;
  };
  const out: string[] = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row?.sign !== "-") {
      out.push(row ? line(row) : theme.fg("dim", "  ⋮"));
      i++;
      continue;
    }
    // Removed lines, then added ones: paired line by line for word marks when the counts match.
    let j = i;
    while (rows[j]?.sign === "-") j++;
    let k = j;
    while (rows[k]?.sign === "+") k++;
    const paired = j - i === k - j;
    for (let n = i; n < k; n++)
      out.push(line(rows[n]!, paired ? rows[n < j ? n + j - i : n - j + i] : undefined));
    i = k;
  }
  return out;
}
