// Command line: `<bin>` (or `<bin> serve`) runs the MCP server for Claude Code; the other commands
// are for people at a terminal.
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compilePlan, emptyDesignSystem } from "@cde/core";

import { BIN } from "./meta.ts";

const HELP = () => `Usage:
  ${BIN}                        start the MCP server (Claude Code runs this for you)
  ${BIN} init [--port 7331]     set up the Figma plugin, the /layer commands for Claude Code and Codex (asks which)
                                     and this project (run in your project folder)
      --agents claude,codex    install the agent plugin for these without asking (--no-agents: none)
      --cursor                 also set up Cursor (.cursor/mcp.json and a rule; automatic when .cursor exists)
  ${BIN} plugin                 reinstall the Figma plugin and show how to import it (copies its path, opens its folder)
  ${BIN} claude [args…]         start Claude Code with requests from the Figma window arriving live (channels)
  ${BIN} agents [claude|codex]  install or refresh the agent plugin (/layer commands); default: the agents found
  ${BIN} doctor [--port 7331]   check Node, the server, the Figma plugin connection and the file
  ${BIN} hub [status|stop]      the shared Figma connection every session uses (started for you; this shows or stops it)
  ${BIN} import <file|folder>   convert HTML to a Design Plan and print its summary
      --viewport 1440,390      viewport widths (default 1440,390)
      --json                   print the full plan JSON instead of the summary
      --selector <css>         element to import (default body)
      --to-figma               build it in the open Figma file (no AI needed; run the Layerwright plugin)
        --page <name>          page to build on (created by --faithful if missing)
        --faithful             exact positioned layers instead of Auto Layout
        --section <name>       --faithful: wrap the screens in a section
        --scan                 scan the file's Design System first and use its components
        --port <7331-7340>     bridge port (default from .mcp.json, else 7331)
  ${BIN} fonts <folder>          list the fonts an export ships (TTF/OTF can be installed; WOFF/WOFF2 can't)
      --install                copy the TTF/OTF files to your user fonts folder (restart Figma afterwards)
      --only <text>            only files whose name contains this (e.g. --only IRANYekanX)
  ${BIN} report                  draft a GitHub issue from this project's recurring problems (redacted; you review and send it)
  ${BIN} help`;

const VALUE_FLAGS = ["--viewport", "--selector", "--page", "--section", "--port"];

export async function importCommand(args: string[], out: (s: string) => void = (s) => process.stdout.write(s + "\n")) {
  const { renderToPlan } = await import("@cde/html-import");
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const path = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));
  if (!path) { out(HELP()); return 2; }
  const viewports = flag("--viewport")?.split(",").map(Number).filter((n) => n >= 200);
  if (args.includes("--to-figma")) return toFigma(resolve(path), { viewports, selector: flag("--selector"), page: flag("--page"), section: flag("--section"), faithful: args.includes("--faithful"), scan: args.includes("--scan"), port: flag("--port") ? Number(flag("--port")) : undefined }, out);
  const r = await renderToPlan(resolve(path), { viewports, selector: flag("--selector") });
  if (args.includes("--json")) { out(JSON.stringify(r.plan, null, 2)); return 0; }
  const c = compilePlan(emptyDesignSystem(), r.plan);
  const s = c.summary;
  out(`Plan "${r.plan.name}"`);
  out(`  screens:    ${s.screens.join(", ")}`);
  out(`  frames:     ${s.frames}   texts: ${s.texts}   images/icons/dividers: ${s.primitives}`);
  const roles = r.hints.reduce<Record<string, number>>((m, h) => ((m[h.role] = (m[h.role] ?? 0) + 1), m), {});
  if (Object.keys(roles).length) out(`  detected:   ${Object.entries(roles).map(([k, v]) => `${v} × ${k}`).join(", ")} (mapped to DS components when a Design System is scanned)`);
  for (const w of [...r.warnings, ...c.warnings].slice(0, 10)) out(`  warning:    ${w}`);
  if (!c.ok) { for (const e of c.errors.slice(0, 10)) out(`  error:      ${e.path ?? ""} ${e.message}`); return 1; }
  out(`\nIn Claude Code, ask: "Import ${path} into Figma" (tool: import_html_to_plan).`);
  return 0;
}

