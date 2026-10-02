/** Git state for the footer, read with plain git commands (no daemons, no locks, no prompts). */
import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const MAX_UNTRACKED_BYTES = 1_000_000; // untracked files larger than this count as 0 lines
const MAX_UNTRACKED_FILES = 500; // untracked files counted; the rest count as 0 lines

export type Git = {
  repo?: string; // owner/repo (the whole path) from a network origin, a local origin's folder name, else the main checkout's
  url?: string; // https://host/owner/repo, credentials never included
  worktree: boolean; // cwd is a linked worktree
  worktrees: string[]; // all checkouts, main first
  current: string;
  upstream?: string;
  ahead: number;
  behind: number;
  fetchedAt?: number;
  commit?: string;
  commitAge?: string;
  files: { status: string }[]; // A added, ? untracked, D deleted, else modified
  added: number;
  removed: number;
};

export const EMPTY_GIT: Git = {
  worktree: false,
  worktrees: [],
  current: "",
  ahead: 0,
  behind: 0,
  files: [],
  added: 0,
  removed: 0,
};

/** Line counts of untracked files by path, with the size and mtime they were counted at. */
let counted = new Map<string, { key: string; lines: number }>();

/** Lines in an untracked text file (binary or huge files count as 0), reread only once it changes. */
async function countLines(path: string, next: typeof counted): Promise<number> {
  try {
    const fh = await open(path);
    try {
      const { size, mtimeMs } = await fh.stat();
      const key = `${size}:${mtimeMs}`;
      const known = counted.get(path);
      let n = 0;
      if (known?.key === key) n = known.lines;
      else if (size <= MAX_UNTRACKED_BYTES) {
        const buf = await fh.readFile();
        if (!buf.includes(0)) {
          for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) n++;
          if (buf.length && buf[buf.length - 1] !== 10) n++;
        }
      }
      next.set(path, { key, lines: n });
      return n;
    } finally {
      await fh.close();
    }
  } catch {
    return 0;
  }
}

const exec = promisify(execFile);
// fsmonitor off and no optional locks: never run repo daemons or contend with the user's git.
// quotePath off: non-ASCII paths come back as they are, not C-quoted.
export const git = (
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeout = 5000,
) =>
  exec("git", ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", ...args], {
    cwd,
    timeout,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
    maxBuffer: 10_000_000,
  }).then(
    (r) => r.stdout,
    () => "",
  );

export async function readGit(cwd: string): Promise<Git> {
  const [dirs, status, numstat, log, origin, worktrees] = await Promise.all([
    git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--show-toplevel",
    ]),
    git(cwd, [
      "-c",
      "status.relativePaths=false",
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=all",
    ]),
    git(cwd, ["diff", "HEAD", "--numstat"]),
    git(cwd, ["log", "-1", "--format=%h %s%x00%cr"]),
    git(cwd, ["remote", "get-url", "origin"]),
    git(cwd, ["worktree", "list", "--porcelain"]),
  ]);
  const [gitDir, commonDir, top] = dirs.trim().split("\n");
  if (!top) return EMPTY_GIT;

  const g: Git = {
    ...EMPTY_GIT,
    files: [],
    current: basename(top),
    worktree: gitDir !== commonDir,
  };
  for (const line of numstat.split("\n")) {
    const [a, r, path] = line.split("\t"); // binary files show "-"
    if (!path) continue;
    g.added += Number(a) || 0;
    g.removed += Number(r) || 0;
  }
  const untracked: string[] = [];
  for (const line of status.split("\n")) {
    const f = line.split(" ");
    if (line.startsWith("# branch.upstream ")) g.upstream = f[2];
    else if (line.startsWith("# branch.ab "))
      [g.ahead, g.behind] = [Math.abs(+f[2]), Math.abs(+f[3])];
    else if (line.startsWith("? ")) untracked.push(line.slice(2));
    else if (/^[12u] /.test(line)) g.files.push({ status: f[1][0] !== "." ? f[1][0] : f[1][1] });
  }
  const next: typeof counted = new Map();
  const lines = await Promise.all(
    untracked.slice(0, MAX_UNTRACKED_FILES).map((p) => countLines(join(top, p), next)),
  );
  counted = next;
  for (const n of lines) g.added += n;
  g.files.push(...untracked.map(() => ({ status: "?" })));

  const url = origin.trim().replace(/\.git$/, "");
  // Network remotes (scheme:// or user@host:path) get a browsable URL; local-path remotes just a name.
  if (/^\w+:\/\/|^[^/@]+@[^/:]+:/.test(url) && !url.startsWith("file:")) {
    // The whole path after the host (and port), so nested groups (group/sub/repo) stay.
    const m = url.match(/^(?:\w+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+(?=\/))?[:/]+(.+)$/);
    g.repo = m?.[2].replace(/\/+$/, "") || undefined;
    if (m && g.repo) g.url = `https://${m[1]}/${g.repo}`;
  } else if (url) g.repo = basename(url);
  g.worktrees = [...worktrees.matchAll(/^worktree (.+)$/gm)].map(([, p]) => basename(p));
  g.repo ??= g.worktrees[0] ?? g.current;
  const [commit, age] = log.trim().split("\0");
  if (commit) [g.commit, g.commitAge] = [commit, age];
  g.fetchedAt = await stat(join(commonDir, "FETCH_HEAD")).then(
    (s) => s.mtimeMs,
    () => undefined,
  );
  return g;
}
