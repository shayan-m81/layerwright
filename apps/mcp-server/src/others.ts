// Other Layerwright servers on this computer that can't share Figma. Before 1.0 every session's server owned the
// bridge port alone (no hub): next to a hub it only logs "already in use" and never connects, and nothing tells the
// user why that session can't reach Figma. `doctor` and figma_status look for them and say which project to update.
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

export interface OlderServer { pid: number; version: string; workdir?: string }

/** CLI subcommands: a process running one of them is a tool call, not a session's MCP server. */
const SUBCOMMANDS = new Set(["init", "doctor", "import", "hub", "agents", "report", "inbox-watch", "hook-event", "session-hint", "plugin", "fonts", "claude", "help"]);

/** The package folder of a Layerwright server process, from its command line. */
export function packageDirOf(command: string): string | undefined {
  // npx: …/_npx/<hash>/node_modules/.bin/layerwright · installed: …/node_modules/layerwright/dist/cli.js
  const m = /(\S*\/node_modules)\/(?:\.bin\/layerwright|layerwright\/dist\/cli\.js)(?:\s+(\S+))?/.exec(command);
  if (!m || (m[2] && !m[2].startsWith("-") && SUBCOMMANDS.has(m[2]))) return undefined;
  return `${m[1]}/layerwright`;
}

export interface FindOptions {
  /** `ps -axo pid=,command=` output (tests pass their own). */
  ps?: () => string;
  versionAt?: (pkgDir: string) => string | undefined;
  cwdOf?: (pid: number) => string | undefined;
  self?: number;
}

/** Running Layerwright servers older than 1.0 (single-session), with the folder each runs in. Never throws. */
export function findOlderServers(o: FindOptions = {}): OlderServer[] {
  if (process.platform === "win32" && !o.ps) return [];
  let list = "";
  try { list = (o.ps ?? (() => execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 2000, maxBuffer: 8 << 20 })))(); } catch { return []; }
  const versionAt = o.versionAt ?? ((dir: string) => { try { return String(JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version); } catch { return undefined; } });
  const out: OlderServer[] = [];
  for (const line of list.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === (o.self ?? process.pid)) continue;
    const dir = packageDirOf(m[2]);
    const version = dir && versionAt(dir);
    if (!version || !/^0\./.test(version)) continue;
    out.push({ pid, version, workdir: (o.cwdOf ?? cwdOf)(pid) });
  }
  return out;
}

/** A process's working folder: /proc on Linux, lsof elsewhere (macOS). */
function cwdOf(pid: number): string | undefined {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { /* not Linux */ }
  try {
    const r = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 2000 });
    return r.split("\n").find((l) => l.startsWith("n"))?.slice(1) || undefined;
  } catch { return undefined; }
}

/** One line for the user: who it is and how to fix it. */
export function describeOlder(s: OlderServer, current: string): string {
  const where = s.workdir ? `The session in ${s.workdir}` : `A session (pid ${s.pid})`;
  return `${where} runs Layerwright ${s.version}, which can't share Figma with other sessions: it never connects while this version holds the port. Fix: in that project, change "layerwright@${s.version}" to "layerwright@${current}" in .mcp.json (or run npx layerwright@latest init there), then reconnect it with /mcp.`;
}

let cache: { at: number; list: OlderServer[] } | undefined;
/** findOlderServers, at most once a minute (figma_status is called often). */
export function olderServersCached(o?: FindOptions): OlderServer[] {
  if (!cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), list: findOlderServers(o) };
  return cache.list;
}
