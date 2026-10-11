#!/usr/bin/env node
// Runs npx with the arguments it's given, the same way on macOS, Linux and Windows. Claude Code starts the plugin's MCP
// server, hooks and monitor as `node <this file> -y --prefer-offline layerwright@<version> <subcommand>`: node is a real
// program everywhere, while npx is a script (on Windows npx.cmd, which can't start without a shell, and npx.ps1, which
// PowerShell may refuse to run). Input, output and the exit code pass straight through.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const win = process.platform === "win32";
// Windows: one command line for cmd.exe, which finds npx.cmd. The arguments are plain words (flags, a package@version,
// a subcommand); anything else is quoted.
const q = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
const child = win
  ? spawn(["npx", ...args].map(q).join(" "), { stdio: "inherit", shell: true, windowsHide: true })
  : spawn("npx", args, { stdio: "inherit" });
child.on("error", (e) => { process.stderr.write(`Layerwright: couldn't start npx (${e.message}). Is Node.js installed, with npx on the PATH?\n`); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => child.kill(s));
