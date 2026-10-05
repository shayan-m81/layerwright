// init writes a working project setup; doctor diagnoses it against a live bridge + fake plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { WsBridge } from "../src/bridge.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "cde-setup-"));
const fakePlugin = () => {
  const d = tmp();
  mkdirSync(join(d, "dist"));
  writeFileSync(join(d, "manifest.json"), "{}");
  writeFileSync(join(d, "dist", "code.js"), "");
  writeFileSync(join(d, "dist", "ui.html"), "");
  return d;
};
process.env.LAYERWRIGHT_HOME = tmp();
process.env.LAYERWRIGHT_PLUGIN_SRC = fakePlugin();
// Never this computer's own Claude Code or Codex setup: an installed plugin there would change what doctor says.
process.env.CLAUDE_CONFIG_DIR = tmp();
process.env.CODEX_HOME = tmp();
const { init, doctor } = await import("../src/setup.ts");
const { BIN, pluginHome } = await import("../src/meta.ts");

test("init: plugin copied to a stable home, .mcp.json merged (other servers kept), skill + .gitignore written", async () => {
  const dir = tmp();
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  const lines: string[] = [];
  assert.equal(await init({ dir, port: 7336, skipInstall: true, skipBrowserCheck: true, out: (s) => lines.push(s) }), 0);
  const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  assert.ok(mcp.mcpServers.other, "existing servers are preserved");
  assert.equal(mcp.mcpServers[BIN].env.LAYERWRIGHT_PORT, "7336");
  assert.ok(existsSync(join(dir, ".claude/skills/figma-design/SKILL.md")));
  assert.ok(existsSync(join(pluginHome(), "manifest.json")));
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /\.layerwright\/cache/);
  assert.match(lines.join("\n"), /Next steps:[\s\S]*1\. Figma desktop[\s\S]*2\.[\s\S]*3\./);
  // Running init twice is safe.
  assert.equal(await init({ dir, port: 7336, skipInstall: true, skipBrowserCheck: true, out: () => {} }), 0);
  // Running init again adds nothing: the scan cache and report drafts are ignored once each (memory.json is shared).
  const gi = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.equal(gi.match(/\.layerwright\/cache/g)!.length, 1);
  assert.equal(gi.match(/\.layerwright\/report\.md/g)!.length, 1);
  assert.doesNotMatch(gi, /memory\.json/);
});

test("init refuses to overwrite a broken .mcp.json", async () => {
  const dir = tmp();
  writeFileSync(join(dir, ".mcp.json"), "{ nope");
  assert.equal(await init({ dir, skipInstall: true, skipBrowserCheck: true, out: () => {} }), 1);
  assert.equal(readFileSync(join(dir, ".mcp.json"), "utf8"), "{ nope");
});

test("doctor: reports a missing server with a fix, then all good with the bridge and plugin connected", async () => {
  const dir = tmp();
  const port = 7339; // inside the range the plugin manifest allows (7331–7340); 7331 is left for a real session
  await init({ dir, port, skipInstall: true, skipBrowserCheck: true, out: () => {} });
  let lines: string[] = [];
  assert.equal(await doctor({ dir, out: (s) => lines.push(s), skipBrowserCheck: true }), 1);
  assert.match(lines.join("\n"), /nothing is listening[\s\S]*fix: start Claude Code/);

  const bridge = new WsBridge(port, () => {});
  bridge.version = "9.9.9";
  await bridge.start();
  const plugin = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => plugin.on("open", r));
  plugin.send(JSON.stringify({ type: "hello", fileName: "Demo file", page: "Flow" }));
  await new Promise((r) => setTimeout(r, 50));
  lines = [];
  assert.equal(await doctor({ dir, out: (s) => lines.push(s), skipBrowserCheck: true }), 0, lines.join("\n"));
  assert.match(lines.join("\n"), /MCP server running on port \d+ \(v9\.9\.9\)/);
  assert.match(lines.join("\n"), /plugin connected — file "Demo file"/);
  assert.equal(bridge.connected(), true, "the doctor probe did not displace the plugin connection");
  plugin.close();
  bridge.close();
});

test("init refuses a port the Figma plugin could never connect to", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-port-"));
  const lines: string[] = [];
  assert.equal(await init({ dir, port: 7444, skipInstall: true, skipBrowserCheck: true, out: (s) => lines.push(s) }), 1);
  assert.match(lines.join("\n"), /7331–7340/);
});

test("init --cursor: .cursor/mcp.json merged and the skill as a Cursor rule; doctor checks it", async () => {
  const dir = tmp();
  mkdirSync(join(dir, ".cursor"), { recursive: true });
  writeFileSync(join(dir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  assert.equal(await init({ dir, port: 7336, skipInstall: true, skipBrowserCheck: true, out: () => {} }), 0);
  const cfg = JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cfg.mcpServers.other && cfg.mcpServers[BIN], "merged, other servers kept");
  const rule = readFileSync(join(dir, ".cursor", "rules", "figma-design.mdc"), "utf8");
  assert.match(rule, /^---\ndescription: Work as a Design Engineer in Figma[^\n]*\nalwaysApply: false\n---\n\n# Figma Design Engineer/);
  const lines: string[] = [];
  await doctor({ dir, port: 7399, skipBrowserCheck: true, out: (s) => lines.push(s) });
  assert.ok(lines.some((l) => /✓ Cursor set up/.test(l)));
});