/** Build an HTML file in the open Figma file without an AI client: the same tools Claude uses, called in order. */
export async function toFigma(path: string, o: { viewports?: number[]; selector?: string; page?: string; section?: string; faithful?: boolean; scan?: boolean; port?: number; waitMs?: number; workdir?: string },
  out: (s: string) => void): Promise<number> {
  const { WsBridge } = await import("./bridge.ts");
  const { createServer } = await import("./server.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { readFileSync } = await import("node:fs");
  const workdir = o.workdir ?? process.cwd();
  let port = o.port;
  if (!port) { try { port = Number(JSON.parse(readFileSync(resolve(workdir, ".mcp.json"), "utf8")).mcpServers?.[BIN]?.env?.LAYERWRIGHT_PORT) || undefined; } catch { /* no .mcp.json */ } }
  port ??= 7331;
  const bridge = new WsBridge(port, () => {});
  await bridge.start();
  if (bridge.startError) { out(`✗ ${bridge.startError}${/already in use/.test(bridge.startError) ? "\n  If Claude Code is running in this project, its server holds the port: ask Claude instead, or close that session." : ""}`); return 1; }
  try {
    out(`Waiting for the Figma plugin on ws://localhost:${port}… (Figma desktop → Plugins → Development → Layerwright)`);
    const until = Date.now() + (o.waitMs ?? 120_000);
    while (!bridge.connected() && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
    if (!bridge.connected()) { out("✗ The plugin didn't connect. Open it in Figma desktop and check that its port matches."); return 1; }
    await new Promise((r) => setTimeout(r, 300)); // the plugin's hello
    out(`✓ Connected to "${bridge.info()?.fileName ?? "?"}"`);
    const server = createServer(bridge, { workdir });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "layerwright-cli", version: "0" });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
      const data = JSON.parse(r.content.find((c: any) => c.type === "text")?.text ?? "{}");
      if (r.isError) throw new Error((data.errors ?? []).map((e: any) => `${e.type}: ${e.message}`).join("\n") || "failed");
      return data;
    };
    if (o.scan) { const d = await call("figma_scan_design_system", {}); out(`✓ Design System: ${d.counts?.componentSets ?? 0} component sets, ${d.counts?.variables ?? 0} variables`); }
    let created: string[], verification: any, warnings: string[] = [];
    if (o.faithful) {
      const r = await call("figma_import_html", { file: path, page: o.page, section: o.section });
      created = (r.screens ?? []).map((x: any) => x.id); verification = r.verification; warnings = r.warnings ?? [];
    } else {
      const p = await call("import_html_to_plan", { path, viewport: o.viewports, selector: o.selector, page: o.page, useDesignSystem: o.scan ? true : undefined });
      out(`✓ Plan: ${p.summary.screens.join(", ")} (${p.summary.frames} frames, ${p.summary.texts} texts${Object.keys(p.mappedToDesignSystem ?? {}).length ? `, DS: ${Object.entries(p.mappedToDesignSystem).map(([k, v]) => `${v}× ${k}`).join(", ")}` : ""})`);
      const r = await call("figma_execute_plan", { planId: p.planId });
      created = r.created; verification = r.verification; warnings = [...(p.warnings ?? []), ...(r.warnings ?? [])];
    }
    out(`✓ Built ${created.length} screen(s) in Figma${verification ? `; verification ${verification.passed ? "passed" : `found ${verification.total} issue(s): ${Object.entries(verification.byIssue ?? {}).map(([k, v]) => `${v}× ${k}`).join(", ")}`}` : ""}`);
    for (const w of warnings.slice(0, 10)) out(`  warning: ${w}`);
    return verification && !verification.passed ? 3 : 0;
  } catch (e) {
    out(`✗ ${(e as Error).message}`);
    return 1;
  } finally { bridge.close(); }
}

/** The per-user fonts folder Figma desktop reads. */
export function userFontsDir(): string {
  const { homedir, platform } = { homedir: process.env.HOME ?? process.env.USERPROFILE ?? "", platform: process.platform };
  if (platform === "darwin") return `${homedir}/Library/Fonts`;
  if (platform === "win32") return `${process.env.LOCALAPPDATA ?? `${homedir}\\AppData\\Local`}\\Microsoft\\Windows\\Fonts`;
  return `${homedir}/.local/share/fonts`;
}

