// The agent plugins: the marketplace init builds, how it installs into Claude Code and Codex (their CLIs faked),
// the choice it offers, and the repository's own plugin staying in step with the skill and the package.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tmp = () => mkdtempSync(join(tmpdir(), "lw-agents-"));
const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
process.env.LAYERWRIGHT_HOME = tmp();
process.env.CLAUDE_CONFIG_DIR = tmp();
process.env.CODEX_HOME = tmp();
// Fake `claude` and `codex` on PATH, so detection finds them; the real ones are never run.
const bin = tmp();
for (const c of ["claude", "codex"]) { writeFileSync(join(bin, c), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, c), 0o755); }
process.env.PATH = bin + delimiter + (process.env.PATH ?? "");
const plugin = tmp();
mkdirSync(join(plugin, "dist"));
writeFileSync(join(plugin, "manifest.json"), "{}");
writeFileSync(join(plugin, "dist", "code.js"), "");
writeFileSync(join(plugin, "dist", "ui.html"), '<script>const KEY = "__LAYERWRIGHT_KEY__";</script>');
process.env.LAYERWRIGHT_PLUGIN_SRC = plugin;

const { buildMarketplace, installAgent, pluginInstalled, channelEntry, detectAgents, PLUGIN_ID } = await import("../src/agents.ts");
const { init } = await import("../src/setup.ts");
const { pluginHome, pluginKey } = await import("../src/meta.ts");

/** Records each CLI call; `plugin install` / `plugin add` leave the record the real CLI would. */
function fakeCli() {
  const calls: string[] = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "claude" && args[1] === "install") {
      mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "plugins"), { recursive: true });
      writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: "user" }] } }));
    }
    if (cmd === "codex" && args[1] === "add") writeFileSync(join(process.env.CODEX_HOME!, "config.toml"), `[plugins."${PLUGIN_ID}"]\nenabled = true\n`);
    return { status: 0, stdout: "ok", stderr: "" };
  };
  return { calls, exec };
}

