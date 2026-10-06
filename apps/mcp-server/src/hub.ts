// The hub: one small process per computer that owns the bridge port. The Figma plugin connects to it once, and
// every MCP server (each Claude Code or Cursor session, any project) connects to it as a client. It only routes:
// requests go to the plugin tagged with the session that sent them, answers come back to that session.
//
//   paths on ws://127.0.0.1:<port>
//     /doctor   status for `doctor` and for clients deciding what holds the port; answered, then closed
//     /stop     `layerwright hub stop`
//     /client   an MCP server (RelayBridge); it presents this computer's pairing key in its hello
//     anything  the Figma plugin (the plugin connects to the bare origin, as it always has); it presents the key too
//
// A web page in the user's browser can reach localhost as well: it is refused at the upgrade (originAllowed), and a
// window without the key never becomes the plugin.
//
// It isn't tied to any session: closing one doesn't touch the others, and it exits by itself once no session has
// been connected for a while.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { basename } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { parseFigmaLink, type BridgeHello, type FigmaAction, type SessionInfo, type StructuredError } from "@cde/core";
import { originAllowed } from "./bridge.ts";
import { pluginKey } from "./meta.ts";
import { SkillStore } from "./skills.ts";

/** Bumped when the hub ⇄ client messages change incompatibly. 2: sessions present the pairing key. */
export const HUB_PROTOCOL = 2;
/** Close codes the sessions act on: removed in the Figma window; the hub gave its port to a newer Layerwright. */
export const CLOSE_KICKED = 4002, CLOSE_REPLACED = 4004;
const UNPAIRED = "This Layerwright window isn't paired with Layerwright on this computer, so it can't connect. Run npx layerwright plugin (it reinstalls the paired plugin), then close and reopen the plugin in Figma.";

