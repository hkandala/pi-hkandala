/** Git state for the footer, read with plain git commands (no daemons, no locks, no prompts). */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const MAX_UNTRACKED_BYTES = 1_000_000; // untracked files larger than this count as 0 lines
const MAX_UNTRACKED_FILES = 500; // untracked files counted; the rest count as 0 lines

type FileChange = { status: string; path: string; added: number; removed: number };
export type Git = {
  repo?: string; // owner/repo from origin, else the main checkout's folder name
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
  files: FileChange[];
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

/** Lines in an untracked text file (binary or huge files count as 0). */
async function countLines(path: string): Promise<number> {
  try {
    const buf = await readFile(path);
    if (buf.length > MAX_UNTRACKED_BYTES || buf.includes(0)) return 0;
    let n = 0;
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) n++;
    return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
  } catch {
    return 0;
  }
}

const exec = promisify(execFile);
// fsmonitor off and no optional locks: never run repo daemons or contend with the user's git.
export const git = (
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeout = 5000,
) =>
  exec("git", ["-c", "core.fsmonitor=false", ...args], {
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

  const lines = new Map<string, [number, number]>();
  for (const line of numstat.split("\n")) {
    const [a, r, path] = line.split("\t"); // binary files show "-"
    if (path) lines.set(path, [Number(a) || 0, Number(r) || 0]);
  }
  const g: Git = {
    ...EMPTY_GIT,
    files: [],
    current: basename(top),
    worktree: gitDir !== commonDir,
  };
  const untracked: FileChange[] = [];
  for (const line of status.split("\n")) {
    const f = line.split(" ");
    if (line.startsWith("# branch.upstream ")) g.upstream = f[2];
    else if (line.startsWith("# branch.ab "))
      [g.ahead, g.behind] = [Math.abs(+f[2]), Math.abs(+f[3])];
    else if (line.startsWith("? "))
      untracked.push({ status: "?", path: line.slice(2), added: 0, removed: 0 });
    else if (/^[12u] /.test(line)) {
      // Renames match numstat by new path only, so their line counts may read 0.
      const path = f
        .slice(f[0] === "1" ? 8 : f[0] === "2" ? 9 : 10)
        .join(" ")
        .split("\t")[0];
      const [added, removed] = lines.get(path) ?? [0, 0];
      g.files.push({ status: f[1][0] !== "." ? f[1][0] : f[1][1], path, added, removed });
    }
  }
  await Promise.all(
    untracked
      .slice(0, MAX_UNTRACKED_FILES)
      .map(async (u) => (u.added = await countLines(join(top, u.path)))),
  );
  g.files.push(...untracked);
  for (const [a, r] of lines.values()) {
    g.added += a;
    g.removed += r;
  }
  for (const u of untracked) g.added += u.added;

  const url = origin.trim().replace(/\.git$/, "");
  // Network remotes (scheme:// or user@host:path) get a browsable URL; local-path remotes just a name.
  if (/^\w+:\/\/|^[^/@]+@[^/:]+:/.test(url) && !url.startsWith("file:")) {
    g.repo = url.match(/[:/]([^/:]+\/[^/:]+)$/)?.[1];
    const host = url.match(/^(?:\w+:\/\/)?(?:[^@/]+@)?([^/:]+)/)?.[1];
    if (host && g.repo) g.url = `https://${host}/${g.repo}`;
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
