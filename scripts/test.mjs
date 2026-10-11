#!/usr/bin/env node
// Runs the test suite the same way on macOS, Linux and Windows (npm runs scripts through cmd.exe there, which knows
// neither `VAR=1 cmd` nor `*.test.ts`): every workspace's test/*.test.ts, or the files given, with tsx and without
// the npm update check. Extra flags pass to node's test runner:
//   npm test
//   npm test -- packages/core/test/resolve.test.ts
//   npm test -- --test-name-pattern="server.json" apps/mcp-server/test/registry.test.ts
//   npm test -- --update-snapshots
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKSPACES = ["packages/core", "packages/html-import", "apps/mcp-server", "apps/figma-plugin"];
const args = process.argv.slice(2);
const env = { ...process.env, LAYERWRIGHT_NO_UPDATE_CHECK: "1" };
if (args.includes("--update-snapshots")) env.UPDATE_SNAPSHOTS = "1";
const flags = args.filter((a) => a.startsWith("--") && a !== "--update-snapshots");
const given = args.filter((a) => !a.startsWith("--"));
const files = given.length ? given : WORKSPACES.flatMap((w) => {
  const dir = join(w, "test");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort().map((f) => join(dir, f)) : [];
});
const r = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-timeout=120000", ...flags, ...files], { stdio: "inherit", env });
process.exit(r.status ?? 1);
