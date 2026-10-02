/** The herdr socket API, and the dedicated herdr session that runs agents started hidden. */

import { spawn } from "node:child_process";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const SESSION = "pi-herd"; // the dedicated herdr session for agents started hidden
export const HIDDEN = join(homedir(), ".config", "herdr", "sessions", SESSION, "herdr.sock");
export const PLUGIN = "pi-hkandala"; // the repo's herdr plugin (herdr/plugin/)

export const parseLine = (line: string) => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** One request to a herdr socket; resolves with its result, rejects with herdr's error. */
export function rpc(
  socket: string,
  method: string,
  params: object = {},
  timeout = 5000,
): Promise<any> {
  return new Promise((ok, fail) => {
    const s = net.createConnection(socket);
    let buf = "";
    const done = (err?: Error, result?: unknown) => {
      clearTimeout(timer);
      s.destroy();
      if (err) fail(err);
      else ok(result);
    };
    const timer = setTimeout(() => done(new Error(`herdr ${method}: timed out`)), timeout);
    s.on("connect", () => s.write(`${JSON.stringify({ id: "pi-herd", method, params })}\n`));
    s.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const res = parseLine(buf.slice(0, buf.indexOf("\n")));
      if (!res) return done(new Error(`herdr ${method}: bad response`));
      if (!res.error) return done(undefined, res.result);
      done(Object.assign(new Error(res.error.message), { code: res.error.code }));
    });
    s.on("error", (err) => done(err));
  });
}

/** Starts the dedicated herdr session's server if it isn't running (spec section 7). */
export async function ensureServer() {
  if (await rpc(HIDDEN, "ping").then(Boolean, () => false)) return;
  const env: NodeJS.ProcessEnv = {};
  for (const k of ["HOME", "USER", "PATH", "SHELL", "TERM", "LANG", "TMPDIR"])
    if (process.env[k]) env[k] = process.env[k];
  spawn("herdr", ["--session", SESSION, "server"], {
    detached: true,
    stdio: "ignore",
    env,
  })
    .on("error", () => {}) // herdr not on PATH: the ping loop below reports it
    .unref();
  for (let t = Date.now(); Date.now() - t < 5000; await new Promise((r) => setTimeout(r, 100)))
    if (await rpc(HIDDEN, "ping").then(Boolean, () => false)) return;
  throw new Error(`herdr session ${SESSION} didn't start within 5 s`);
}
