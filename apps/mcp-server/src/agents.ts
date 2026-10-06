// The agent plugins: the /layer:… commands, the MCP server and the figma-design skill, for Claude Code and Codex.
// init builds a local marketplace in ~/.layerwright/agents from plugins/layer, with the server entry for this
// install (a pinned npm version, or this checkout's sources), and registers it with each agent's own CLI:
//   claude plugin marketplace add <dir> · claude plugin install layer@layerwright
//   codex plugin marketplace add <dir>  · codex plugin add layer@layerwright
// Both are idempotent, so running init again refreshes the plugin.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { FROM_SOURCE, PKG_VERSION, agentPluginSource, layerwrightHome, skillSource } from "./meta.ts";

export type Agent = "claude" | "codex";
export const AGENTS: Agent[] = ["claude", "codex"];
export const AGENT_NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };
export const MARKETPLACE = "layerwright";
export const PLUGIN = "layer";
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;

export type Runner = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
export const run: Runner = (cmd, args) => {
  const r = process.platform === "win32"
    ? spawnSync(winCommandLine(cmd, args), { encoding: "utf8", timeout: 120_000, shell: true })
    : spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
};

/** One command line for cmd.exe. On Windows claude and codex are .cmd shims, which only run through a shell, and a
 *  path with spaces (the marketplace under C:\Users\First Last) must stay one argument: quoted the way the programs
 *  read their arguments back. Inside quotes cmd takes & | < > ^ literally. */
export function winCommandLine(cmd: string, args: string[]): string {
  const q = (a: string) => (/^[\w@+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`);
  return [cmd, ...args].map(q).join(" ");
}

/** The path of a command on PATH, if any. */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const e of exts) { const p = join(dir, cmd + e); if (existsSync(p)) return p; }
  }
  return undefined;
}

/** The agents installed on this computer (their command is on PATH). */
export function detectAgents(env: NodeJS.ProcessEnv = process.env): Agent[] { return AGENTS.filter((a) => onPath(a, env)); }

export function agentsHome() { return join(layerwrightHome(), "agents"); }

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

/** Is the plugin installed for this agent? Read from the agent's own records, no process started. */
export function pluginInstalled(agent: Agent): boolean {
  try {
    if (agent === "claude") {
      const d = JSON.parse(readFileSync(join(claudeHome(), "plugins", "installed_plugins.json"), "utf8"));
      return JSON.stringify(d.plugins ?? d).includes(`"${PLUGIN_ID}"`);
    }
    return readFileSync(join(codexHome(), "config.toml"), "utf8").includes(`[plugins."${PLUGIN_ID}"]`);
  } catch { return false; }
}

export interface ServerEntry { command: string; args: string[]; env?: Record<string, string> }

/** Write the marketplace: both catalogues and the plugin, its server entry pointing at this install. */
export function buildMarketplace(server: ServerEntry, dir = agentsHome()): string {
  const dest = join(dir, "plugins", PLUGIN);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(agentPluginSource(), dest, { recursive: true });
  mkdirSync(join(dest, "skills", "figma-design"), { recursive: true });
  cpSync(skillSource(), join(dest, "skills", "figma-design", "SKILL.md"));
  // A checkout changes without a version bump: a unique version makes Codex re-copy it (it caches by version).
  // Claude Code and Codex cache a plugin by version: local code (a checkout, its build) gets a unique version every
  // time, or they keep running the copy they cached first.
  const local = FROM_SOURCE || server.command !== "npx";
  const version = local ? `${PKG_VERSION}-dev.${Date.now().toString(36)}` : PKG_VERSION;
  const edit = (file: string, fn: (j: any) => void) => { const p = join(dest, file); const j = JSON.parse(readFileSync(p, "utf8")); fn(j); writeFileSync(p, JSON.stringify(j, null, 2) + "\n"); };
  edit(".claude-plugin/plugin.json", (j) => { j.version = version; });
  // Claude Code starts plugin servers in the project folder and fills in ${CLAUDE_PROJECT_DIR}; Codex starts them in
  // the session's folder. Either way the server finds the project.
  edit(".mcp.json", (j) => { j.mcpServers = { layerwright: { command: server.command, args: server.args, env: { ...server.env, LAYERWRIGHT_WORKDIR: "${CLAUDE_PROJECT_DIR}" } } }; });
  // The monitor that wakes a Claude Code session when a request arrives from the Figma window (no channel needed).
  const sh = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  writeFileSync(join(dest, "monitors", "monitors.json"), JSON.stringify([{ name: "figma-requests", command: [server.command, ...server.args, "inbox-watch"].map(sh).join(" "),
    description: "Requests you send to this session from the Layerwright window in Figma" }], null, 2) + "\n");
  // The SessionStart hook: when a Figma window is connected, the new session starts that watcher by itself. The chat
  // hooks tell the Figma window when the session waits for the user (a question, a permission, its turn ended).
  writeFileSync(join(dest, "hooks", "hooks.json"), JSON.stringify(pluginHooks([server.command, ...server.args].map(sh).join(" ")), null, 2) + "\n");
  edit(".codex-plugin/plugin.json", (j) => { j.version = version; j.mcpServers = { layerwright: { command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}) } }; });
  const plugin = JSON.parse(readFileSync(join(dest, ".claude-plugin", "plugin.json"), "utf8"));
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: MARKETPLACE, description: "Layerwright on this computer: the /layer commands and the Figma MCP server.", owner: { name: "Layerwright" },
    plugins: [{ name: PLUGIN, displayName: plugin.displayName, description: plugin.description, version, author: plugin.author, keywords: plugin.keywords, source: `./plugins/${PLUGIN}` }],
  }, null, 2) + "\n");
  mkdirSync(join(dir, ".agents", "plugins"), { recursive: true });
  writeFileSync(join(dir, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: MARKETPLACE, interface: { displayName: "Layerwright" },
    plugins: [{ name: PLUGIN, source: { source: "local", path: `./plugins/${PLUGIN}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }],
  }, null, 2) + "\n");
  return dir;
}