/** Find the fonts in an export (e.g. a Claude Design folder with _ds/…/fonts) and optionally install them. */
export async function fontsCommand(args: string[], out: (s: string) => void = (s) => process.stdout.write(s + "\n"), dest = userFontsDir()): Promise<number> {
  const { readdirSync, statSync, existsSync, mkdirSync, copyFileSync } = await import("node:fs");
  const { join, basename } = await import("node:path");
  const onlyAt = args.indexOf("--only");
  const only = onlyAt >= 0 ? args[onlyAt + 1]?.toLowerCase() : undefined;
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--only");
  if (!dir || !existsSync(dir)) { out(HELP()); return 2; }
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    for (const f of readdirSync(d)) {
      if (f === "node_modules" || f.startsWith(".")) continue;
      const p = join(d, f);
      try { if (statSync(p).isDirectory()) walk(p, depth + 1); else if (/\.(ttf|otf|woff2?)$/i.test(f)) found.push(p); } catch { /* unreadable */ }
    }
  };
  walk(resolve(dir), 0);
  const installable = found.filter((f) => /\.(ttf|otf)$/i.test(f) && (!only || basename(f).toLowerCase().includes(only)));
  const webOnly = found.filter((f) => /\.woff2?$/i.test(f));
  if (!found.length) { out("No font files in this folder."); return 1; }
  out(`${installable.length} installable font file(s)${webOnly.length ? `, ${webOnly.length} web-only (WOFF/WOFF2: Figma can't use these; get a TTF/OTF)` : ""}.`);
  for (const f of installable) out(`  ${basename(f)}`);
  if (!args.includes("--install")) { if (installable.length) out(`\nInstall them for this user: ${BIN} fonts ${dir} --install`); return 0; }
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of installable) {
    const target = join(dest, basename(f));
    if (existsSync(target)) { out(`  = ${basename(f)} (already installed)`); continue; }
    copyFileSync(f, target); copied++;
    out(`  + ${basename(f)}`);
  }
  out(`\n✓ ${copied} font(s) installed to ${dest}. Restart Figma so it sees them, then reopen the Layerwright plugin.`);
  return 0;
}

/** Draft (never send) an issue for the maintainers from .layerwright/memory.json. */
export async function reportCommand(dir = process.cwd(), out: (s: string) => void = (s) => process.stdout.write(s + "\n")): Promise<number> {
  const { MemoryStore, reportDraft } = await import("./memory.ts");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { PKG_VERSION } = await import("./meta.ts");
  const m = new MemoryStore(join(dir, ".layerwright", "memory.json")).read();
  const d = reportDraft(m, { version: PKG_VERSION, node: process.versions.node, os: `${process.platform} ${process.arch}` });
  const file = join(dir, ".layerwright", "report.md");
  mkdirSync(join(dir, ".layerwright"), { recursive: true });
  writeFileSync(file, `# ${d.title}\n\n${d.body}\n`);
  out(`Draft written to ${file}. Nothing was sent.`);
  out(`Read it, then open this link to file it on GitHub (you can edit it there):\n${d.url}`);
  return 0;
}

