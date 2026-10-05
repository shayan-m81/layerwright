// `init` (one-command setup for a project) and `doctor` (diagnose a broken setup).
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import { BIN, CLI_FILE, DEFAULT_PORT, FROM_SOURCE, IN_NPX_CACHE, KEY_PLACEHOLDER, MIN_NODE, PKG_NAME, PKG_VERSION, PORT_RANGE, REPO_ROOT, pluginHome, pluginKey, pluginSource, portAllowed, skillSource } from "./meta.ts";
import { AGENTS, AGENT_NAMES, PLUGIN_ID, buildMarketplace, detectAgents, installAgent, onPath, pluginInstalled, type Agent, type Runner } from "./agents.ts";

type Out = (s: string) => void;
const stdout: Out = (s) => process.stdout.write(s + "\n");
const nodeMajor = () => Number(process.versions.node.split(".")[0]);

async function chromiumAvailable(): Promise<boolean> {
  try { const { launch } = await import("@cde/html-import"); await (await launch()).close(); return true; } catch { return false; }
}

/** The server the agent plugin runs, in any project: the same Layerwright that ran init. A checkout's build or an
 *  installed copy runs as that file (npx tsx would only find tsx inside the checkout); npx's throwaway copy becomes
 *  the published version. */
export function pluginServerEntry() {
  const built = FROM_SOURCE ? join(REPO_ROOT!, "apps/mcp-server/dist/cli.js") : CLI_FILE;
  if (built && existsSync(built) && !IN_NPX_CACHE) return { command: process.execPath, args: [built] };
  return serverEntry();
}

/** How to run a Layerwright command the way this one was run (for "Next steps"). */
export function selfCommand(sub: string): string {
  if (IN_NPX_CACHE || (!CLI_FILE && !FROM_SOURCE)) return `npx ${PKG_NAME} ${sub}`;
  const file = FROM_SOURCE ? join(REPO_ROOT!, "apps/mcp-server/dist/cli.js") : CLI_FILE!;
  const onPathBin = onPath(BIN);
  try { if (onPathBin && realpathSync(onPathBin) === realpathSync(file)) return `${BIN} ${sub}`; } catch { /* not the same */ }
  return `node "${file}" ${sub}`;
}

/** The MCP server entry Claude Code should run for this install. */
export function serverEntry() {
  if (FROM_SOURCE) return { command: "npx", args: ["tsx", join(REPO_ROOT!, "apps/mcp-server/src/cli.ts")] };
  return { command: "npx", args: ["-y", `${PKG_NAME}@${PKG_VERSION}`] };
}

export interface InitOptions { dir?: string; port?: number; skipInstall?: boolean; skipBrowserCheck?: boolean; out?: Out;
  /** Also set up Cursor (.cursor/mcp.json + a rule). Default: when the project already has a .cursor folder. */
  cursor?: boolean;
  /** Install the agent plugin (/layer commands) for these agents. Default: ask at a terminal, else the ones found. */
  agents?: Agent[];
  /** Ask a question at the terminal (tests answer for the user). */
  prompt?: (question: string) => Promise<string>;
  /** Run the agents' CLIs (tests record the calls instead). */
  exec?: Runner }

/** Copy the built plugin to its stable home, with this computer's pairing key in its window (see pluginKey). */
export function installPluginFiles(src = pluginSource()): string {
  const home = pluginHome();
  mkdirSync(home, { recursive: true });
  cpSync(join(src, "manifest.json"), join(home, "manifest.json"));
  cpSync(join(src, "dist"), join(home, "dist"), { recursive: true });
  const ui = join(home, "dist", "ui.html");
  if (existsSync(ui)) writeFileSync(ui, readFileSync(ui, "utf8").split(KEY_PLACEHOLDER).join(pluginKey(true)!));
  return home;
}

/** Put text on the clipboard; false when this computer has no tool for it. */
function copyToClipboard(text: string): boolean {
  const tools: [string, string[]][] = process.platform === "darwin" ? [["pbcopy", []]] : process.platform === "win32" ? [["clip", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  for (const [cmd, args] of tools) { const r = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] }); if (r.status === 0) return true; }
  return false;
}

