// The MCP server's side of the shared bridge: connects to the hub (see hub.ts) as one session, and starts the hub
// first when nothing holds the port yet. Same interface as WsBridge, so the tools can't tell the difference.
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { BridgeHello, BridgeMethod, FigmaAction, FigmaActionStatus, SessionInfo } from "@cde/core";
import { BridgeError, WsBridge, type FigmaTransport } from "./bridge.ts";
import { CLOSE_KICKED, CLOSE_REPLACED, HUB_PROTOCOL } from "./hub.ts";
import { FROM_SOURCE, REPO_ROOT, pluginKey } from "./meta.ts";
import { currentTask } from "./task.ts";

type Probe = { kind: "hub"; status: any } | { kind: "legacy"; status: any } | { kind: "free" } | { kind: "unknown"; reason: string };

/** What answers on the port: a hub, an older single-session server, or nothing. */
export function probePort(port: number, timeoutMs = 1500): Promise<Probe> {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/doctor`);
    const t = setTimeout(() => { ws.terminate(); done({ kind: "unknown", reason: "timeout" }); }, timeoutMs);
    ws.on("message", (m) => {
      clearTimeout(t);
      let status: any;
      try { status = JSON.parse(String(m)); } catch { return done({ kind: "unknown", reason: "bad reply" }); }
      done(status?.hub ? { kind: "hub", status } : { kind: "legacy", status });
      ws.close();
    });
    ws.on("error", (e: any) => { clearTimeout(t); done(e.code === "ECONNREFUSED" ? { kind: "free" } : { kind: "unknown", reason: e.code ?? e.message }); });
  });
}

/** Start the hub as its own process, detached from this session, logging to ~/.layerwright/hub.log. */
export function spawnHub(port: number) {
  const home = process.env.LAYERWRIGHT_HOME ?? join(homedir(), ".layerwright");
  mkdirSync(home, { recursive: true });
  const log = openSync(join(home, "hub.log"), "a");
  const args = FROM_SOURCE
    ? ["--import", "tsx", resolve(REPO_ROOT!, "apps/mcp-server/src/cli.ts"), "hub", "--port", String(port)]
    : [fileURLToPath(import.meta.url), "hub", "--port", String(port)]; // the published bundle: this file is dist/cli.js
  // From a checkout, `--import tsx` is found from the working folder: the checkout's own node_modules. No console
  // window on Windows (closing it would kill the hub).
  const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ["ignore", log, log], env: { ...process.env, LAYERWRIGHT_HUB: "1" }, cwd: FROM_SOURCE ? REPO_ROOT : home });
  child.unref();
}

export interface RelayOptions {
  version?: string;
  workdir?: string;
  log?: (m: string) => void;
  /** How to start a hub when the port is free (tests pass an in-process one). */
  startHub?: (port: number) => void | Promise<void>;
  /** Called once, at the session's first real Figma work (any request but a status ping): index.ts marks the project
   *  as one that uses Layerwright. A status check (figma_status, /layer:help) doesn't mark it. */
  onUse?: () => void;
  /** Tests: allow ports outside the plugin's 7331–7340 so they never meet a real session. */
  anyPort?: boolean;
  /** The pairing key this session presents to the hub (default: ~/.layerwright/key, made if missing). */
  key?: () => string | undefined;
}

interface Pending { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout; method: string; timeoutMs: number; started: number }

export class RelayBridge implements FigmaTransport {
  private ws?: WebSocket;
  private hello?: BridgeHello;
  private plugin = false;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private retryTimer?: NodeJS.Timeout;
  private closed = false;
  private rejected = false;
  private client?: string;
  private title?: string;
  /** An older hub gave the port to a newer Layerwright: until then the newer session starts the hub, not this one. */
  private noSpawnUntil = 0;
  lastProgress?: { label: string; done?: number; total?: number; at: number };
  startError?: string;
  /** This session as the hub named it (shown in the plugin window). */
  session?: SessionInfo;
  /** How many sessions share the Figma connection right now. */
  sessionCount = 0;
  version: string;
  onHello?: () => void;
  private log: (m: string) => void;

  constructor(public port = Number(process.env.LAYERWRIGHT_PORT ?? process.env.CDE_PORT ?? 7331), private o: RelayOptions = {}) {
    this.version = o.version ?? "0";
    this.log = o.log ?? ((m) => process.stderr.write(`[layerwright] ${m}\n`));
  }

  private starting?: Promise<void>;
  /** The file this session worked in last: kept through a disconnect, so a reconnect comes back to it. */
  private lastFile?: string;
  /** The file each request from a Figma window came from: work for it (requestId) happens in that file. */
  private taskFiles = new Map<string, BridgeHello>();
  private lastFileName?: string;
  /** The hub moved this session to another file without it asking (the user works there now): told once (takeMoved). */
  private moved?: { from: string; to: string };
  takeMoved() { const m = this.moved; this.moved = undefined; return m; }
  /** The hub keeps one window per Figma file and answers `windows` / `bind` (1.3+; its welcome says so). */
  private hubFiles = false;
  private used = false;
  /** Connect (starting the hub if needed). Resolves once connected or after a first failed round; keeps trying.
   *  Called once: at startup in a project that uses Layerwright, else on the first Figma call (request, inbox,
   *  figma_status), so sessions that never use Figma aren't listed in the plugin window. */
  start(): Promise<void> {
    return (this.starting ??= this.startNow());
  }
  /** Joined, or joining: false until the first start(). */
  get started() { return !!this.starting; }
  join() { return this.start(); }

  private async startNow(): Promise<void> {
    if (!this.o.anyPort && (this.port < 7331 || this.port > 7340)) {
      this.startError = `Port ${this.port} is outside 7331–7340, the only ports the Figma plugin may connect to. Set LAYERWRIGHT_PORT to one of them.`;
      this.log(this.startError);
      return;
    }
    this.startError ??= "Layerwright is still connecting to Figma; try again in a moment.";
    await this.attempt();
  }

  private async attempt(): Promise<void> {
    if (this.closed) return;
    let p = await probePort(this.port);
    if (p.kind === "free" && Date.now() >= this.noSpawnUntil) {
      try { await (this.o.startHub ?? spawnHub)(this.port); } catch (e) { this.log(`couldn't start the hub: ${(e as Error).message}`); }
      for (let i = 0; i < 30 && p.kind === "free"; i++) {
        await new Promise((r) => setTimeout(r, 150));
        p = await probePort(this.port, 800);
      }
    }
    if (p.kind === "legacy") {
      this.startError = `Port ${this.port} is held by an older Layerwright${p.status?.version ? ` (${p.status.version})` : ""} that another session started, and it can't be shared. Close that session or restart it to update; this one connects by itself once the port is free.`;
      this.log(this.startError);
      return this.retry(3000);
    }
    if (p.kind === "unknown") {
      // Something that isn't Layerwright holds the port: a hub started now would only fail to take it.
      this.startError = `Port ${this.port} is held by another program that isn't Layerwright (${p.reason}), so Figma can't reach this session. Close that program, or set LAYERWRIGHT_PORT to another port from 7331–7340 (and the same port in the plugin window). Run: npx layerwright doctor`;
      this.log(this.startError);
      return this.retry(10_000);
    }
    if (p.kind !== "hub") {
      this.startError = Date.now() < this.noSpawnUntil
        ? "The shared Figma connection is moving to a newer Layerwright; this session joins it in a moment."
        : `Couldn't start the Layerwright hub on port ${this.port} (its log: ~/.layerwright/hub.log). Run: npx layerwright doctor`;
      this.log(this.startError);
      return this.retry(Date.now() < this.noSpawnUntil ? 1000 : 3000);
    }
    await this.connect();
  }

  private key(): string | undefined {
    try { return (this.o.key ?? (() => pluginKey(true)))(); } catch { return undefined; }
  }

  private connect(): Promise<void> {
    return new Promise((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/client`);
      let settled = false;
      const settle = () => { if (!settled) { settled = true; done(); } };
      const t = setTimeout(() => { ws.terminate(); }, 3000);
      // A reconnect asks for this session's id, colour and name back (the hub gives them when nobody else has them).
      const was = this.session;
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol: HUB_PROTOCOL, version: this.version, workdir: this.o.workdir ?? process.cwd(), client: this.client, title: this.title, pid: process.pid, key: this.key(),
        resume: was?.id, color: was?.color, name: was && !was.titled ? was.name : undefined, since: was?.connectedAt,
        file: this.lastFile, fileName: this.lastFileName })));
      ws.on("message", (raw) => {
        let msg: any;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type === "welcome") {
          clearTimeout(t);
          this.ws = ws;
          this.hubFiles = msg.multiFile === true;
          this.session = msg.session;
          this.sessionCount = msg.sessions ?? 1;
          this.startError = undefined;
          this.setPlugin(!!msg.plugin?.connected, msg.plugin?.hello);
          this.log(`joined the shared Figma connection as "${this.session?.name}"`);
          return settle();
        }
        if (msg.type === "rejected") { this.startError = String(msg.message); this.rejected = true; this.log(this.startError); return; }
        if (msg.type === "restarting") { this.log(String(msg.message)); return; }
        this.onMessage(msg);
      });
      ws.on("error", () => {});
      ws.on("close", (code) => {
        clearTimeout(t);
        const joined = this.ws === ws;
        if (joined) this.dropped();
        settle();
        // Removed in the Figma window: stay away until this session asks again (figma_status → rejoin).
        if (code === CLOSE_KICKED) { this.kicked = true; this.startError = "This session was removed in the Layerwright window in Figma. Call figma_status to join again."; return; }
        if (code === CLOSE_REPLACED) this.noSpawnUntil = Date.now() + 15_000;
        // A hub that was there a moment ago: back quickly. Refused: not before a while.
        if (!this.closed) this.retry(this.rejected ? 10_000 : joined ? 300 : 1500);
        this.rejected = false;
      });
    });
  }

  /** The hub went away (closed, crashed, replaced): fail what was in flight; the retry starts a new one. */
  private dropped() {
    this.ws = undefined;
    this.setPlugin(false);
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new BridgeError({ type: "PLUGIN_DISCONNECTED", message: "The shared Figma connection restarted during the request. Check the result (figma_inspect) before retrying." })); this.pending.delete(id); }
  }

  private retry(ms: number) {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { void this.attempt(); }, ms);
    this.retryTimer.unref?.();
  }

  private setPlugin(connected: boolean, hello?: BridgeHello) {
    this.plugin = connected;
    this.hello = connected ? hello ?? this.hello : undefined;
    if (this.hello) { this.lastFile = this.hello.fileKey ?? this.hello.fileName; this.lastFileName = this.hello.fileName; }
    if (connected && hello) { try { this.onHello?.(); } catch { /* listener */ } }
  }

  private onMessage(msg: any) {
    if (msg.type === "plugin") { if (msg.moved && typeof msg.moved.from === "string" && typeof msg.moved.to === "string") this.moved = { from: msg.moved.from, to: msg.moved.to }; return this.setPlugin(!!msg.connected, msg.hello); }
    if (msg.type === "sessions") { this.sessionCount = Number(msg.count) || this.sessionCount; return; }
    if (msg.type === "session" && msg.session) { this.session = msg.session; return; }
    if (msg.type === "action" && msg.action && typeof msg.action.id === "string") { this.taskFile(msg.action.id, msg.hello); try { this.onAction?.(msg.action); } catch { /* listener */ } return; }
    if (msg.type === "action-stop" && typeof msg.id === "string") { try { this.onActionStop?.(msg.id); } catch { /* listener */ } return; }
    if (msg.type === "action-drop" && typeof msg.id === "string") { try { this.onActionDrop?.(msg.id, typeof msg.by === "string" ? msg.by : undefined); } catch { /* listener */ } return; }
    if ((msg.type === "inbox-list" || msg.type === "inbox-claim" || msg.type === "windows" || msg.type === "bind") && this.asks.has(msg.rid)) { const done = this.asks.get(msg.rid)!; this.asks.delete(msg.rid); done(msg); return; }
    if (msg.type === "progress") {
      this.lastProgress = { label: String(msg.label ?? ""), done: msg.done, total: msg.total, at: Date.now() };
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        const left = Math.min(p.timeoutMs, WsBridge.MAX_MS - (Date.now() - p.started));
        p.timer = setTimeout(() => this.expire(id), Math.max(0, left));
      }
      return;
    }
    if (msg.type === "response") {
      const res = msg.res;
      const p = this.pending.get(res?.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(new BridgeError(res.error ?? { type: "FIGMA_API_ERROR", message: "Unknown plugin error" }));
    }
  }

  /** The MCP client's name (claude-code, cursor…), shown next to the session in the plugin window. */
  setClient(name: string) {
    this.client = name;
    this.send({ type: "client-info", client: name });
  }

  /** The agent's name for its task, shown in the plugin window instead of the folder name (kept across reconnects). */
  setTitle(raw: string) {
    const title = raw.replace(/\s+/g, " ").trim().slice(0, 40);
    if (title.length < 2) return;
    this.title = title;
    if (this.session) this.session = { ...this.session, name: title, titled: true }; // the hub confirms (and de-duplicates) it
    this.send({ type: "title", title });
  }

  notify(msg: Record<string, unknown>) { this.send({ type: "notify", msg }); }

  onAction?: (action: FigmaAction) => void;
  onActionDrop?: (id: string, by?: string) => void;
  onActionStop?: (id: string) => void;
  kicked = false;
  private asks = new Map<string, (msg: any) => void>();
  private async ask(msg: Record<string, unknown>): Promise<any> {
    if (!this.starting) await this.start();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return undefined;
    const rid = `k${++this.seq}`;
    return new Promise((done) => {
      const t = setTimeout(() => { this.asks.delete(rid); done(undefined); }, 3000);
      this.asks.set(rid, (m) => { clearTimeout(t); done(m); });
      this.send({ ...msg, rid });
    });
  }
  /** An older hub has one window and doesn't answer `windows` / `bind`: they're answered here instead. */
  private multiFile() { return this.hubFiles; }
  /** The Figma files open in Layerwright, and which one this session works in. */
  async windows(): Promise<{ file?: string; fileKey?: string; page?: string; current: boolean }[]> {
    if (!this.multiFile()) return this.hello ? [{ file: this.hello.fileName, fileKey: this.hello.fileKey, page: this.hello.page, current: true }] : [];
    return (await this.ask({ type: "windows" }))?.windows ?? [];
  }
  /** Work in that file from now on: a Figma link, a file key or the file's name. Its window must be open. */
  async bind(file: string): Promise<{ ok: boolean; files: string[] }> {
    if (!this.started) await this.start();
    if (!this.multiFile()) {
      const ok = !!this.hello && (this.hello.fileName === file || this.hello.fileKey === file || (!!this.hello.fileKey && file.includes(this.hello.fileKey)));
      return { ok, files: this.hello ? [this.hello.fileName] : [] };
    }
    const r = await this.ask({ type: "bind", file });
    if (r?.ok && r.hello) this.setPlugin(true, r.hello);
    return { ok: !!r?.ok, files: (r?.files ?? []).filter(Boolean) };
  }
  /** Every open request from the Figma windows, whichever session it was sent to. */
  async inboxList(): Promise<{ action: FigmaAction; status: string; session: string; sessionName?: string }[]> { return (await this.ask({ type: "inbox-list" }))?.requests ?? []; }
  /** Take a request that was sent to another session (force: the user moved it here with /layer:inbox). Refused while
   *  that session handles it: then who has it. */
  async inboxClaim(id: string, force = false): Promise<FigmaAction | undefined> { return (await this.inboxTake(id, force)).action; }
  async inboxTake(id: string, force = false): Promise<{ action?: FigmaAction; heldBy?: string; status?: string }> {
    const r = await this.ask({ type: "inbox-claim", id, force });
    if (r?.ok) this.taskFile(id, r.hello);
    return r?.ok ? { action: r.action } : { heldBy: r?.heldBy, status: r?.status };
  }
  /** Join again after being removed in the Figma window. */
  async rejoin() { if (!this.kicked) return; this.kicked = false; this.startError = undefined; await this.attempt(); }
  actionUpdate(id: string, status: FigmaActionStatus, message?: string) { this.send({ type: "action-update", id, status, message }); }

  private send(msg: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  connected() { return this.plugin && this.ws?.readyState === WebSocket.OPEN; }
  /** The file this session works in; inside the work for a request from a window, that request's file. */
  info() {
    const t = currentTask();
    const f = t ? this.taskFiles.get(t) : undefined;
    return f && !(this.hello && (f.fileKey ? f.fileKey === this.hello.fileKey : f.fileName === this.hello.fileName)) ? f : this.hello;
  }
  private taskFile(id: string, hello: unknown) {
    const h = hello as BridgeHello | undefined;
    if (!h || typeof h.fileName !== "string") return;
    this.taskFiles.delete(id);
    this.taskFiles.set(id, h);
    for (const k of this.taskFiles.keys()) { if (this.taskFiles.size <= 100) break; this.taskFiles.delete(k); }
  }

  request<T>(method: BridgeMethod, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.starting) return this.start().then(() => this.request<T>(method, params, timeoutMs)); // first Figma call: join now
    if (!this.connected()) {
      return Promise.reject(new BridgeError({ type: "PLUGIN_DISCONNECTED", message: this.startError ?? `Figma plugin is not connected. In Figma desktop: Plugins → Development → "Layerwright" (it connects to ws://localhost:${this.port}).` }));
    }
    const id = `r${++this.seq}`;
    if (method !== "ping" && !this.used) { this.used = true; try { this.o.onUse?.(); } catch { /* a hint only */ } }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.expire(id), timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, timeoutMs, started: Date.now() });
      const task = currentTask();
      this.send({ type: "request", id, method, params, task, taskFile: task ? this.taskFiles.get(task)?.fileKey : undefined });
    });
  }

  private expire(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.send({ type: "cancel", id }); // the hub stops waiting for it too (a late answer is dropped there)
    const took = Math.round((Date.now() - p.started) / 1000);
    const last = this.lastProgress && Date.now() - this.lastProgress.at < 5 * 60_000 ? ` Its last progress was "${this.lastProgress.label}".` : "";
    p.reject(new BridgeError({ type: "TIMEOUT", message: `Figma did not answer "${p.method}" after ${took}s without progress.${last} The operation may still be running; inspect before retrying.` }));
  }
}
