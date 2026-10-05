// The hub: one small process per computer that owns the bridge port. The Figma plugin connects to it once, and
// every MCP server (each Claude Code or Cursor session, any project) connects to it as a client. It only routes:
// requests go to the plugin tagged with the session that sent them, answers come back to that session.
//
//   paths on ws://127.0.0.1:<port>
//     /doctor   status for `doctor` and for clients deciding what holds the port; answered, then closed
//     /client   an MCP server (RelayBridge)
//     anything  the Figma plugin (the plugin connects to the bare origin, as it always has)
//
// It isn't tied to any session: closing one doesn't touch the others, and it exits by itself once no session has
// been connected for a while.
import { basename } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { BridgeHello, FigmaAction, SessionInfo, StructuredError } from "@cde/core";
import { pluginKey } from "./meta.ts";
import { SkillStore } from "./skills.ts";

/** Bumped when the hub ⇄ client messages change incompatibly. */
export const HUB_PROTOCOL = 1;
/** Distinct, readable on light and dark Figma themes. */
export const SESSION_COLORS = ["#7c3aed", "#0d99ff", "#14ae5c", "#f24822", "#e8a200", "#e83e8c", "#00a3a3", "#8b5e3c"];

interface Client { ws: WebSocket; info: SessionInfo; pending: Set<string> }

export interface HubOptions {
  version?: string;
  log?: (m: string) => void;
  /** Exit after this long without any session (default 60 s). */
  idleMs?: number;
  /** Called when the hub stops by itself (idle, or replaced by a newer protocol). */
  onExit?: (reason: string) => void;
  /** The pairing key the plugin window must present to send requests into sessions (default: ~/.layerwright/key). */
  key?: () => string | undefined;
  /** Called when a paired plugin window says hello (the hub process remembers it for new sessions: prefs.ts). */
  onPluginSeen?: () => void;
  /** The skills the window's Skills tab shows and changes (default: the library and ~/.layerwright/skills). */
  skills?: SkillStore;
}

const SEP = "~"; // request ids on the plugin side: <session id>~<the session's own id>

export class Hub {
  private wss?: WebSocketServer;
  private plugin?: WebSocket;
  private hello?: BridgeHello;
  /** The plugin window presented this computer's pairing key: its requests may go into sessions. */
  private paired = false;
  private clients = new Map<string, Client>();
  /** Requests from the Figma window, whichever session has them, so any session can pick them up (/layer:inbox). */
  private requests = new Map<string, { action: FigmaAction; session: string; status: string; at: number; touched: number }>();
  private seq = 0;
  private idle?: NodeJS.Timeout;
  private stopping = false;
  readonly version: string;
  private log: (m: string) => void;

  constructor(public port: number, private o: HubOptions = {}) {
    this.version = o.version ?? "0";
    this.log = o.log ?? ((m) => process.stderr.write(`[layerwright hub] ${m}\n`));
  }