/** Show the file in Finder / Explorer (the plugin lives in a hidden folder, so nobody finds it by browsing). */
function revealFile(file: string): void {
  try {
    if (process.platform === "darwin") spawnSync("open", ["-R", file], { stdio: "ignore" });
    else if (process.platform === "win32") spawnSync("explorer", [`/select,${file}`], { stdio: "ignore" });
    else spawnSync("xdg-open", [dirname(file)], { stdio: "ignore" });
  } catch { /* nothing to show it with */ }
}

/** Tell the user how to import the plugin into Figma. At a terminal the path is also copied and the folder is shown,
 *  because the file dialog doesn't list hidden folders: they only need to paste. */
export function importGuide(home: string, interactive = Boolean(process.stdout.isTTY)): string {
  const manifest = join(home, "manifest.json");
  const copied = interactive && copyToClipboard(manifest);
  if (interactive) revealFile(manifest);
  const paste = process.platform === "darwin" ? "press ⌘⇧G, paste the path (⌘V) and press Enter" : "paste the path (Ctrl+V) into the File name box and press Enter";
  return `Figma desktop → Plugins → Development → Import plugin from manifest…, then ${paste}.
     ${manifest}${copied ? "   (copied to your clipboard)" : ""}
     Once only: afterwards it's under Plugins → Development → Layerwright.`;
}

/** `layerwright plugin`: reinstall the plugin files and show how to import them into Figma. */
export function pluginCommand(out: Out = stdout): number {
  const src = pluginSource();
  if (!existsSync(join(src, "manifest.json")) || !existsSync(join(src, "dist", "code.js"))) { out(`✗ Built plugin not found in ${src}. Run "npm run build" in the repository.`); return 1; }
  const home = installPluginFiles(src);
  out(`✓ Figma plugin installed at ${home}\n  ${importGuide(home)}`);
  return 0;
}

/** ۱ / ١ → 1: an answer typed with a Persian or Arabic keyboard. */
export const asciiDigits = (s: string) => s.replace(/[۰-۹٠-٩]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));

/** Which agents get the plugin: the ones asked for, else the user's answer at a terminal, else the ones found. */
async function chooseAgents(o: InitOptions, out: Out): Promise<Agent[]> {
  const found = detectAgents();
  if (o.agents) {
    for (const a of o.agents.filter((x) => !found.includes(x))) out(`! ${AGENT_NAMES[a]} isn't installed (no \`${a}\` command), so its plugin is skipped.`);
    return o.agents.filter((a) => found.includes(a));
  }
  // Under node:test nothing touches the real Claude Code or Codex unless a test asks for it.
  if (!found.length || (process.env.NODE_TEST_CONTEXT && !o.prompt)) return [];
  const interactive = !!o.prompt || (process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
  if (!interactive) return found;
  const options: Agent[][] = [["claude"], ["codex"], ["claude", "codex"], []];
  const labels = ["Claude Code", "Codex", "Both", "Neither (only this project's .mcp.json)"];
  const def = found.length === 2 ? 3 : found[0] === "codex" ? 2 : 1;
  const ask = o.prompt ?? (async (q: string) => { const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } });
  out("Install the Layerwright plugin (/layer:… commands, the Figma tools) for:");
  labels.forEach((l, i) => out(`  ${i + 1}) ${l}${i < 2 ? (found.includes(AGENTS[i]) ? "   ✓ installed" : "   – not found") : ""}`));
  // Only the last line is the question: a multi-line prompt is redrawn whole while typing.
  const answer = asciiDigits((await ask(`Choose 1-4 [${def}]: `)).trim());
  const pick = options[(Number(answer) || def) - 1] ?? options[def - 1];
  for (const a of pick.filter((x) => !found.includes(x))) out(`! ${AGENT_NAMES[a]} isn't installed, so its plugin is skipped.`);
  return pick.filter((a) => found.includes(a));
}

/** A user-level "layerwright" server in Claude Code (claude mcp add -s user) would run next to the plugin's: two
 *  servers, two sessions in the Figma window. Offer to remove it (asked at a terminal; otherwise only said). */
