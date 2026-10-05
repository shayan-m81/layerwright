#!/usr/bin/env -S npx tsx
// Entry: stdio MCP server for Claude Code + local WebSocket bridge for the Figma plugin.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WsBridge } from "./bridge.ts";
import { RelayBridge } from "./relay.ts";
import { createServer } from "./server.ts";
import { PKG_VERSION, inboxFile, projectDir } from "./meta.ts";
import { rmSync } from "node:fs";

// Shared by default: every session joins one hub that owns the port, so any number of Claude Code and Cursor
// sessions use Figma at once. LAYERWRIGHT_DIRECT=1 keeps the old one-session-owns-the-port bridge.
const bridge = process.env.LAYERWRIGHT_DIRECT === "1" ? new WsBridge() : new RelayBridge(undefined, { version: PKG_VERSION, workdir: projectDir() });
bridge.version = PKG_VERSION;
const server = createServer(bridge, { workdir: projectDir() });
await server.connect(new StdioServerTransport());
process.stderr.write("[layerwright] MCP server ready\n");
// The Figma connection comes up in the background: the MCP handshake never waits for it (the client gives up after
// 30 s), and until then the tools say the plugin isn't connected yet.
bridge.start().catch((e) => process.stderr.write(`[layerwright] ${(e as Error).message}\n`));
// When Claude Code goes away (stdin closes), release the port instead of lingering as an orphan.
const shutdown = () => { bridge.close(); const f = inboxFile(); if (f) { try { rmSync(f, { force: true }); } catch { /* gone */ } } process.exit(0); };
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