/** Local time for log lines: 2026-10-06 02:11:03. */
export function logTime(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `hub` runs the shared bridge (sessions start it detached); `hub status` / `hub stop` are for people. */
export async function hubCommand(sub: string, port = Number(process.env.LAYERWRIGHT_PORT ?? 7331), out: (s: string) => void = (s) => process.stdout.write(s + "\n")): Promise<number> {
  const { probePort } = await import("./relay.ts");
  if (sub === "run") {
    const { Hub } = await import("./hub.ts");
    const { PKG_VERSION } = await import("./meta.ts");
    const { writePrefs } = await import("./prefs.ts");
    // ~/.layerwright/hub.log: every line with its local time, so an event can be matched to the moment it was seen.
    const log = (m: string) => process.stderr.write(`${logTime()} [layerwright hub] ${m}\n`);
    const hub = new Hub(port, { version: PKG_VERSION, log, onExit: () => process.exit(0), onPluginSeen: () => writePrefs({ figmaSeenAt: new Date().toISOString() }) });
    const err = await hub.start();
    if (err) { log(`${err} Another hub already serves it.`); return 0; }
    log(`Layerwright ${PKG_VERSION} (pid ${process.pid})`);
    const stop = () => { hub.close(); process.exit(0); };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    await new Promise(() => {}); // until idle or stopped
  }
  const p = await probePort(port);
  if (sub === "status") {
    if (p.kind === "free") { out(`No hub on port ${port}. A session starts one when it needs Figma.`); return 0; }
    if (p.kind === "legacy") { out(`Port ${port} is held by an older, single-session Layerwright (${p.status?.version ?? "?"}). Close or restart that session.`); return 1; }
    if (p.kind !== "hub") { out(`Port ${port} is held by another program that isn't Layerwright (${p.reason}); sessions can't use Figma on it. Close that program, or use another port from 7331–7340 (LAYERWRIGHT_PORT, and the same port in the plugin window).`); return 1; }
    const s = p.status;
    out(`Hub ${s.version} on port ${port} · Figma plugin ${s.pluginConnected ? `connected ("${s.hello?.fileName ?? "?"}", page "${s.hello?.page ?? "?"}")` : "not connected"}`);
    out(s.sessions?.length ? s.sessions.map((x: any) => `  • ${x.name}${x.client ? ` (${x.client})` : ""}${x.workdir ? ` — ${x.workdir}` : ""}`).join("\n") : "  no sessions");
    return 0;
  }
  if (sub === "stop") {
    if (p.kind !== "hub") { out(p.kind === "free" ? "No hub is running." : `Port ${port} isn't held by a hub.`); return p.kind === "free" ? 0 : 1; }
    const WebSocket = (await import("ws")).default;
    const r: any = await new Promise((done) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/stop`); ws.on("message", (m) => done(JSON.parse(String(m)))); ws.on("error", () => done({})); });
    out(r.stopping ? `Hub stopped. ${r.sessions ? `${r.sessions} session(s) start a new one by themselves.` : ""}` : "The hub is in the middle of a request; try again in a moment.");
    return r.stopping ? 0 : 1;
  }
  out(HELP());
  return 2;
}

/** `inbox-watch`: the Claude Code plugin's monitor. Prints one line per request the user sends this session from the
 *  Figma window; Claude Code hands each line to Claude as a notification, which wakes the session to do it. */
export async function inboxWatch(o: { file?: string; out?: (s: string) => void; pollMs?: number; signal?: AbortSignal } = {}): Promise<number> {
  const { inboxFile } = await import("./meta.ts");
  const { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const file = o.file ?? inboxFile();
  const out = o.out ?? ((s: string) => process.stdout.write(s + "\n"));
  if (!file) { process.stderr.write("[layerwright] inbox-watch: no CLAUDE_CODE_SESSION_ID, nothing to watch\n"); return 0; }
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, "");
  // One watcher per session: the plugin's monitor and one the agent started would announce everything twice.
  const lock = `${file}.lock`;
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    if (pid && pid !== process.pid) { process.kill(pid, 0); return 0; } // alive: it already watches
  } catch { /* no lock, or its owner is gone */ }
  writeFileSync(lock, String(process.pid));
  const unlock = () => { try { if (Number(readFileSync(lock, "utf8")) === process.pid) rmSync(lock); } catch { /* gone */ } };
  process.once("exit", unlock);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(sig, () => { unlock(); process.exit(0); });
  let pos = statSync(file).size; // only what arrives from now on
  let rest = "";
  const read = () => {
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size < pos) pos = 0; // the server started a new file
    if (size === pos) return;
    const buf = Buffer.alloc(size - pos);
    const fd = openSync(file, "r");
    try { readSync(fd, buf, 0, buf.length, pos); } finally { closeSync(fd); }
    pos = size;
    const lines = (rest + buf.toString("utf8")).split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) {
      let r: any;
      try { r = JSON.parse(l); } catch { continue; }
      if (r.stop) { out(`The user stopped request ${r.id} in the Layerwright window in Figma. Stop working on it now (tell its background subagent too, if one runs it): make no more changes for it, keep what's already done, and don't report it as done.`); continue; }
      const what = { code: "Build this in code", polish: "Polish this design", component: "Turn this into a component", mobile: "Make a mobile version", ask: "Help with this" }[r.kind as string] ?? r.kind;
      const skills = Array.isArray(r.skills) && r.skills.length ? ` with the skill${r.skills.length > 1 ? "s" : ""} ${r.skills.slice(0, 6).join(", ")}` : "";
      // From a note or an annotation: text on the canvas, which figma_inbox presents as such.
      const from = r.via === "note" || r.via === "annotation" ? `from a ${r.via} on the Figma canvas that mentions this session` : "from the Layerwright window in Figma";
      out(`Request ${r.id} ${from}: ${r.kind === "ask" && !r.text && skills ? "Apply" : what}${r.text ? ` ("${String(r.text).slice(0, 200)}")` : ""}${skills} on ${r.layers}. Call figma_inbox now and do it (if you're in the middle of another request, in a background subagent), then figma_reply with the result.`);
    }
  };
  await new Promise<void>((done) => {
    const t = setInterval(read, o.pollMs ?? 600);
    o.signal?.addEventListener("abort", () => { clearInterval(t); read(); unlock(); done(); });
  });
  return 0;
}

/** `session-hint`: the plugin's SessionStart hook. When a Figma window is connected, or was used on this computer in
 *  the last two weeks, tells the new session to start watching for requests from it (the Monitor tool), so they
 *  start the session by themselves, whichever opens first. Prints nothing otherwise. */
export async function sessionHint(o: { port?: number; self?: string; out?: (s: string) => void; recent?: boolean; project?: string } = {}): Promise<number> {
  const { probePort } = await import("./relay.ts");
  const { figmaUsedRecently } = await import("./prefs.ts");
  const { projectUsesLayerwright } = await import("./meta.ts");
  const out = o.out ?? ((s: string) => process.stdout.write(s + "\n"));
  // The agent plugin runs this hook in every Claude Code session on the computer: only a project that uses Layerwright
  // (its .layerwright folder) is told to watch for requests from Figma. Elsewhere the session stays out of Figma
  // until the user asks it for Figma work.
  if (!projectUsesLayerwright(o.project ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd())) return 0;
  const p = await probePort(o.port ?? Number(process.env.LAYERWRIGHT_PORT ?? 7331), 1200);
  const connected = p.kind === "hub" && !!(p as any).status?.pluginConnected;
  if (!connected && !(o.recent ?? figmaUsedRecently())) return 0;
  const q = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  const self = o.self ?? [process.execPath, ...process.execArgv, process.argv[1]].filter(Boolean).map(q).join(" ");
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext:
    `Layerwright: ${connected ? "a Figma window is connected" : "the Layerwright window in Figma was used on this computer recently"}. As your first action in this session, before answering, start the Monitor tool with command "${self} inbox-watch", description "Requests from the Layerwright window in Figma", timeout_ms 1800000, and start it again whenever it expires. Tell the user in one line that you're watching the Layerwright window in Figma for their requests (they can ask you to stop). It wakes you when the user sends a request from Figma; then call figma_inbox and do it.` } }));
  return 0;
}