/** The plugin's hooks for this install's command line: the watcher hint at SessionStart, and the chat events. */
export function pluginHooks(cmd: string) {
  const ev = (timeout = 5) => [{ type: "command", command: `${cmd} hook-event`, timeout }];
  return { hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: `${cmd} session-hint`, timeout: 15 }] }],
    PreToolUse: [{ matcher: "AskUserQuestion", hooks: ev() }],
    PostToolUse: [{ matcher: "AskUserQuestion", hooks: ev() }],
    Notification: [{ matcher: "permission_prompt|elicitation_dialog", hooks: ev() }],
    // The user answered in the chat (a reply, not only a question's answer): the window stops saying "waiting for you".
    UserPromptSubmit: [{ hooks: ev() }],
    Stop: [{ hooks: ev() }],
  } };
}

/** Register the marketplace with the agent and install (or refresh) the plugin. */
export function installAgent(agent: Agent, dir = agentsHome(), exec: Runner = run): { ok: boolean; message: string } {
  const steps: [string, string[]][] = agent === "claude"
    ? [["claude", ["plugin", "marketplace", "add", dir, "--scope", "user"]], ["claude", ["plugin", "marketplace", "update", MARKETPLACE]],
       ["claude", ["plugin", "install", PLUGIN_ID, "--scope", "user"]], ["claude", ["plugin", "update", PLUGIN_ID, "--scope", "user"]]]
    : [["codex", ["plugin", "marketplace", "add", dir]], ["codex", ["plugin", "add", PLUGIN_ID]]];
  for (const [cmd, args] of steps) {
    const r = exec(cmd, args);
    if (r.status !== 0) return { ok: false, message: `\`${cmd} ${args.join(" ")}\` failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || `exit ${r.status}`}` };
  }
  return { ok: true, message: agent === "claude" ? `${AGENT_NAMES.claude}: /layer:help in a new session` : `${AGENT_NAMES.codex}: /layer:help in a new session` };
}

/** The --dangerously-load-development-channels entry for this computer: the plugin's server, or a project's own. */
export function channelEntry(dir = process.cwd()): string | undefined {
  if (pluginInstalled("claude")) return `plugin:${PLUGIN_ID}`;
  try { if (JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers?.layerwright) return "server:layerwright"; } catch { /* no project entry */ }
  return undefined;
}

/** `layerwright claude [args]`: Claude Code with requests from the Figma window arriving live (channels). */
export function claudeWithChannels(args: string[], out: (s: string) => void = (s) => process.stderr.write(s + "\n")): Promise<number> {
  const entry = channelEntry();
  if (!onPath("claude")) { out("✗ Claude Code isn't installed (no `claude` on PATH): https://claude.com/claude-code"); return Promise.resolve(1); }
  if (!entry) { out("✗ Layerwright isn't set up for Claude Code here. Run: npx layerwright init"); return Promise.resolve(1); }
  out(`Starting Claude Code with requests from the Figma window (${entry}). Claude Code asks once to confirm the development channel: choose "I am using this for local development".`);
  return new Promise((done) => {
    const argv = ["--dangerously-load-development-channels", entry, ...args];
    const child = process.platform === "win32" ? spawn(winCommandLine("claude", argv), { stdio: "inherit", shell: true }) : spawn("claude", argv, { stdio: "inherit" });
    child.on("exit", (code) => done(code ?? 0));
    child.on("error", (e) => { out(`✗ ${e.message}`); done(1); });
  });
}
