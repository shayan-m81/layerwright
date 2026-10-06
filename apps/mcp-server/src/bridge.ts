// Local transport: a WebSocket server on localhost that the Figma plugin UI connects to.
// Swappable: tools only depend on the `FigmaTransport` interface.
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { BridgeHello, BridgeMethod, BridgeResponse, FigmaAction, FigmaActionStatus, StructuredError } from "@cde/core";
import { currentTask } from "./task.ts";

export interface FigmaTransport {
  connected(): boolean;
  info(): BridgeHello | undefined;
  request<T = unknown>(method: BridgeMethod, params?: unknown, timeoutMs?: number): Promise<T>;
  /** A one-way message to the plugin window (server version, update notice, what the server is doing). */
  notify?(msg: Record<string, unknown>): void;
  /** Called when the plugin (re)announces itself. */
  onHello?: () => void;
  /** Shared bridge only: the MCP client's name, shown next to this session in the plugin window. */
  setClient?(name: string): void;
  /** Shared bridge only: a meaningful name for this session (the agent's task), replacing the folder name in the plugin window. */
  setTitle?(title: string): void;
  /** Shared bridge only: a request the user sent from the Figma window to this session. */
  onAction?: (action: FigmaAction) => void;
  /** Shared bridge only: another session took one of this session's requests. */
  onActionDrop?: (id: string, by?: string) => void;
  /** Shared bridge only: the user stopped one of this session's requests in the Figma window. */
  onActionStop?: (id: string) => void;
  /** Shared bridge only: every open request from the Figma window, and taking one sent to another session. */
  inboxList?(): Promise<{ action: FigmaAction; status: string; session: string; sessionName?: string }[]>;
  inboxClaim?(id: string, force?: boolean): Promise<FigmaAction | undefined>;
  inboxTake?(id: string, force?: boolean): Promise<{ action?: FigmaAction; heldBy?: string; status?: string }>;
  /** Shared bridge only: join the Figma connection now if this session hasn't yet (outside a Layerwright project it
   *  joins on its first Figma call). */
  join?(): Promise<void>;
  /** Shared bridge only: removed in the Figma window, and joining again. */
  kicked?: boolean;
  rejoin?(): Promise<void>;
  /** Shared bridge only: how a request from the Figma window is going, shown in the window. */
  actionUpdate?(id: string, status: FigmaActionStatus, message?: string): void;
  /** Shared bridge only: this session as the plugin window shows it, and how many sessions share Figma. */
  session?: { name: string; color: string; titled?: boolean };
  sessionCount?: number;
}

export class BridgeError extends Error {
  constructor(public detail: StructuredError) { super(detail.message); }
}

/** Who may open a WebSocket on the bridge port. Browsers always send an Origin header with it and Node's `ws` never
 *  does, so a web page open in the user's browser is told apart from Layerwright's own processes: the status, stop and
 *  session paths take no Origin at all; the plugin path also takes "null", what the Figma plugin window (a sandboxed
 *  iframe) sends. Checked at the upgrade, so a refused page never gets a socket. */
export function originAllowed(url: string | undefined, origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (/^\/(doctor|stop|client)\b/.test(url ?? "/")) return false;
  return origin === "null";
}
const verifyClient = ({ req }: { req: IncomingMessage }) => originAllowed(req.url, req.headers.origin);