async function dropUserEntry(o: InitOptions, out: Out) {
  const file = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json"); // Claude Code's own config
  let has = false;
  try { has = !!JSON.parse(readFileSync(file, "utf8")).mcpServers?.[BIN]; } catch { return; }
  if (!has) return;
  const cmd = `claude mcp remove ${BIN} --scope user`;
  const interactive = !!o.prompt || (process.stdin.isTTY && process.stdout.isTTY && !process.env.CI && !process.env.NODE_TEST_CONTEXT);
  if (!interactive) { out(`! Claude Code also has a user-level "${BIN}" server, so each session would start two. Remove it: ${cmd}`); return; }
  const ask = o.prompt ?? (async (q: string) => { const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } });
  const yes = !/^n/i.test((await ask(`Claude Code also has a user-level "${BIN}" server; with the plugin each session would start two. Remove it (${cmd})? [Y/n] `)).trim());
  if (!yes) { out(`! Kept the user-level "${BIN}" server. Sessions will show twice in the Figma window until you run: ${cmd}`); return; }
  const r = (o.exec ?? ((c: string, a: string[]) => { const x = spawnSync(c, a, { encoding: "utf8" }); return { status: x.status, stdout: x.stdout ?? "", stderr: x.stderr ?? "" }; }))("claude", ["mcp", "remove", BIN, "--scope", "user"]);
  out(r.status === 0 ? `✓ Removed the user-level "${BIN}" server: the plugin provides it now.` : `✗ Couldn't remove it (${(r.stderr || r.stdout).trim()}). Run: ${cmd}`);
}

/** Is this file in git? Then it's shared with the team: change it for this user only. */
function tracked(dir: string, file: string): boolean {
  try { return spawnSync("git", ["ls-files", "--error-unmatch", file], { cwd: dir, encoding: "utf8" }).status === 0; } catch { return false; }
}

/** Is the project's layerwright server turned off for this user (disabledMcpjsonServers)? */
export function projectServerDisabled(dir: string): boolean {
  for (const f of ["settings.local.json", "settings.json"]) {
    try { if ((JSON.parse(readFileSync(join(dir, ".claude", f), "utf8")).disabledMcpjsonServers ?? []).includes(BIN)) return true; } catch { /* none */ }
  }
  return false;
}

/** The plugin provides the server and the skill now; the project's own would run next to them (two servers for one
 *  session). A .mcp.json in git is the team's: it stays, and the server is turned off for this user only
 *  (.claude/settings.local.json → disabledMcpjsonServers). One that isn't in git loses the entry init wrote. */
function dropProjectEntry(dir: string, out: Out) {
  const file = join(dir, ".mcp.json");
  let cfg: any;
  try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch { cfg = undefined; }
  if (cfg?.mcpServers?.[BIN]) {
    if (tracked(dir, ".mcp.json")) {
      if (!projectServerDisabled(dir)) {
        const local = join(dir, ".claude", "settings.local.json");
        let settings: any = {};
        try { settings = JSON.parse(readFileSync(local, "utf8")); } catch { /* new file */ }
        settings.disabledMcpjsonServers = [...new Set([...(settings.disabledMcpjsonServers ?? []), BIN])];
        mkdirSync(dirname(local), { recursive: true });
        writeFileSync(local, JSON.stringify(settings, null, 2) + "\n");
      }
      out(`✓ Turned off this project's "${BIN}" server for you only (.claude/settings.local.json): the plugin runs it now. .mcp.json is in git, so it stays as it is for the team.`);
    } else {
      delete cfg.mcpServers[BIN];
      writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
      out(`✓ Removed "${BIN}" from ${file}: the Claude Code plugin provides it now.`);
    }
  }
  const skill = join(dir, ".claude", "skills", "figma-design", "SKILL.md");
  try {
    if (/^---\nname: figma-design\n/.test(readFileSync(skill, "utf8")) && !tracked(dir, ".claude/skills/figma-design/SKILL.md")) {
      rmSync(dirname(skill), { recursive: true, force: true });
      out(`✓ Removed the project copy of the figma-design skill: the plugin has it.`);
    }
  } catch { /* none */ }
}

