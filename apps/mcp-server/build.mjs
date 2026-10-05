// Bundles the CLI + MCP server into dist/cli.js (plain Node, no tsx at runtime) and ships the built
// Figma plugin and the Claude Code skill next to it.
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, chmodSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
await esbuild.build({
  entryPoints: ["src/cli.ts"], outfile: "dist/cli.js", bundle: true, platform: "node", format: "esm", target: "node20",
  external: Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith("@cde/")),
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
chmodSync("dist/cli.js", 0o755);
if (!existsSync("../figma-plugin/dist/code.js")) throw new Error("Build the Figma plugin first (npm run build -w @cde/figma-plugin).");
mkdirSync("dist/figma-plugin", { recursive: true });
cpSync("../figma-plugin/manifest.json", "dist/figma-plugin/manifest.json");
cpSync("../figma-plugin/dist", "dist/figma-plugin/dist", { recursive: true });
mkdirSync("dist/skill", { recursive: true });
cpSync("../../skills/figma-design/SKILL.md", "dist/skill/SKILL.md");
// The skills library (catalog, skills, their licenses): read by the server and the hub, never written.
cpSync("../../skills/library", "dist/skills-library", { recursive: true });
// The agent plugin template (/layer commands, Claude Code and Codex manifests); init fills in the server entry.
cpSync("../../plugins/layer", "dist/agent-plugin", { recursive: true });
// npm shows the package README; ship the repo README and LICENSE with it.
cpSync("../../README.md", "README.md");
cpSync("../../LICENSE", "LICENSE");
