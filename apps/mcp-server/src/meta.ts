// Package identity and bundled assets. Works both from source (tsx, src/*.ts) and from the published
// bundle (dist/cli.js), since both sit one level below the package's package.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