/** Register the server in an MCP config file, merged: other servers are never touched. false = the file is broken. */
function registerMcp(file: string, port: number): boolean {
  let cfg: any = {};
  if (existsSync(file)) { try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch { return false; } }
  cfg.mcpServers ??= {};
  cfg.mcpServers[BIN] = { ...serverEntry(), env: { LAYERWRIGHT_PORT: String(port) } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}

/** The skill as a Cursor rule: same text, Cursor's frontmatter (Cursor doesn't read .claude/skills). */
export function cursorRule(skill: string): string {
  const m = skill.match(/^---\n([\s\S]*?)\n---\n?/);
  const description = m?.[1].match(/^description:\s*(.+)$/m)?.[1] ?? "Layerwright: Figma design work through the layerwright MCP tools.";
  return `---\ndescription: ${description}\nalwaysApply: false\n---\n${m ? skill.slice(m[0].length) : skill}`;
}

export async function init(o: InitOptions = {}): Promise<number> {
  const out = o.out ?? stdout;
  const dir = resolve(o.dir ?? process.cwd());
  const port = o.port ?? DEFAULT_PORT;
  if (!portAllowed(port)) { out(`✗ Port ${port} can't be used: the Figma plugin may only connect to localhost ports ${PORT_RANGE[0]}–${PORT_RANGE[1]}.`); return 1; }
  if (nodeMajor() < MIN_NODE) { out(`✗ Node ${process.versions.node} found; Node ${MIN_NODE} or newer is required (https://nodejs.org).`); return 1; }
  out(`✓ Node ${process.versions.node}`);

  // From a git checkout: install dependencies and build the plugin. The npm package ships it prebuilt.
  if (FROM_SOURCE && !o.skipInstall) {
    out("… installing dependencies and building the Figma plugin");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  }
  const src = pluginSource();
  if (!existsSync(join(src, "manifest.json")) || !existsSync(join(src, "dist", "code.js"))) { out(`✗ Built plugin not found in ${src}. Run "npm run build" in the repository.`); return 1; }
  const home = installPluginFiles(src);
  out(`✓ Figma plugin installed at ${home} (paired with this computer)`);

  // The agent plugin: /layer commands, the MCP server and the skill, for every project on this computer.
  const agents = await chooseAgents(o, out);
  if (agents.length) {
    const entry = pluginServerEntry();
    const market = buildMarketplace(port === DEFAULT_PORT ? entry : { ...entry, env: { LAYERWRIGHT_PORT: String(port) } });
    for (const a of agents) {
      const r = installAgent(a, market, o.exec);
      out(r.ok ? `✓ Layerwright plugin installed for ${r.message}` : `✗ ${AGENT_NAMES[a]}: ${r.message}`);
    }
  }
  const claudePlugin = agents.includes("claude") && pluginInstalled("claude");

  if (claudePlugin) { dropProjectEntry(dir, out); await dropUserEntry(o, out); }
  else {
    // .mcp.json (merged, never clobbering other servers)
    const mcpPath = join(dir, ".mcp.json");
    if (!registerMcp(mcpPath, port)) { out(`✗ ${mcpPath} is not valid JSON; fix or remove it and run init again.`); return 1; }
    out(`✓ MCP server "${BIN}" registered in ${mcpPath}`);

    const skillDir = join(dir, ".claude", "skills", "figma-design");
    mkdirSync(skillDir, { recursive: true });
    cpSync(skillSource(), join(skillDir, "SKILL.md"));
    out(`✓ Skill copied to ${skillDir}`);
  }

  // Cursor: its own MCP config and the skill as a rule.
  if (o.cursor ?? existsSync(join(dir, ".cursor"))) {
    const cursorMcp = join(dir, ".cursor", "mcp.json");
    if (!registerMcp(cursorMcp, port)) { out(`✗ ${cursorMcp} is not valid JSON; fix or remove it and run init again.`); return 1; }
    const rule = join(dir, ".cursor", "rules", "figma-design.mdc");
    mkdirSync(dirname(rule), { recursive: true });
    writeFileSync(rule, cursorRule(readFileSync(skillSource(), "utf8")));
    out(`✓ Cursor set up: ${cursorMcp} and ${rule}`);
  }

  const gi = join(dir, ".gitignore");
  // The scan cache and report drafts stay local; mapping.json and memory.json are meant to be shared.
  let cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  for (const line of [".layerwright/cache", ".layerwright/report.md"]) if (!cur.split(/\r?\n/).includes(line)) cur = cur + (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n";
  writeFileSync(gi, cur);

  if (!o.skipBrowserCheck) {
    if (await chromiumAvailable()) out("✓ Chromium available for HTML import");
    else out("! No Chromium for HTML import. Run: npx playwright install chromium   (or install Google Chrome)");
  }

  const agentLine = agents.length
    ? `  3. Start a new ${agents.map((a) => AGENT_NAMES[a]).join(" or ")} session and type /layer:help for the commands.${agents.includes("claude") ? `\n     Requests from the Figma window arrive live when you start Claude Code with: ${selfCommand("claude")}` : ""}
     Or just ask, for example:`
    : `  3. Restart Claude Code in ${dir} and ask, for example:`;
  out(`
Next steps:
  1. ${importGuide(home)}
  2. Open your design file and run the plugin (keep its small window open).
${agentLine}
     • "Import ./design.html into Figma"                         (HTML → Figma)
     • "Create a login screen in Figma using our Design System"  (prompt → Figma)
     • select a frame in Figma, then "Implement the selected Figma frame in code using our components"  (Figma → code)
     • select repeated frames, then "Make these a component set with a State variant"  (layers → components)
     • "Wire the Cart, Payment and Success screens into a clickable prototype"  (prototype)
   Or without AI: ${selfCommand("import ./design.html --to-figma")}
Optional: paste the prompt from https://github.com/shayan-m81/layerwright/blob/main/docs/claude-prompt.md into CLAUDE.md.
Trouble? Run: ${selfCommand("doctor")}`);
  return 0;
}

/** Ask a running bridge for its status over the /doctor path. */
/** The build stamp baked into the installed plugin (see apps/figma-plugin/build.mjs). */
function installedBuild(): string | undefined {
  for (const dir of [pluginHome(), pluginSource()]) {
    try { const m = readFileSync(join(dir, "dist", "code.js"), "utf8").match(/"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/); if (m) return m[1]; } catch { /* not there */ }
  }
  return undefined;
}

export function probe(port: number, timeoutMs = 1500): Promise<{ ok: true; status: any } | { ok: false; reason: string }> {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/doctor`);
    const t = setTimeout(() => { ws.terminate(); done({ ok: false, reason: "timeout" }); }, timeoutMs);
    ws.on("message", (m) => { clearTimeout(t); try { done({ ok: true, status: JSON.parse(String(m)) }); } catch { done({ ok: false, reason: "bad reply" }); } ws.close(); });
    ws.on("error", (e: any) => { clearTimeout(t); done({ ok: false, reason: e.code ?? e.message }); });
  });
}

export async function doctor(o: { dir?: string; port?: number; out?: Out; skipBrowserCheck?: boolean } = {}): Promise<number> {
  const out = o.out ?? stdout;
  const dir = resolve(o.dir ?? process.cwd());
  let problems = 0;
  const pass = (m: string) => out(`✓ ${m}`);
  const failWith = (m: string, fix: string) => { problems++; out(`✗ ${m}\n    fix: ${fix}`); };

  if (nodeMajor() >= MIN_NODE) pass(`Node ${process.versions.node}`); else failWith(`Node ${process.versions.node} is too old`, `install Node ${MIN_NODE}+ from https://nodejs.org`);

  const mcpPath = join(dir, ".mcp.json");
  let port = o.port ?? DEFAULT_PORT;
  const plugins = AGENTS.filter((a) => pluginInstalled(a));
  for (const a of plugins) pass(`${AGENT_NAMES[a]} plugin ${PLUGIN_ID} installed (/layer commands)`);
  if (plugins.includes("claude") && !projectServerDisabled(dir)) {
    try { if (JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers?.[BIN]) failWith(`this project's .mcp.json also runs "${BIN}", next to the plugin's: two servers for each session`, `run: ${selfCommand("init --agents claude")}   (turns the project's one off for you, or removes it when .mcp.json isn't in git)`); } catch { /* no project entry */ }
  }
  for (const a of detectAgents().filter((x) => !plugins.includes(x))) out(`! ${AGENT_NAMES[a]} has no Layerwright plugin (/layer commands): npx ${PKG_NAME} init`);
  try {
    const entry = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers?.[BIN];
    if (entry) { pass(`.mcp.json registers "${BIN}"`); port = o.port ?? Number(entry.env?.LAYERWRIGHT_PORT ?? DEFAULT_PORT); }
    else if (!plugins.includes("claude")) failWith(`.mcp.json has no "${BIN}" server`, `run: npx ${PKG_NAME} init`);
  } catch { if (!plugins.includes("claude")) failWith(`no .mcp.json in ${dir}`, `run: npx ${PKG_NAME} init   (in your project folder)`); }

  if (plugins.includes("claude")) { /* the plugin carries the skill */ }
  else if (existsSync(join(dir, ".claude", "skills", "figma-design", "SKILL.md"))) pass("skill installed"); else failWith("skill not installed in .claude/skills", `run: npx ${PKG_NAME} init`);
  if (existsSync(join(dir, ".cursor"))) {
    let ok = false;
    try { ok = !!JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8")).mcpServers?.[BIN]; } catch { /* missing or broken */ }
    if (ok && existsSync(join(dir, ".cursor", "rules", "figma-design.mdc"))) pass("Cursor set up (.cursor/mcp.json + rule)");
    else failWith("Cursor isn't set up for Layerwright", `run: npx ${PKG_NAME} init --cursor`);
  }
  if (existsSync(join(pluginHome(), "manifest.json"))) pass(`plugin files at ${pluginHome()}`); else failWith("plugin files missing", `run: npx ${PKG_NAME} init, then import ${join(pluginHome(), "manifest.json")} in Figma`);

  const p = await probe(port);
  if (!p.ok) {
    failWith(`nothing is listening on ws://localhost:${port} (${p.reason})`, "start Claude Code in this project; it launches the MCP server from .mcp.json. Check /mcp in Claude Code if it failed to start.");
  } else {
    if (p.status.hub) {
      const names = (p.status.sessions ?? []).map((x: any) => x.name);
      pass(`shared Figma connection (hub v${p.status.version}) on port ${port}, ${names.length} session(s)${names.length ? `: ${names.join(", ")}` : ""}`);
    } else pass(`MCP server running on port ${port} (v${p.status.version}); an older single-session server: other sessions can't use Figma until it's updated`);
    if (p.status.pluginConnected) {
      pass(`Figma plugin connected — file "${p.status.hello?.fileName ?? "?"}", page "${p.status.hello?.page ?? "?"}"`);
      if (p.status.hub && p.status.pluginPaired === false) failWith("the plugin window isn't paired with this computer, so requests from Figma can't reach sessions", `run: npx ${PKG_NAME} init, then close and reopen the Layerwright plugin`);
      // An open plugin window keeps running the code it started with: compare it with the installed build.
      const running = p.status.hello?.pluginBuild as string | undefined;
      const installed = installedBuild();
      if (installed && running !== installed) failWith(`the open plugin window runs an older build (${running ?? "before build stamps"}) than the installed one (${installed})`, "close the Layerwright plugin in Figma and run it again (or turn on Plugins → Development → Hot reload plugin)");
    }
    else failWith("Figma plugin is not connected", `open Figma desktop, run the plugin (Plugins → Development), and make sure its port is ${port}`);
  }

  if (!o.skipBrowserCheck) {
    if (await chromiumAvailable()) pass("Chromium available for HTML import");
    else failWith("no Chromium for HTML import", "run: npx playwright install chromium   (or install Google Chrome)");
  }
  {
    const { checkForUpdate } = await import("./update.ts");
    const u = await checkForUpdate().catch(() => undefined);
    if (u?.updateAvailable) out(`! Layerwright ${u.latest} is available (you have ${u.current}). ${u.steps?.join(" → ")}`);
    else if (u?.latest) pass(`Layerwright ${u.current} is the latest version`);
  }
  out(problems ? `\n${problems} problem(s) found.` : "\nAll good.");
  return problems ? 1 : 0;
}