  /** Resolves with an error string when the port can't be taken (another hub, or an older server, has it). */
  start(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const wss = (this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.port }));
      wss.on("listening", () => { this.log(`listening on ws://localhost:${this.port}`); this.armIdle(); resolve(undefined); });
      wss.on("error", (e: any) => resolve(e.code === "EADDRINUSE" ? `Port ${this.port} is already in use.` : String(e.message ?? e)));
      wss.on("connection", (ws, req) => {
        const url = req.url ?? "/";
        if (url.startsWith("/doctor")) { ws.send(JSON.stringify(this.status())); ws.close(); return; }
        if (url.startsWith("/stop")) {
          // `layerwright hub stop`: only when nothing is in flight, so no session loses an answer.
          const busy = [...this.clients.values()].some((c) => c.pending.size);
          ws.send(JSON.stringify({ type: "stop", stopping: !busy, sessions: this.clients.size }));
          ws.close();
          if (!busy) setTimeout(() => this.exit("stopped from the command line"), 50);
          return;
        }
        if (url.startsWith("/client")) return this.addClient(ws);
        this.addPlugin(ws);
      });
    });
  }

  status() {
    return { type: "doctor", hub: true, protocol: HUB_PROTOCOL, version: this.version, port: this.port, pluginConnected: this.pluginOpen(), pluginPaired: this.pluginOpen() && this.paired, hello: this.hello,
      sessions: [...this.clients.values()].map((c) => ({ name: c.info.name, client: c.info.client, workdir: c.info.workdir, version: c.info.version })) };
  }

  sessions(): SessionInfo[] { return [...this.clients.values()].map((c) => c.info); }

  close(reason = "stopped") {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.idle);
    for (const c of this.clients.values()) c.ws.close(4001, reason);
    this.plugin?.close();
    this.wss?.close();
  }

  // ---------- plugin ----------

  private pluginOpen() { return !!this.plugin && this.plugin.readyState === WebSocket.OPEN; }

  private addPlugin(ws: WebSocket) {
    // A new window takes over once it says hello, except that an unpaired one can't push out a paired one: a web page
    // can reach localhost too, and must not take the real plugin's place.
    let adopted = false;
    ws.on("message", (raw) => {
      if (adopted) return this.fromPlugin(String(raw));
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.type !== "hello") return; // nothing goes through before hello
      if (this.pluginOpen() && this.plugin !== ws && this.paired && !this.keyMatches(msg.key)) {
        ws.send(JSON.stringify({ type: "rejected", message: "A paired Layerwright window is already connected." }));
        ws.close(4003, "a paired plugin window is already connected");
        return;
      }
      if (this.plugin && this.plugin !== ws) this.plugin.close(4000, "replaced by a newer plugin connection");
      this.plugin = ws;
      adopted = true;
      this.log("plugin connected");
      this.fromPlugin(String(raw));
    });
    ws.on("close", () => {
      if (this.plugin !== ws) return;
      this.plugin = undefined;
      this.hello = undefined;
      this.paired = false;
      for (const c of this.clients.values()) {
        for (const id of c.pending) this.toClient(c, { type: "response", res: { id, ok: false, error: { type: "PLUGIN_DISCONNECTED", message: "Figma plugin disconnected during the request." } } });
        c.pending.clear();
      }
      this.broadcastPlugin();
    });
  }

  private keyMatches(key: unknown) {
    const want = (this.o.key ?? (() => pluginKey()))();
    return !!want && key === want;
  }

  private fromPlugin(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.type === "hello") {
      const { key, ...hello } = msg; // the key stays here: sessions never see it
      this.paired = this.keyMatches(key);
      this.hello = hello;
      if (this.paired) try { this.o.onPluginSeen?.(); } catch { /* only a hint for new sessions */ }
      this.toPlugin({ type: "pairing", paired: this.paired });
      this.broadcastPlugin();
      this.sendSessions();
      return;
    }
    if (msg?.type === "action") return this.routeAction(msg);
    if (msg?.type === "action-stop" && typeof msg.id === "string") {
      // "Stop" in the window: the session that has it is told, and the request is over (later updates don't revive it).
      const r = this.requests.get(msg.id);
      if (!this.paired || !r || r.status === "done" || r.status === "failed" || r.status === "stopped") return;
      r.status = "stopped"; r.touched = Date.now();
      const c = this.clients.get(r.session);
      if (c) this.toClient(c, { type: "action-stop", id: msg.id });
      this.toPlugin({ type: "action-update", id: msg.id, status: "stopped", session: r.session, message: "Stopped" });
      this.log(`request ${msg.id} stopped from the Figma window`);
      return;
    }
    if (typeof msg?.type === "string" && msg.type.startsWith("skills-")) { void this.skillsFromPlugin(msg); return; }
    if (msg?.type === "kick" && typeof msg.session === "string") {
      // "Remove" in the window: that session is let go and doesn't come back by itself (figma_status rejoins).
      const c = this.clients.get(msg.session);
      if (c && this.paired) { this.log(`session ${c.info.name} removed from the Figma window`); c.ws.close(4002, "removed in the Figma window"); }
      return;
    }
    if (msg?.type === "progress") {
      // Long work: every session still waiting for an answer gets its deadline extended.
      for (const c of this.clients.values()) if (c.pending.size) this.toClient(c, msg);
      return;
    }
    if (typeof msg?.id !== "string") return;
    const i = msg.id.indexOf(SEP);
    if (i < 0) return;
    const c = this.clients.get(msg.id.slice(0, i));
    const own = msg.id.slice(i + 1);
    if (!c || !c.pending.delete(own)) return; // that session is gone; nobody is waiting
    this.toClient(c, { type: "response", res: { ...msg, id: own } });
  }

  private toPlugin(msg: unknown) { if (this.pluginOpen()) this.plugin!.send(JSON.stringify(msg)); }

  /** The Skills tab: the list, and (from the paired window only, since a web page can reach localhost too) turning a
   *  skill on or off, adding one from a link or pasted text, removing one of the user's own. Every session reads the
   *  same files, so a change reaches them all with their next figma_status. */
  private async skillsFromPlugin(msg: any) {
    const store = this.o.skills ?? (this.skillStore ??= new SkillStore());
    const send = (extra: Record<string, unknown> = {}) => {
      try { this.toPlugin({ type: "skills", categories: store.categories(), skills: store.list().map(({ files, ...s }) => ({ ...s, files: files.length })), ...extra }); }
      catch (e) { this.toPlugin({ type: "skills", categories: [], skills: [], error: (e as Error).message }); }
    };
    if (msg.type === "skills-get") return send();
    if (msg.type === "skills-read" && typeof msg.id === "string") {
      // A skill's page in the window. The user's own skills are theirs: only the paired window reads them.
      try {
        const s = store.get(msg.id);
        if (s?.origin === "yours" && !this.paired) throw new Error("This window isn't paired with Layerwright on this computer.");
        const r = store.read(msg.id, typeof msg.file === "string" ? msg.file : undefined);
        const { files, ...info } = r.skill;
        this.toPlugin({ type: "skill-text", id: r.skill.id, file: r.file, files, skill: info, text: r.text });
      } catch (e) { this.toPlugin({ type: "skill-text", id: msg.id, error: (e as Error).message }); }
      return;
    }
    if (!this.paired) return send({ error: "This window isn't paired with Layerwright on this computer: run npx layerwright init, then reopen the plugin." });
    try {
      if (msg.type === "skills-set" && typeof msg.id === "string") { store.setEnabled(msg.id, !!msg.on); return send(); }
      if (msg.type === "skills-remove" && typeof msg.id === "string") { store.remove(msg.id); return send({ removed: msg.id }); }
      if (msg.type === "skills-add" && typeof msg.source === "string") {
        this.toPlugin({ type: "skills-busy", source: msg.source.slice(0, 200) });
        const s = await store.add(msg.source.slice(0, 200_000));
        this.log(`skill "${s.id}" added from the Figma window`);
        return send({ added: { id: s.id, name: s.name } });
      }
    } catch (e) { return send({ error: (e as Error).message }); }
  }
  private skillStore?: SkillStore;

  /** A request from the Figma window for one session. Only a paired window may send one: it becomes a prompt. */
  private routeAction(msg: any) {
    const id = String(msg.action?.id ?? "");
    const failed = (message: string) => this.toPlugin({ type: "action-update", id, status: "failed", message, session: msg.session });
    if (!id || typeof msg.session !== "string") return;
    if (!this.paired) return failed("This plugin window isn't paired with Layerwright on this computer, so it can't send requests. Run npx layerwright init, then reopen the plugin.");
    const c = this.clients.get(msg.session);
    if (!c) return failed("That session has closed.");
    this.toClient(c, { type: "action", action: msg.action });
    this.requests.set(id, { action: msg.action, session: c.info.id, status: "sent", at: Date.now(), touched: Date.now() });
    for (const [k, r] of this.requests) if (Date.now() - r.at > 2 * 3600_000) this.requests.delete(k);
  }

  /** Whether another session may take a request from the live session that has it. Never one it works on; one it
   *  has but hasn't started (sent, queued, seen) when the user moves it (force), or when it's been left alone so long
   *  that its session clearly isn't coming (UNCLAIMED_MS). Automatic pick-ups (a watcher waking a session) mustn't pull
   *  work out of a session that is about to start it. */
  private takeable(r: { status: string; touched: number }, force: boolean) {
    if (r.status === "working" || r.status === "stopped") return false;
    return force || Date.now() - r.touched > Hub.UNCLAIMED_MS;
  }
  static UNCLAIMED_MS = 3 * 60_000;

  private openRequests() {
    return [...this.requests.values()].filter((r) => r.status !== "done" && r.status !== "failed" && r.status !== "stopped");
  }

  /** Sessions only go to a plugin that understands them; an older plugin would take them for requests. */
  private sendSessions() {
    if ((this.hello?.protocol ?? 0) >= 2) this.toPlugin({ type: "sessions", sessions: this.sessions() });
  }

  // ---------- sessions ----------

  private addClient(ws: WebSocket) {
    let c: Client | undefined;
    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!c) {
        if (msg?.type !== "hello") return;
        const proto = Number(msg.protocol ?? 0);
        if (proto !== HUB_PROTOCOL) {
          if (proto > HUB_PROTOCOL) {
            // A newer Layerwright: let it take over as soon as nobody is waiting on this hub.
            ws.send(JSON.stringify({ type: "restarting", message: "An older hub is giving the port to a newer Layerwright." }));
            ws.close();
            this.retireWhenQuiet();
          } else {
            ws.send(JSON.stringify({ type: "rejected", message: `This session runs an older Layerwright than the one sharing the Figma connection (hub ${this.version}). Update it (restart the session to get layerwright@latest).` }));
            ws.close();
          }
          return;
        }
        c = { ws, pending: new Set(), info: this.register(msg) };
        this.clients.set(c.info.id, c);
        clearTimeout(this.idle);
        this.log(`session ${c.info.name} connected (${this.clients.size} now)`);
        this.toClient(c, { type: "welcome", session: c.info, protocol: HUB_PROTOCOL, version: this.version, plugin: { connected: this.pluginOpen(), hello: this.hello }, sessions: this.clients.size });
        this.sendSessions();
        this.broadcastCount();
        return;
      }
      this.fromClient(c, msg);
    });
    ws.on("close", () => {
      if (!c || this.clients.get(c.info.id) !== c) return;
      this.clients.delete(c.info.id);
      this.log(`session ${c.info.name} left (${this.clients.size} now)`);
      this.sendSessions();
      this.broadcastCount();
      this.armIdle();
    });
  }

  /** A name no other session has ("shop", "shop 2"…). */
  private uniqueName(base: string, except?: string): string {
    const taken = new Set([...this.clients.values()].filter((c) => c.info.id !== except).map((c) => c.info.name));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
    return name;
  }

  private register(msg: any): SessionInfo {
    const id = `s${(++this.seq).toString(36)}${Date.now().toString(36).slice(-4)}`;
    // The agent's title for its task when it already has one (a reconnect); the folder name until it sends one.
    const title = cleanTitle(msg.title);
    const name = this.uniqueName(title ?? (String(msg.name || (msg.workdir ? basename(String(msg.workdir)) : "") || "Session").slice(0, 40)));
    const used = new Set([...this.clients.values()].map((c) => c.info.color));
    const color = SESSION_COLORS.find((x) => !used.has(x)) ?? SESSION_COLORS[this.seq % SESSION_COLORS.length];
    return { id, name, color, workdir: msg.workdir ? String(msg.workdir) : undefined, client: msg.client ? String(msg.client) : undefined, version: msg.version ? String(msg.version) : undefined, connectedAt: Date.now(), titled: title ? true : undefined };
  }

  private fromClient(c: Client, msg: any) {
    if (msg?.type === "request") {
      const own = String(msg.id);
      if (!this.pluginOpen()) {
        const error: StructuredError = { type: "PLUGIN_DISCONNECTED", message: `Figma plugin is not connected. In Figma desktop: Plugins → Development → "Layerwright" (it connects to ws://localhost:${this.port}).` };
        return this.toClient(c, { type: "response", res: { id: own, ok: false, error } });
      }
      c.pending.add(own);
      // The task (a request from the window this is for) gives that work its own cursor in the plugin.
      const task = typeof msg.task === "string" && msg.task ? msg.task.slice(0, 40) : undefined;
      this.toPlugin({ id: `${c.info.id}${SEP}${own}`, method: msg.method, params: msg.params, session: c.info, task });
      return;
    }
    if (msg?.type === "client-info") {
      // The MCP client's name (claude-code, cursor…) arrives after the MCP handshake.
      if (msg.client) c.info = { ...c.info, client: String(msg.client).slice(0, 40) };
      this.sendSessions();
      return;
    }
    if (msg?.type === "title") {
      // The agent named its task: the plugin window shows that instead of the folder name.
      const title = cleanTitle(msg.title);
      if (!title) return;
      c.info = { ...c.info, name: this.uniqueName(title, c.info.id), titled: true };
      this.log(`session ${c.info.id} is now "${c.info.name}"`);
      this.toClient(c, { type: "session", session: c.info });
      this.sendSessions();
      return;
    }
    if (msg?.type === "inbox-list") {
      // Every open request, whichever session it was sent to.
      this.toClient(c, { type: "inbox-list", rid: msg.rid, requests: this.openRequests().map((r) => ({ action: r.action, status: r.status, session: r.session, sessionName: this.clients.get(r.session)?.info.name })) });
      return;
    }
    if (msg?.type === "inbox-claim" && typeof msg.id === "string") {
      // A session takes a request sent to another one: one nobody is on (see takeable), or, when the user ran
      // /layer:inbox there (force), any that isn't being worked on.
      const r = this.requests.get(msg.id);
      if (!r || r.status === "done" || r.status === "failed") return this.toClient(c, { type: "inbox-claim", rid: msg.rid, ok: false });
      const prev = this.clients.get(r.session);
      if (prev && prev !== c && !this.takeable(r, !!msg.force)) return this.toClient(c, { type: "inbox-claim", rid: msg.rid, ok: false, heldBy: prev.info.name, status: r.status });
      if (prev && prev !== c) this.toClient(prev, { type: "action-drop", id: msg.id, by: c.info.name });
      r.session = c.info.id;
      r.status = "seen";
      r.touched = Date.now();
      this.toPlugin({ type: "action-update", id: msg.id, status: "seen", session: c.info.id, message: `Picked up by ${c.info.name}` });
      this.toClient(c, { type: "inbox-claim", rid: msg.rid, ok: true, action: r.action });
      return;
    }
    if (msg?.type === "action-update" && typeof msg.id === "string") {
      const r = this.requests.get(msg.id);
      if (r?.status === "stopped") return; // the user stopped it: a late update from the session doesn't revive it
      if (r) { r.status = String(msg.status); r.session = c.info.id; r.touched = Date.now(); }
      this.toPlugin({ type: "action-update", id: msg.id, status: msg.status, message: typeof msg.message === "string" ? msg.message.slice(0, 400) : undefined, session: c.info.id });
      return;
    }
    if (msg?.type === "notify" && msg.msg && typeof msg.msg === "object") {
      this.toPlugin({ ...msg.msg, session: c.info.id });
      return;
    }
  }

  private toClient(c: Client, msg: unknown) { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg)); }

  private broadcastPlugin() {
    for (const c of this.clients.values()) this.toClient(c, { type: "plugin", connected: this.pluginOpen(), hello: this.hello });
  }

  private broadcastCount() {
    for (const c of this.clients.values()) this.toClient(c, { type: "sessions", count: this.clients.size });
  }

  private armIdle() {
    clearTimeout(this.idle);
    if (this.clients.size) return;
    this.idle = setTimeout(() => { if (!this.clients.size) this.exit("no session for a while"); }, this.o.idleMs ?? 60_000);
    this.idle.unref?.();
  }

  private retireWhenQuiet() {
    const busy = () => [...this.clients.values()].some((c) => c.pending.size);
    const tick = () => { if (this.stopping) return; if (busy()) { setTimeout(tick, 500).unref?.(); return; } this.exit("replaced by a newer Layerwright"); };
    tick();
  }

  private exit(reason: string) {
    this.log(`stopping: ${reason}`);
    this.close(reason);
    this.o.onExit?.(reason);
  }
}

/** A session title as the plugin window can show it: one line, at most 40 characters. */
function cleanTitle(t: unknown): string | undefined {
  const s = typeof t === "string" ? t.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  return s.length >= 2 ? s : undefined;
}
