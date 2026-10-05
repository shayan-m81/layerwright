// The MCP Registry checks that server.json names the npm package's mcpName and the version that is on npm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

test("server.json matches the npm package (name, mcpName, version)", () => {
  const pkg = read("../package.json"), server = read("../../../server.json");
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version, "bump server.json together with package.json");
  assert.deepEqual(server.packages.map((p: any) => [p.identifier, p.version]), [[pkg.name, pkg.version]]);
  assert.ok(server.description.length <= 100, "the registry allows at most 100 characters");
});

// The committed agent plugin runs `npx … layerwright@<version>` in every session (server, monitor, hooks): an exact
// version from npx's cache, never @latest (a registry lookup on every hook, and code nobody pinned).
test("the agent plugin's commands run this exact version, from npx's cache", () => {
  const pkg = read("../package.json");
  const want = `npx -y --prefer-offline ${pkg.name}@${pkg.version}`;
  const plugin = "../../../plugins/layer/";
  const commands: [string, string][] = [];
  const mcp = read(`${plugin}.mcp.json`).mcpServers.layerwright;
  commands.push([".mcp.json", [mcp.command, ...mcp.args].join(" ")]);
  const codex = read(`${plugin}.codex-plugin/plugin.json`).mcpServers.layerwright;
  commands.push([".codex-plugin/plugin.json", [codex.command, ...codex.args].join(" ")]);
  for (const m of read(`${plugin}monitors/monitors.json`)) commands.push(["monitors.json", m.command]);
  for (const [event, groups] of Object.entries<any[]>(read(`${plugin}hooks/hooks.json`).hooks)) for (const g of groups) for (const h of g.hooks) commands.push([`hooks.json ${event}`, h.command]);
  assert.ok(commands.length >= 7);
  for (const [where, cmd] of commands) assert.ok(cmd === want || cmd.startsWith(want + " "), `${where}: "${cmd}" should start with "${want}" (bump it with the package version)`);
});