/** The same key, compared in constant time. */
function sameKey(got: unknown, want: string): boolean {
  if (typeof got !== "string" || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
/** Distinct, readable on light and dark Figma themes. */
export const SESSION_COLORS = ["#7c3aed", "#0d99ff", "#14ae5c", "#f24822", "#e8a200", "#e83e8c", "#00a3a3", "#8b5e3c"];

/** A Layerwright window in Figma: one per open file (each Figma tab runs its own). `activeAt`: the user's last
 *  selection or page change there, so an unbound session goes to the file the user is looking at. */
interface Win { id: string; ws: WebSocket; hello?: BridgeHello; paired: boolean; activeAt: number }
/** A session. `window`: the file it works in (bound on its first request, by a request sent to it from a window, or
 *  when it names the file); `usedAt`: its last request, so a binding left alone for a while is chosen again.
 *  `pending`: its requests in flight, and the window each went to. */
interface Client { ws: WebSocket; info: SessionInfo; pending: Map<string, Win>; pid?: number; window?: Win; usedAt: number; wantFile?: string }

export interface HubOptions {
  version?: string;
  log?: (m: string) => void;
  /** Exit after this long without any session (default 60 s). */
  idleMs?: number;
  /** Called when the hub stops by itself (idle, or replaced by a newer protocol). */
  onExit?: (reason: string) => void;
  /** The pairing key the plugin window and the sessions must present (default: ~/.layerwright/key, made if missing). */
  key?: () => string | undefined;
  /** Called when a paired plugin window says hello (the hub process remembers it for new sessions: prefs.ts). */
  onPluginSeen?: () => void;
  /** The skills the window's Skills tab shows and changes (default: the library and ~/.layerwright/skills). */
  skills?: SkillStore;
}

const SEP = "~"; // request ids on the plugin side: <session id>~<the session's own id>

export class Hub {
  private wss?: WebSocketServer;
  /** The open Layerwright windows, one per Figma file. */
  private windows = new Map<string, Win>();
  private clients = new Map<string, Client>();
  /** Sessions the user removed in the window, shown there (faded) until they join again or an hour passes. */
  private removed = new Map<string, { info: SessionInfo; at: number; pid?: number }>();
  /** Requests from the Figma window, whichever session has them, so any session can pick them up (/layer:inbox). */
  private requests = new Map<string, { action: FigmaAction; session: string; status: string; at: number; touched: number }>();
  private seq = 0;
  private idle?: NodeJS.Timeout;
  private stopping = false;
  private retiring = false;
  readonly version: string;
  private log: (m: string) => void;

  constructor(public port: number, private o: HubOptions = {}) {
    this.version = o.version ?? "0";
    this.log = o.log ?? ((m) => process.stderr.write(`[layerwright hub] ${m}\n`));
  }

  /** Resolves with an error string when the port can't be taken (another hub, or an older server, has it). */
  start(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const verifyClient = ({ req }: { req: IncomingMessage }) => originAllowed(req.url, req.headers.origin);
      const wss = (this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.port, verifyClient }));
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
    const w = this.active();
    return { type: "doctor", hub: true, protocol: HUB_PROTOCOL, version: this.version, port: this.port, pluginConnected: !!w, pluginPaired: this.open().some((x) => x.paired), hello: w?.hello,
      windows: this.open().map((x) => ({ file: x.hello?.fileName, fileKey: x.hello?.fileKey, page: x.hello?.page, activeAt: x.activeAt })),
      sessions: [...this.clients.values()].map((c) => ({ name: c.info.name, client: c.info.client, workdir: c.info.workdir, version: c.info.version })),
      removed: this.removedList().map((r) => ({ name: r.name, workdir: r.workdir, at: r.at })) };
  }

  sessions(): SessionInfo[] { return [...this.clients.values()].map((c) => c.info); }

  /** While removed sessions are listed, notice the ones that closed (or timed out) and update the window. */
  private removedTimer?: NodeJS.Timeout;
  private watchRemoved() {
    if (this.removedTimer) return;
    this.removedTimer = setInterval(() => {
      const before = this.removed.size;
      this.removedList();
      if (this.removed.size !== before) this.sendSessions();
      if (!this.removed.size) { clearInterval(this.removedTimer); this.removedTimer = undefined; }
    }, 15_000);
    this.removedTimer.unref?.();
  }

  /** Removed in the window and not back yet, newest first. */
  removedList(): (Pick<SessionInfo, "id" | "name" | "color" | "client" | "workdir"> & { at: number })[] {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [id, r] of this.removed) if (r.at < cutoff || (r.pid && !alive(r.pid))) this.removed.delete(id); // a closed session isn't coming back
    return [...this.removed.values()].sort((a, b) => b.at - a.at)
      .map(({ info, at }) => ({ id: info.id, name: info.name, color: info.color, client: info.client, workdir: info.workdir, at }));
  }

  close(reason = "stopped", code = 4001) {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.idle);
    clearInterval(this.removedTimer);
    for (const c of this.clients.values()) c.ws.close(code, reason);
    for (const w of this.windows.values()) w.ws.close();
    this.wss?.close();
  }

  // ---------- plugin ----------

  private open() { return [...this.windows.values()].filter((w) => w.ws.readyState === WebSocket.OPEN); }
  /** The window the user used last (selection, page, a request from it). */
  private active(): Win | undefined { return this.open().sort((a, b) => b.activeAt - a.activeAt)[0]; }
  /** Two hellos for one file: the same Figma file (its key, else its name). */
  private sameFile(a?: BridgeHello, b?: BridgeHello) {
    if (!a || !b) return false;
    return a.fileKey && b.fileKey ? a.fileKey === b.fileKey : a.fileName === b.fileName;
  }

  private addPlugin(ws: WebSocket) {
    // A window becomes a plugin window once it says hello with this computer's pairing key (init and `layerwright
    // plugin` write it into the installed window): a web page can reach localhost too, and must never get the
    // sessions' requests nor answer them. Without any key on this computer, any window may connect (unpaired, it sends
    // nothing into sessions). Each Figma file has its own window (one per tab): they all stay connected.
    let w: Win | undefined;
    ws.on("message", (raw) => {
      if (w) { if (this.windows.get(w.id) === w) this.fromPlugin(w, String(raw)); return; } // a replaced window has no say
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.type !== "hello") return; // nothing goes through before hello
      const verdict = this.pairing(ws, msg);
      if (verdict === "rejected") return;
      const id = typeof msg.window === "string" && /^w[0-9a-z]{4,24}$/.test(msg.window) ? msg.window : `w${(++this.seq).toString(36)}${Date.now().toString(36).slice(-5)}`;
      // The same window reconnecting (its id), or the plugin reopened in the same file: the new socket takes its place,
      // and the sessions working in that file stay with it. The old one is told it was replaced (it doesn't knock again).
      const prev = this.windows.get(id) ?? this.open().find((x) => x.id !== id && this.sameFile(x.hello, msg));
      w = { id, ws, paired: verdict === "paired", activeAt: Date.now() };
      if (prev) {
        this.windows.delete(prev.id);
        this.failPending(prev, "The Figma plugin window was replaced during the request. Check the result (figma_inspect) before retrying.");
        for (const c of this.clients.values()) if (c.window === prev) c.window = w;
        if (prev.ws !== ws) prev.ws.close(4000, "replaced by a newer window for this file");
      }
      this.windows.set(id, w);
      this.log(`plugin connected${msg.fileName ? ` ("${String(msg.fileName).slice(0, 60)}")` : ""} (${this.open().length} window${this.open().length === 1 ? "" : "s"})`);
      this.fromPlugin(w, String(raw), verdict);
    });
    ws.on("close", () => {
      if (!w || this.windows.get(w.id) !== w) return;
      this.windows.delete(w.id);
      this.failPending(w, "Figma plugin disconnected during the request.");
      for (const c of this.clients.values()) if (c.window === w) c.window = undefined;
      this.log(`plugin window closed${w.hello?.fileName ? ` ("${w.hello.fileName.slice(0, 60)}")` : ""} (${this.open().length} left)`);
      this.broadcastPlugin();
    });
  }

  /** Whether a window's hello carries the key. One that doesn't, while this computer has one, is told how to pair and
   *  closed (an older plugin, which would take the message for a request, is only closed). */
  private pairing(ws: WebSocket, hello: any): "paired" | "unpaired" | "rejected" {
    let want: string | undefined;
    try { want = (this.o.key ?? (() => pluginKey(true)))(); } catch { /* no key can be made: nothing to check */ }
    if (!want) return "unpaired";
    if (sameKey(hello.key, want)) return "paired";
    if (Number(hello.protocol ?? 0) >= 2) ws.send(JSON.stringify({ type: "rejected", message: UNPAIRED }));
    ws.close(4003, "not paired with this computer");
    return "rejected";
  }

  /** The requests in flight in that window fail with this: the window is gone (or was replaced). */
  private failPending(w: Win, message: string) {
    for (const c of this.clients.values()) {
      for (const [id, to] of c.pending) {
        if (to !== w) continue;
        c.pending.delete(id);
        this.toClient(c, { type: "response", res: { id, ok: false, error: { type: "PLUGIN_DISCONNECTED", message } } });
      }
    }
  }

  private fromPlugin(w: Win, raw: string, checked?: "paired" | "unpaired") {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.type === "hello") {
      // The first hello, and again whenever the page changes (or the file is renamed).
      const { key: _key, window: _w, ...hello } = msg; // the key stays here: sessions never see it
      const pairing = checked ?? this.pairing(w.ws, msg);
      if (pairing === "rejected") return;
      w.paired = pairing === "paired";
      w.hello = hello;
      w.activeAt = Date.now();
      if (w.paired) try { this.o.onPluginSeen?.(); } catch { /* only a hint for new sessions */ }
      for (const c of this.clients.values()) if (!c.window && c.wantFile && this.matches(w, c.wantFile)) c.window = w; // a session that reconnected comes back to its file
      this.toWindow(w, { type: "pairing", paired: w.paired }, true);
      this.broadcastPlugin();
      this.sendSessions();
      return;
    }
    if (msg?.type === "active") { w.activeAt = Date.now(); return; } // the user selected something or changed page there
    if (msg?.type === "action") return this.routeAction(w, msg);
    if (msg?.type === "action-stop" && typeof msg.id === "string") {
      // "Stop" in the window: the session that has it is told, and the request is over (later updates don't revive it).
      const r = this.requests.get(msg.id);
      if (!w.paired || !r || r.status === "done" || r.status === "failed" || r.status === "stopped") return;
      r.status = "stopped"; r.touched = Date.now();
      const c = this.clients.get(r.session);
      if (c) this.toClient(c, { type: "action-stop", id: msg.id });
      this.toWindows({ type: "action-update", id: msg.id, status: "stopped", session: r.session, message: "Stopped" });
      this.log(`request ${msg.id} stopped from the Figma window`);
      return;
    }
    if (typeof msg?.type === "string" && msg.type.startsWith("skills-")) { void this.skillsFromPlugin(w, msg); return; }
    if (msg?.type === "kick" && typeof msg.session === "string") {
      // "Remove" in the window: that session is let go and doesn't come back by itself (figma_status rejoins).
      const c = this.clients.get(msg.session);
      if (c && w.paired) {
        this.log(`session ${c.info.name} removed from the Figma window`);
        this.removed.set(c.info.id, { info: c.info, at: Date.now(), pid: c.pid });
        this.watchRemoved();
        c.ws.close(CLOSE_KICKED, "removed in the Figma window");
      }
      return;
    }
    if (msg?.type === "progress") {
      // Long work: every session still waiting for an answer from this window gets its deadline extended.
      for (const c of this.clients.values()) if ([...c.pending.values()].includes(w)) this.toClient(c, msg);
      return;
    }
    if (typeof msg?.id !== "string") return;
    const i = msg.id.indexOf(SEP);
    if (i < 0) return;
    const c = this.clients.get(msg.id.slice(0, i));
    const own = msg.id.slice(i + 1);
    if (!c || c.pending.get(own) !== w) return; // that session is gone, or the answer isn't this window's to give
    c.pending.delete(own);
    this.toClient(c, { type: "response", res: { ...msg, id: own } });
  }

  /** `modern`: only to a window that knows the message (protocol 2+): an older one would take it for a request. */
  private toWindow(w: Win | undefined, msg: unknown, modern = false) {
    if (!w || w.ws.readyState !== WebSocket.OPEN || (modern && (w.hello?.protocol ?? 0) < 2)) return;
    w.ws.send(JSON.stringify(msg));
  }
  private toWindows(msg: unknown, modern = true) { for (const w of this.open()) this.toWindow(w, msg, modern); }

  /** Does this window show that file? A Figma link or file key, the file's name, or the window's id. */
  private matches(w: Win, file: string) {
    const f = file.trim();
    const k = parseFigmaLink(f)?.fileKey ?? f;
    return w.id === f || (!!w.hello?.fileKey && w.hello.fileKey === k) || (!!w.hello?.fileName && w.hello.fileName.toLowerCase() === f.toLowerCase());
  }

  /** The window a session's request goes to: its file while it keeps working there; else (unbound, its window
   *  closed, or a while since it last used Figma) the only window, or the one the user used last. */
  private windowFor(c: Client): Win | undefined {
    const open = this.open();
    if (c.window && open.includes(c.window) && (open.length === 1 || Date.now() - c.usedAt < Hub.STAY_MS)) return c.window;
    const w = open.length === 1 ? open[0] : this.active();
    if (w !== c.window) { c.window = w; this.toClient(c, { type: "plugin", connected: !!w, hello: w?.hello }); }
    return w;
  }
  /** How long a session stays with its file after its last request, whatever the user looks at meanwhile. */
  static STAY_MS = 5 * 60_000;

  /** The Skills tab: the list, and (from the paired window only, since a web page can reach localhost too) turning a
   *  skill on or off, adding one from a link or pasted text, removing one of the user's own. Every session reads the
   *  same files, so a change reaches them all with their next figma_status. */
  private async skillsFromPlugin(w: Win, msg: any) {
    const store = this.o.skills ?? (this.skillStore ??= new SkillStore());
    const send = (extra: Record<string, unknown> = {}) => {
      try { this.toWindow(w, { type: "skills", categories: store.categories(), skills: store.list().map(({ files, ...s }) => ({ ...s, files: files.length })), ...extra }); }
      catch (e) { this.toWindow(w, { type: "skills", categories: [], skills: [], error: (e as Error).message }); }
    };
    if (msg.type === "skills-get") return send();
    if (msg.type === "skills-read" && typeof msg.id === "string") {
      // A skill's page in the window. The user's own skills are theirs: only the paired window reads them.
      try {
        const s = store.get(msg.id);
        if (s?.origin === "yours" && !w.paired) throw new Error("This window isn't paired with Layerwright on this computer.");
        const r = store.read(msg.id, typeof msg.file === "string" ? msg.file : undefined);
        const { files, ...info } = r.skill;
        this.toWindow(w, { type: "skill-text", id: r.skill.id, file: r.file, files, skill: info, text: r.text });
      } catch (e) { this.toWindow(w, { type: "skill-text", id: msg.id, error: (e as Error).message }); }
      return;
    }
    if (!w.paired) return send({ error: "This window isn't paired with Layerwright on this computer: run npx layerwright init, then reopen the plugin." });
    try {
      if (msg.type === "skills-set" && typeof msg.id === "string") { store.setEnabled(msg.id, !!msg.on); return send(); }
      if (msg.type === "skills-remove" && typeof msg.id === "string") { store.remove(msg.id); return send({ removed: msg.id }); }
      if (msg.type === "skills-add" && typeof msg.source === "string") {
        this.toWindow(w, { type: "skills-busy", source: msg.source.slice(0, 200) });
        const s = await store.add(msg.source.slice(0, 200_000));
        this.log(`skill "${s.id}" added from the Figma window`);
        return send({ added: { id: s.id, name: s.name } });
      }
    } catch (e) { return send({ error: (e as Error).message }); }
  }
  private skillStore?: SkillStore;

  /** A request from a Figma window for one session. Only a paired window may send one: it becomes a prompt, and the
   *  session works in that window's file from now on. */
  private routeAction(w: Win, msg: any) {
    const id = String(msg.action?.id ?? "");
    const failed = (message: string) => this.toWindow(w, { type: "action-update", id, status: "failed", message, session: msg.session }, true);
    if (!id || typeof msg.session !== "string") return;
    w.activeAt = Date.now();
    if (!w.paired) return failed("This plugin window isn't paired with Layerwright on this computer, so it can't send requests. Run npx layerwright init, then reopen the plugin.");
    const c = this.clients.get(msg.session);
    if (!c) return failed("That session has closed.");
    if (c.window !== w) { c.window = w; this.toClient(c, { type: "plugin", connected: true, hello: w.hello }); }
    c.usedAt = Date.now();
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

  /** Every window lists every session, with the file each works in. Only windows that understand them (protocol 2+). */
  private sendSessions() {
    const list = [...this.clients.values()].map((c) => ({ ...c.info, file: c.window && this.windows.get(c.window.id) === c.window ? c.window.hello?.fileName : undefined }));
    this.toWindows({ type: "sessions", sessions: list, removed: this.removedList() });
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
            ws.send(JSON.stringify({ type: "rejected", message: `This session runs an older Layerwright than the one sharing the Figma connection (hub ${this.version}). Update it: run npx layerwright@latest init in the project, then restart this session.` }));
            ws.close();
          }
          return;
        }
        // Only Layerwright's own processes, run by this user: they can read the key, a web page can't.
        let want: string | undefined;
        try { want = (this.o.key ?? (() => pluginKey(true)))(); } catch { /* no key can be made: nothing to check */ }
        if (want && !sameKey(msg.key, want)) {
          ws.send(JSON.stringify({ type: "rejected", message: "This session's pairing key (~/.layerwright/key) isn't the one the shared Figma connection uses. Both must run as the same user with the same LAYERWRIGHT_HOME; `npx layerwright hub stop` restarts the hub." }));
          ws.close();
          return;
        }
        c = { ws, pending: new Map(), info: this.register(msg), pid: Number.isInteger(msg.pid) && msg.pid > 0 ? msg.pid : undefined, usedAt: 0,
          wantFile: typeof msg.file === "string" && msg.file ? msg.file.slice(0, 200) : undefined };
        // A session that reconnects (the hub restarted) comes back to the file it worked in, when that window is open.
        if (c.wantFile) { c.window = this.open().find((x) => this.matches(x, c!.wantFile!)); if (c.window) c.usedAt = Date.now(); }
        this.clients.set(c.info.id, c);
        if (this.removed.delete(c.info.id)) this.log(`session ${c.info.name} joined again after it was removed`);
        clearTimeout(this.idle);
        this.log(`session ${c.info.name} connected (${this.clients.size} now)`);
        const shows = c.window ?? (this.open().length === 1 ? this.open()[0] : this.active());
        this.toClient(c, { type: "welcome", session: c.info, protocol: HUB_PROTOCOL, version: this.version, plugin: { connected: !!shows, hello: shows?.hello }, sessions: this.clients.size, multiFile: true });
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
    // A session that reconnects asks for its id back, so its requests and the selection it was given stay its own
    // (another session's automatic pick-up would otherwise take them at once). Unless a live session holds that id.
    const want = typeof msg.resume === "string" && /^s[0-9a-z]{1,24}$/.test(msg.resume) ? msg.resume : undefined;
    const held = want ? this.clients.get(want) : undefined;
    let id = want && held?.ws.readyState !== WebSocket.OPEN ? want : "";
    if (id && held) this.clients.delete(id); // its socket is on its way out
    while (!id || this.clients.has(id)) id = `s${(++this.seq).toString(36)}${Date.now().toString(36).slice(-4)}`;
    // The agent's title for its task when it already has one (a reconnect); else the name it had, or the folder name.
    const title = cleanTitle(msg.title);
    const name = this.uniqueName(title ?? (String(msg.name || (msg.workdir ? basename(String(msg.workdir)) : "") || "Session").slice(0, 40)));
    const used = new Set([...this.clients.values()].map((c) => c.info.color));
    const color = SESSION_COLORS.includes(msg.color) && !used.has(msg.color) ? msg.color : SESSION_COLORS.find((x) => !used.has(x)) ?? SESSION_COLORS[this.seq % SESSION_COLORS.length];
    // A reconnect keeps when it first joined: it isn't a new session, and mustn't become the window's default.
    const since = id === want && Number.isFinite(msg.since) && msg.since > 0 && msg.since <= Date.now() ? Number(msg.since) : Date.now();
    return { id, name, color, workdir: msg.workdir ? String(msg.workdir) : undefined, client: msg.client ? String(msg.client) : undefined, version: msg.version ? String(msg.version) : undefined, connectedAt: since, titled: title ? true : undefined };
  }

  private fromClient(c: Client, msg: any) {
    if (msg?.type === "request") {
      const own = String(msg.id);
      const w = this.windowFor(c);
      if (!w) {
        const error: StructuredError = { type: "PLUGIN_DISCONNECTED", message: `Figma plugin is not connected. In Figma desktop: Plugins → Development → "Layerwright" (it connects to ws://localhost:${this.port}).` };
        return this.toClient(c, { type: "response", res: { id: own, ok: false, error } });
      }
      c.pending.set(own, w);
      c.usedAt = Date.now();
      // The task (a request from the window this is for) gives that work its own cursor in the plugin.
      const task = typeof msg.task === "string" && msg.task ? msg.task.slice(0, 40) : undefined;
      this.toWindow(w, { id: `${c.info.id}${SEP}${own}`, method: msg.method, params: msg.params, session: c.info, task });
      return;
    }
    if (msg?.type === "windows") {
      // The Figma files open in Layerwright, and which one this session works in.
      const mine = this.windowFor(c);
      this.toClient(c, { type: "windows", rid: msg.rid, windows: this.open().map((x) => ({ file: x.hello?.fileName, fileKey: x.hello?.fileKey, page: x.hello?.page, current: x === mine, activeAt: x.activeAt })) });
      return;
    }
    if (msg?.type === "bind" && typeof msg.file === "string") {
      // The session names the file to work in: a Figma link, a file key, or the file's name.
      const w = this.open().find((x) => this.matches(x, msg.file));
      if (w) { c.window = w; c.usedAt = Date.now(); this.toClient(c, { type: "plugin", connected: true, hello: w.hello }); this.sendSessions(); }
      this.toClient(c, { type: "bind", rid: msg.rid, ok: !!w, hello: w?.hello, files: this.open().map((x) => x.hello?.fileName) });
      return;
    }
    if (msg?.type === "cancel") {
      // The session gave up on a request (it timed out there): nobody waits for it now, and a late answer is dropped.
      c.pending.delete(String(msg.id));
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
      this.toWindows({ type: "action-update", id: msg.id, status: "seen", session: c.info.id, message: `Picked up by ${c.info.name}` });
      this.toClient(c, { type: "inbox-claim", rid: msg.rid, ok: true, action: r.action });
      return;
    }
    if (msg?.type === "action-update" && typeof msg.id === "string") {
      const r = this.requests.get(msg.id);
      if (r?.status === "stopped") return; // the user stopped it: a late update from the session doesn't revive it
      if (r) { r.status = String(msg.status); r.session = c.info.id; r.touched = Date.now(); }
      this.toWindows({ type: "action-update", id: msg.id, status: msg.status, message: str(msg.message, 400), session: c.info.id });
      return;
    }
    if (msg?.type === "notify" && msg.msg && typeof msg.msg === "object") {
      // Only what sessions send the window (server.ts): their version and update notice, and whether they wait for
      // the user in the chat. Nothing else is passed through.
      const m = msg.msg;
      if (m.type === "server-info") this.toWindows({ type: "server-info", version: str(m.version, 40), update: m.update && typeof m.update === "object" ? m.update : undefined, session: c.info.id }, false);
      else if (m.type === "session-state") this.toWindows({ type: "session-state", waiting: !!m.waiting, kind: str(m.kind, 20), text: str(m.text, 400), session: c.info.id });
      return;
    }
  }

  private toClient(c: Client, msg: unknown) { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg)); }

  /** Each session hears about the window it works in (or would go to). */
  private broadcastPlugin() {
    for (const c of this.clients.values()) {
      const w = c.window && this.open().includes(c.window) ? c.window : this.open().length === 1 ? this.open()[0] : this.active();
      this.toClient(c, { type: "plugin", connected: !!w, hello: w?.hello });
    }
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

  /** Once, however many newer sessions knock: the sessions are told (CLOSE_REPLACED) so they wait for the newer hub
   *  instead of starting an old one again. */
  private retireWhenQuiet() {
    if (this.retiring) return;
    this.retiring = true;
    const busy = () => [...this.clients.values()].some((c) => c.pending.size);
    const tick = () => { if (this.stopping) return; if (busy()) { setTimeout(tick, 500).unref?.(); return; } this.exit("replaced by a newer Layerwright", CLOSE_REPLACED); };
    tick();
  }

  private exit(reason: string, code?: number) {
    this.log(`stopping: ${reason}`);
    this.close(reason, code);
    this.o.onExit?.(reason);
  }
}

/** Is that process still running? (Sessions run as the same user as the hub, so a signal-0 check is allowed.) */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A session title as the plugin window can show it: one line, at most 40 characters. */
function cleanTitle(t: unknown): string | undefined {
  const s = typeof t === "string" ? t.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  return s.length >= 2 ? s : undefined;
}