export class WsBridge implements FigmaTransport {
  private socket?: WebSocket;
  private wss?: WebSocketServer;
  private hello?: BridgeHello;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout; method: string; timeoutMs: number; started: number }>();
  /** Longest any request may run while the plugin keeps reporting progress. */
  static MAX_MS = 30 * 60 * 1000;
  /** The latest progress from the plugin (what it's doing right now). */
  lastProgress?: { label: string; done?: number; total?: number; at: number };
  startError?: string;

  version = "0";
  constructor(public port = Number(process.env.LAYERWRIGHT_PORT ?? process.env.CDE_PORT ?? 7331), private log: (m: string) => void = (m) => { process.stderr.write(`[layerwright] ${m}\n`); }) {}

  start(): Promise<void> {
    if (this.port < 7331 || this.port > 7340) {
      this.startError = `Port ${this.port} is outside 7331–7340, the only ports the Figma plugin may connect to. Set LAYERWRIGHT_PORT to one of them.`;
      this.log(this.startError);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wss = (this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.port, verifyClient }));
      wss.on("listening", () => { this.log(`listening on ws://localhost:${this.port}`); resolve(); });
      wss.on("error", (e: any) => {
        this.startError = e.code === "EADDRINUSE" ? `Port ${this.port} is already in use (another Claude session running the bridge?). Set LAYERWRIGHT_PORT to another port from 7331–7340 and enter the same port in the plugin window.` : String(e.message ?? e);
        this.log(this.startError);
        resolve();
      });
      wss.on("connection", (ws, req) => {
        // `doctor` probes on /doctor: answer with status and close, never displacing the plugin.
        if (req.url?.startsWith("/doctor")) {
          ws.send(JSON.stringify({ type: "doctor", version: this.version, port: this.port, pluginConnected: this.connected(), hello: this.hello }));
          ws.close();
          return;
        }
        if (this.socket && this.socket !== ws) this.socket.close(4000, "replaced by a newer plugin connection");
        this.socket = ws;
        this.log("plugin connected");
        ws.on("message", (raw) => this.onMessage(String(raw)));
        ws.on("close", () => {
          if (this.socket !== ws) return;
          this.socket = undefined;
          this.hello = undefined;
          for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new BridgeError({ type: "PLUGIN_DISCONNECTED", message: "Figma plugin disconnected during the request." })); this.pending.delete(id); }
        });
      });
    });
  }

  private onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.type === "hello") { const { key: _key, ...hello } = msg; this.hello = hello; try { this.onHello?.(); } catch { /* listener */ } return; }
    if (msg?.type === "progress") {
      // Figma is still working: give every pending request its full timeout again (up to MAX_MS in total).
      this.lastProgress = { label: String(msg.label ?? ""), done: msg.done, total: msg.total, at: Date.now() };
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        const left = Math.min(p.timeoutMs, WsBridge.MAX_MS - (Date.now() - p.started));
        p.timer = setTimeout(() => this.expire(id), Math.max(0, left));
      }
      return;
    }
    const res = msg as BridgeResponse;
    const p = this.pending.get(res.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new BridgeError(res.error ?? { type: "FIGMA_API_ERROR", message: "Unknown plugin error" }));
  }

  onHello?: () => void;

  notify(msg: Record<string, unknown>) {
    if (this.connected()) this.socket!.send(JSON.stringify(msg));
  }

  close() { this.socket?.close(); this.wss?.close(); }

  connected() { return !!this.socket && this.socket.readyState === WebSocket.OPEN; }
  info() { return this.hello; }

  request<T>(method: BridgeMethod, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.connected()) {
      return Promise.reject(new BridgeError({ type: "PLUGIN_DISCONNECTED", message: this.startError ?? `Figma plugin is not connected. In Figma desktop: Plugins → Development → "Layerwright" (it connects to ws://localhost:${this.port}).` }));
    }
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.expire(id), timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, timeoutMs, started: Date.now() });
      this.socket!.send(JSON.stringify({ id, method, params, task: currentTask() }));
    });
  }

  private expire(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const took = Math.round((Date.now() - p.started) / 1000);
    const last = this.lastProgress && Date.now() - this.lastProgress.at < 5 * 60_000 ? ` Its last progress was "${this.lastProgress.label}".` : "";
    p.reject(new BridgeError({ type: "TIMEOUT", message: `Figma did not answer "${p.method}" after ${took}s without progress.${last} The operation may still be running; inspect before retrying.` }));
  }
}
