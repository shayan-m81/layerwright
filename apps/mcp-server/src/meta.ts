// Package identity and bundled assets. Works both from source (tsx, src/*.ts) and from the published
// bundle (dist/cli.js), since both sit one level below the package's package.json.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { name: string; version: string; bin?: Record<string, string> };

export const PKG_NAME = pkg.name;
export const PKG_VERSION = pkg.version;
/** Short command / MCP server name (the first bin entry). */
export const BIN = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.replace(/^@[^/]+\//, "");
export const MIN_NODE = 20;

/** The project this server works for: LAYERWRIGHT_WORKDIR (the Claude Code plugin sets it to the project root), else
 *  the folder it was started in (Claude Code and Codex start servers in the project). */
export function projectDir(): string {
  const w = process.env.LAYERWRIGHT_WORKDIR;
  return w && !w.includes("${") ? resolve(w) : process.cwd();
}

/** Has Layerwright been set up or used in this project? Its `.layerwright/` folder (init makes it, the server keeps
 *  its memory and mappings there; `.design-engineer/` is the old name). Sessions in such a project join the Figma
 *  connection at once; anywhere else a session joins on its first Figma call, so the plugin window doesn't list every
 *  Claude Code session on the computer (the agent plugin is installed for all of them). The home folder's own
 *  ~/.layerwright doesn't count. */
export function projectUsesLayerwright(dir = projectDir()): boolean {
  const home = layerwrightHome();
  return [".layerwright", ".design-engineer"].some((d) => { const p = resolve(dir, d); return !samePath(p, home) && existsSync(p); });
}
/** The same folder? Windows paths ignore case (VS Code may give "c:\\…" for "C:\\…"). */
function samePath(a: string, b: string) { return relative(resolve(a), resolve(b)) === ""; }

/** Mark this project as one that uses Layerwright (see projectUsesLayerwright). Never throws. */
export function markProject(dir = projectDir()): void {
  const p = resolve(dir, ".layerwright");
  if (samePath(p, layerwrightHome())) return;
  try { mkdirSync(p, { recursive: true }); } catch { /* read-only folder: it joins on first use again next time */ }
}

/** True when running from a git checkout (TypeScript sources) rather than the published bundle. */
export const FROM_SOURCE = here.endsWith(`${"src"}`) && existsSync(resolve(here, "../../../packages/core"));
export const REPO_ROOT = FROM_SOURCE ? resolve(here, "../../..") : undefined;
/** The bundled CLI that is running (dist/cli.js), when this isn't the TypeScript sources. */
export const CLI_FILE = FROM_SOURCE ? undefined : join(here, "cli.js");
/** npx's cache: a copy that can disappear, so nothing should point at it for later. */
export const IN_NPX_CACHE = !!CLI_FILE && /[\\/]_npx[\\/]/.test(CLI_FILE);

/** Built Figma plugin (manifest.json + dist/). */
export function pluginSource(): string {
  if (process.env.LAYERWRIGHT_PLUGIN_SRC) return resolve(process.env.LAYERWRIGHT_PLUGIN_SRC);
  return FROM_SOURCE ? resolve(here, "../../figma-plugin") : join(here, "figma-plugin");
}
/** The agent plugin template (plugins/layer): /layer commands and manifests for Claude Code and Codex. */
export function agentPluginSource(): string {
  return FROM_SOURCE ? resolve(here, "../../../plugins/layer") : join(here, "agent-plugin");
}
export function skillSource(): string {
  return FROM_SOURCE ? resolve(here, "../../../skills/figma-design/SKILL.md") : join(here, "skill", "SKILL.md");
}
/** The skills library that ships with Layerwright (skills/library: catalog.json and one folder per skill). */
export function skillLibrarySource(): string {
  return FROM_SOURCE ? resolve(here, "../../../skills/library") : join(here, "skills-library");
}
/** ~/.layerwright: the plugin, the hub log, the pairing key, the agent plugins, the user's own skills. */
export function layerwrightHome(): string {
  return process.env.LAYERWRIGHT_HOME ?? join(homedir(), `.${BIN}`);
}
/** Stable per-user location for the plugin, so the manifest path Figma remembers survives npx updates. */
export function pluginHome(): string {
  return join(layerwrightHome(), "figma-plugin");
}
/** This computer's pairing key. init writes it into the installed plugin window, which presents it to the hub: only
 *  that window may be the plugin and send requests into sessions (a web page can reach localhost too, but can't read
 *  this file). Sessions present it too when they join the hub. */
export function pluginKey(create = false): string | undefined {
  const file = join(layerwrightHome(), "key");
  const read = () => { try { return readFileSync(file, "utf8").trim() || undefined; } catch { return undefined; } };
  const had = read();
  if (had || !create) return had;
  const k = randomBytes(18).toString("hex");
  try {
    mkdirSync(layerwrightHome(), { recursive: true });
    // Only if nobody made it meanwhile (the hub and a session can both get here first): then theirs is the key.
    writeFileSync(file, k + "\n", { mode: 0o600, flag: "wx" });
    return k;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const theirs = read();
    if (theirs) return theirs;
    writeFileSync(file, k + "\n", { mode: 0o600 }); // an empty file: replace it
    return k;
  }
}
/** Requests from the Figma window for one Claude Code session, waiting for its monitor (layerwright inbox-watch):
 *  ~/.layerwright/inbox/<CLAUDE_CODE_SESSION_ID>.jsonl. Claude Code gives the session id to its MCP servers and its
 *  plugin monitors alike, so both find the same file. */
export function inboxFile(session = process.env.CLAUDE_CODE_SESSION_ID): string | undefined {
  return session && /^[\w-]{6,80}$/.test(session) ? join(layerwrightHome(), "inbox", `${session}.jsonl`) : undefined;
}
/** How long a session may leave Layerwright alone (no Figma call, no request from a Figma window) before it leaves
 *  Figma: the plugin window stops listing it and its watcher (inbox-watch) stops. Its next Figma call joins again. */
export const IDLE_MS = 30 * 60_000;
/** When this Claude Code session last used Layerwright (the file's time), for its watcher:
 *  ~/.layerwright/inbox/<session>.active */
export function activeFile(session = process.env.CLAUDE_CODE_SESSION_ID): string | undefined {
  return session && /^[\w-]{6,80}$/.test(session) ? join(layerwrightHome(), "inbox", `${session}.active`) : undefined;
}
/** Is this session's watcher running? inbox-watch keeps its pid in <inbox file>.lock. */
export function watcherRunning(file = inboxFile()): boolean {
  return !!file && lockHeld(`${file}.lock`);
}
/** How often the watcher touches its lock, and when a lock nobody touched is its owner's leftover. A watcher killed
 *  outright (on Windows always: no signal reaches it) leaves its lock, and Windows soon gives its pid to another
 *  process: the pid alone would keep saying it runs. */
export const LOCK_TOUCH_MS = 5_000, LOCK_STALE_MS = 20_000;
/** A pid lock whose owner is alive and still touches it. */
export function lockHeld(lock: string, except?: number): boolean {
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    if (!pid || pid === except || Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
/** Has Claude Code a Monitor tool here? On Windows it needs Git Bash (Git for Windows), as Claude Code's Bash tool
 *  does: without it a session can't watch for requests, and they reach it with its next Figma call or /layer:inbox. */
export function monitorAvailable(env: NodeJS.ProcessEnv = process.env, platform = process.platform, exists: (path: string) => boolean = existsSync): boolean {
  if (platform !== "win32") return true;
  if (env.CLAUDE_CODE_GIT_BASH_PATH) return exists(env.CLAUDE_CODE_GIT_BASH_PATH);
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")].filter(Boolean) as string[];
  if (roots.some((r) => exists(join(r, "Git", "bin", "bash.exe")))) return true;
  // Git elsewhere: bash.exe sits next to its cmd folder.
  return (env.PATH ?? env.Path ?? "").split(";").some((d) => d && exists(join(d, "git.exe")) && exists(join(d, "..", "bin", "bash.exe")));
}
/** What this Claude Code session is doing in its chat, from the plugin's hooks (layerwright hook-event): it asked the
 *  user a question, needs a permission, or ended its turn. ~/.layerwright/inbox/<session>.state.json */
export function stateFile(session = process.env.CLAUDE_CODE_SESSION_ID): string | undefined {
  return session && /^[\w-]{6,80}$/.test(session) ? join(layerwrightHome(), "inbox", `${session}.state.json`) : undefined;
}
/** The placeholder in the built plugin window that init replaces with the key. */
export const KEY_PLACEHOLDER = "__LAYERWRIGHT_KEY__";
export const DEFAULT_PORT = 7331;
/** The plugin manifest allows only these localhost ports (Figma checks network access against the manifest). */
export const PORT_RANGE = [7331, 7340] as const;
export const portAllowed = (p: number) => Number.isInteger(p) && p >= PORT_RANGE[0] && p <= PORT_RANGE[1];