test("the marketplace: both catalogues, the plugin with its commands and skill, the server entry for this install", () => {
  const dir = buildMarketplace({ command: "npx", args: ["-y", "layerwright@9.9.9"], env: { LAYERWRIGHT_PORT: "7336" } }, tmp());
  const p = join(dir, "plugins", "layer");
  assert.equal(JSON.parse(readFileSync(join(dir, ".claude-plugin", "marketplace.json"), "utf8")).plugins[0].source, "./plugins/layer");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".agents", "plugins", "marketplace.json"), "utf8")).plugins[0].source, { source: "local", path: "./plugins/layer" });
  const mcp = JSON.parse(readFileSync(join(p, ".mcp.json"), "utf8")).mcpServers.layerwright;
  assert.deepEqual(mcp, { command: "npx", args: ["-y", "layerwright@9.9.9"], env: { LAYERWRIGHT_PORT: "7336", LAYERWRIGHT_WORKDIR: "${CLAUDE_PROJECT_DIR}" } });
  const codex = JSON.parse(readFileSync(join(p, ".codex-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(codex.mcpServers.layerwright, { command: "npx", args: ["-y", "layerwright@9.9.9"], env: { LAYERWRIGHT_PORT: "7336" } });
  assert.equal(codex.skills, "./skills/");
  // The monitor runs the same Layerwright: inbox-watch wakes the session when a request comes from Figma.
  assert.deepEqual(JSON.parse(readFileSync(join(p, "monitors", "monitors.json"), "utf8"))[0].command, "npx -y layerwright@9.9.9 inbox-watch");
  assert.equal(JSON.parse(readFileSync(join(p, "hooks", "hooks.json"), "utf8")).hooks.SessionStart[0].hooks[0].command, "npx -y layerwright@9.9.9 session-hint");
  const hooks = JSON.parse(readFileSync(join(p, "hooks", "hooks.json"), "utf8")).hooks;
  assert.equal(hooks.Stop[0].hooks[0].command, "npx -y layerwright@9.9.9 hook-event", "the chat hooks: when the session waits for the user, Figma says so");
  assert.equal(hooks.PreToolUse[0].matcher, "AskUserQuestion");
  for (const s of ["help", "connect", "import", "design", "edit", "code", "check", "components", "prototype", "shot", "inbox", "doctor", "report", "figma-design"]) assert.ok(existsSync(join(p, "skills", s, "SKILL.md")), s);
});

test("installing: marketplace then plugin, through each agent's own CLI; a failing step says which and why", () => {
  const { calls, exec } = fakeCli();
  assert.equal(installAgent("claude", "/m", exec).ok, true);
  assert.equal(installAgent("codex", "/m", exec).ok, true);
  assert.deepEqual(calls, ["claude plugin marketplace add /m --scope user", "claude plugin marketplace update layerwright", "claude plugin install layer@layerwright --scope user", "claude plugin update layer@layerwright --scope user", "codex plugin marketplace add /m", "codex plugin add layer@layerwright"]);
  const r = installAgent("codex", "/m", () => ({ status: 1, stdout: "", stderr: "error: no such marketplace\n" }));
  assert.equal(r.ok, false);
  assert.match(r.message, /codex plugin marketplace add \/m` failed: error: no such marketplace/);
});

test("init asks which agents get the plugin, installs it, pairs the plugin window, and drops the project entry the plugin replaces", async () => {
  assert.deepEqual(detectAgents(), ["claude", "codex"]);
  const dir = tmp();
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { layerwright: { command: "npx" }, other: { command: "x" } } }));
  mkdirSync(join(dir, ".claude", "skills", "figma-design"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "figma-design", "SKILL.md"), "---\nname: figma-design\ndescription: x\n---\n");
  const { calls, exec } = fakeCli();
  const asked: string[] = [];
  const lines: string[] = [];
  const code = await init({ dir, skipInstall: true, skipBrowserCheck: true, out: (s) => lines.push(s), exec, prompt: async (q) => { asked.push(q); return ""; } });
  assert.equal(code, 0);
  assert.equal(asked[0], "Choose 1-4 [3]: ", "one short line: a multi-line prompt is redrawn whole while typing");
  assert.match(lines.join("\n"), /1\) Claude Code {3}✓ installed\n {2}2\) Codex {3}✓ installed\n {2}3\) Both/);
  assert.equal(calls.length, 6, "both: the default when both are installed");
  assert.ok(pluginInstalled("claude") && pluginInstalled("codex"));
  assert.match(readFileSync(join(pluginHome(), "dist", "ui.html"), "utf8"), new RegExp(`const KEY = "${pluginKey()}"`), "the window carries this computer's key");
  const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.layerwright, undefined, "the plugin provides the server now");
  assert.ok(mcp.mcpServers.other);
  assert.equal(existsSync(join(dir, ".claude", "skills", "figma-design")), false);
  // The command for live requests is the one that runs this Layerwright (here: the checkout's build, or npx).
  assert.match(lines.join("\n"), /\/layer:help[\s\S]*arrive live when you start Claude Code with: (npx layerwright|node ".+cli\.js"|layerwright) claude/);
  assert.equal(channelEntry(dir), `plugin:${PLUGIN_ID}`);
});

test("a user-level layerwright server next to the plugin would start twice: init asks, then removes it with Claude Code's own command", async () => {
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, ".claude.json"), JSON.stringify({ mcpServers: { layerwright: { command: "node" } } }));
  const { calls, exec } = fakeCli();
  const asked: string[] = [];
  const lines: string[] = [];
  assert.equal(await init({ dir: tmp(), skipInstall: true, skipBrowserCheck: true, out: (s) => lines.push(s), exec, agents: ["claude"], prompt: async (q) => { asked.push(q); return "y"; } }), 0);
  assert.match(asked.at(-1)!, /user-level "layerwright" server.*Remove it/);
  assert.equal(calls.at(-1), "claude mcp remove layerwright --scope user");
  assert.ok(lines.some((l) => /✓ Removed the user-level "layerwright" server/.test(l)));
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, ".claude.json"), "{}");
});

test("a Persian or Arabic digit is a choice too (۱ → Claude Code only)", async () => {
  const { calls, exec } = fakeCli();
  assert.equal(await init({ dir: tmp(), skipInstall: true, skipBrowserCheck: true, out: () => {}, exec, prompt: async () => "۱" }), 0);
  assert.deepEqual([...new Set(calls.map((c) => c.split(" ")[0]))], ["claude"]);
});

test("a .mcp.json in git is the team's: init leaves it and the skill alone and turns the project server off for this user", async () => {
  const dir = tmp();
  const { spawnSync } = await import("node:child_process");
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { layerwright: { command: "npx", args: ["tsx", "src/cli.ts"] } } }, null, 2));
  mkdirSync(join(dir, ".claude", "skills", "figma-design"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "figma-design", "SKILL.md"), "---\nname: figma-design\ndescription: x\n---\n");
  for (const a of [["init", "-q"], ["add", ".mcp.json", ".claude/skills/figma-design/SKILL.md"]]) spawnSync("git", a, { cwd: dir });
  const before = readFileSync(join(dir, ".mcp.json"), "utf8");
  const lines: string[] = [];
  assert.equal(await init({ dir, skipInstall: true, skipBrowserCheck: true, out: (s) => lines.push(s), exec: fakeCli().exec, agents: ["claude"] }), 0);
  assert.equal(readFileSync(join(dir, ".mcp.json"), "utf8"), before);
  assert.ok(existsSync(join(dir, ".claude", "skills", "figma-design", "SKILL.md")));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).disabledMcpjsonServers, ["layerwright"]);
  assert.ok(lines.some((l) => /Turned off this project's "layerwright" server for you only/.test(l)));
  // Running it again doesn't add it twice.
  await init({ dir, skipInstall: true, skipBrowserCheck: true, out: () => {}, exec: fakeCli().exec, agents: ["claude"] });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).disabledMcpjsonServers, ["layerwright"]);
});

test("init --agents codex installs only Codex and keeps the project entry for Claude Code", async () => {
  const dir = tmp();
  const { calls, exec } = fakeCli();
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "plugins", "installed_plugins.json"), "{}");
  assert.equal(await init({ dir, skipInstall: true, skipBrowserCheck: true, out: () => {}, exec, agents: ["codex"] }), 0);
  assert.deepEqual(calls.map((c) => c.split(" ")[0]), ["codex", "codex"]);
  assert.ok(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.layerwright);
  assert.equal(channelEntry(dir), "server:layerwright");
});

test("the repository's plugin: same skill as the package, versions in step, every command named after its folder", () => {
  const pkg = JSON.parse(readFileSync(join(repo, "apps/mcp-server/package.json"), "utf8"));
  const p = join(repo, "plugins/layer");
  assert.equal(readFileSync(join(p, "skills/figma-design/SKILL.md"), "utf8"), readFileSync(join(repo, "skills/figma-design/SKILL.md"), "utf8"), "copy skills/figma-design/SKILL.md into plugins/layer/skills/figma-design/");
  assert.equal(JSON.parse(readFileSync(join(p, ".claude-plugin/plugin.json"), "utf8")).version, pkg.version);
  assert.equal(JSON.parse(readFileSync(join(p, ".codex-plugin/plugin.json"), "utf8")).version, pkg.version);
  assert.equal(JSON.parse(readFileSync(join(repo, ".claude-plugin/marketplace.json"), "utf8")).plugins[0].version, pkg.version);
  for (const s of readdirSync(join(p, "skills"))) {
    const md = readFileSync(join(p, "skills", s, "SKILL.md"), "utf8");
    assert.match(md, new RegExp(`^---\\nname: ${s}\\ndescription: .{40,}`), s);
  }
});