/** The last thing the assistant said, from the end of a Claude Code transcript (JSON lines). */
export function lastAssistantText(path: string, read: (p: string) => string): string {
  let raw = "";
  try { raw = read(path); } catch { return ""; }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 400; i--) {
    let e: any;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    const m = e?.type === "assistant" ? e.message : undefined;
    const parts = Array.isArray(m?.content) ? m.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text) : typeof m?.content === "string" ? [m.content] : [];
    if (parts.length) return parts.join("\n").slice(-2000);
  }
  return "";
}

/** `hook-event`: the plugin's chat hooks. Reads Claude Code's hook input (stdin) and notes what the session is doing in
 *  its chat (asked the user a question, needs a permission, got the answer, ended its turn) for its Layerwright server,
 *  which tells the Figma window when the user should answer in Claude Code. Fast, silent, never blocks anything. */
export async function hookEvent(o: { input?: string } = {}): Promise<number> {
  const { stateFile } = await import("./meta.ts");
  const { mkdirSync, writeFileSync, openSync, readSync, fstatSync, closeSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const raw = o.input ?? (process.stdin.isTTY ? "" : await new Promise<string>((done) => {
    let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => done(s)); process.stdin.on("error", () => done(s));
  }));
  let h: any;
  try { h = JSON.parse(raw); } catch { return 0; }
  const file = stateFile(String(h?.session_id ?? process.env.CLAUDE_CODE_SESSION_ID ?? ""));
  if (!file) return 0;
  // The end of the transcript is enough to find the last message (it can be large).
  const tail = (p: string) => { const fd = openSync(p, "r"); try { const size = fstatSync(fd).size, n = Math.min(size, 512 * 1024); const b = Buffer.alloc(n); readSync(fd, b, 0, n, size - n); return b.toString("utf8"); } finally { closeSync(fd); } };
  const ev = String(h.hook_event_name ?? "");
  const tool = String(h.tool_name ?? "");
  let state: { event: string; text?: string } | undefined;
  if (ev === "PreToolUse" && tool === "AskUserQuestion") {
    const qs = h.tool_input?.questions;
    state = { event: "ask", text: String((Array.isArray(qs) ? qs[0]?.question : h.tool_input?.question) ?? "") };
  } else if ((ev === "PostToolUse" && tool === "AskUserQuestion") || ev === "UserPromptSubmit") state = { event: "answered" };
  else if (ev === "Notification" && !/idle/i.test(String(h.notification_type ?? ""))) state = { event: "permission", text: String(h.message ?? "") };
  else if (ev === "Stop") state = { event: "stop", text: typeof h.last_assistant_message === "string" ? h.last_assistant_message : h.transcript_path ? lastAssistantText(String(h.transcript_path), tail) : "" };
  if (!state) return 0;
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ ...state, at: Date.now() })); } catch { /* nothing to tell */ }
  return 0;
}

const agentList = (v?: string) => (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x): x is "claude" | "codex" => x === "claude" || x === "codex");

/** `agents [claude] [codex]`: install or refresh the agent plugin without the rest of init. */
export async function agentsCommand(args: string[], out: (s: string) => void = (s) => process.stdout.write(s + "\n")): Promise<number> {
  const { AGENT_NAMES, buildMarketplace, detectAgents, installAgent } = await import("./agents.ts");
  const { pluginServerEntry } = await import("./setup.ts");
  const found = detectAgents();
  const asked = agentList(args.join(","));
  const agents = (asked.length ? asked : found).filter((a) => found.includes(a));
  if (!agents.length) { out(found.length ? "Nothing to install." : "Neither Claude Code nor Codex is installed (no `claude` or `codex` command)."); return 1; }
  const market = buildMarketplace(pluginServerEntry());
  let failed = 0;
  for (const a of agents) { const r = installAgent(a, market); out(r.ok ? `✓ ${r.message}` : `✗ ${AGENT_NAMES[a]}: ${r.message}`); if (!r.ok) failed++; }
  return failed ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "serve") { await import("./index.ts"); return; }
  const port = (() => { const i = rest.indexOf("--port"); return i >= 0 ? Number(rest[i + 1]) : undefined; })();
  if (cmd === "import") process.exitCode = await importCommand(rest);
  else if (cmd === "fonts") process.exitCode = await fontsCommand(rest);
  else if (cmd === "report") process.exitCode = await reportCommand();
  else if (cmd === "init") {
    const i = rest.indexOf("--agents");
    const agents = rest.includes("--no-agents") ? [] : i >= 0 ? agentList(rest[i + 1]) : undefined;
    process.exitCode = await (await import("./setup.ts")).init({ port, skipInstall: rest.includes("--skip-install"), cursor: rest.includes("--cursor") ? true : undefined, agents });
  }
  else if (cmd === "plugin") process.exitCode = (await import("./setup.ts")).pluginCommand();
  else if (cmd === "claude") process.exitCode = await (await import("./agents.ts")).claudeWithChannels(rest);
  else if (cmd === "agents") process.exitCode = await agentsCommand(rest);
  else if (cmd === "inbox-watch") process.exitCode = await inboxWatch();
  else if (cmd === "session-hint") process.exitCode = await sessionHint();
  else if (cmd === "hook-event") process.exitCode = await hookEvent();
  else if (cmd === "hub") process.exitCode = await hubCommand(rest[0] && !rest[0].startsWith("--") ? rest[0] : "run", port);
  else if (cmd === "doctor") process.exitCode = await (await import("./setup.ts")).doctor({ port });
  else if (cmd === "--version" || cmd === "-v") process.stdout.write((await import("./meta.ts")).PKG_VERSION + "\n");
  else if (cmd === "help" || cmd === "--help" || cmd === "-h") process.stdout.write(HELP() + "\n");
  else { process.stderr.write(`Unknown command "${cmd}".\n${HELP()}\n`); process.exitCode = 2; }
}

// Run when executed directly. npm/npx start us through a .bin symlink, so compare real paths.
const isEntry = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isEntry) await main();
