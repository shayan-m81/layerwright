// The shared bridge: several sessions (RelayBridge) through one hub to one plugin, and what happens when the hub
// goes away, when an older single-session server holds the port, and when a session leaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { CLOSE_REPLACED, HUB_PROTOCOL, Hub } from "../src/hub.ts";
import { pluginKey } from "../src/meta.ts";
import { RelayBridge, probePort, spawnHub } from "../src/relay.ts";

// This computer's pairing key, in a home of its own: the hubs and sessions below read it from there by default.
process.env.LAYERWRIGHT_HOME = mkdtempSync(join(tmpdir(), "lw-hub-"));
const KEY = pluginKey(true)!;

const quiet = () => {};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out waiting"); await wait(20); }
}

/** A fake Figma plugin (paired: it has this computer's key): answers every request with who asked, records what it
 *  was sent. `silent` methods are never answered. */
function fakePlugin(port: number, o: { protocol?: number; key?: string | null; origin?: string } = {}) {
  const got: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, o.origin ? { origin: o.origin } : {});
  ws.on("error", () => {});
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", fileName: "TEST", page: "Page 1", protocol: o.protocol ?? 2, key: o.key === null ? undefined : o.key ?? KEY })));
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    got.push(m);
    if (m.method === "slow") {
      // 200 ms of work against a 100 ms timeout, reporting progress every 60 ms.
      for (const at of [0, 60, 120, 180]) setTimeout(() => ws.send(JSON.stringify({ type: "progress", label: "Working" })), at);
      setTimeout(() => ws.send(JSON.stringify({ id: m.id, ok: true, result: { by: m.session?.name } })), 200);
      return;
    }
    if (m.method === "silent") return;
    if (m.method) ws.send(JSON.stringify({ id: m.id, ok: true, result: { by: m.session?.name, method: m.method } }));
  });
  return { ws, got, open: () => new Promise<void>((r) => ws.once("open", () => r())) };
}

test("two sessions share one plugin: each request is tagged with its session and answered to that session only", async () => {
  const port = 17339;
  const hub = new Hub(port, { log: quiet, version: "9.0.0" });
  assert.equal(await hub.start(), undefined);
  const a = new RelayBridge(port, { log: quiet, workdir: "/work/shop", startHub: () => {}, anyPort: true });
  const b = new RelayBridge(port, { log: quiet, workdir: "/work/shop", startHub: () => {}, anyPort: true });
  await a.start(); await b.start();
  assert.equal(a.session?.name, "shop");
  assert.equal(b.session?.name, "shop 2", "same folder: names are told apart");
  assert.notEqual(a.session?.color, b.session?.color);

  const plugin = fakePlugin(port);
  await until(() => a.connected() && b.connected());
  assert.equal(a.info()?.fileName, "TEST");

  const [ra, rb] = await Promise.all([a.request<any>("inspect", {}), b.request<any>("ping", {})]);
  assert.deepEqual(ra, { by: "shop", method: "inspect" });
  assert.deepEqual(rb, { by: "shop 2", method: "ping" });

  // The plugin learns who is connected (it speaks protocol 2), with the MCP client's name once it is known.
  a.setClient("claude-code");
  await until(() => plugin.got.some((m) => m.type === "sessions" && m.sessions.some((s: any) => s.client === "claude-code")));
  const last = plugin.got.filter((m) => m.type === "sessions").at(-1);
  assert.deepEqual(last.sessions.map((s: any) => s.name), ["shop", "shop 2"]);

  // Progress keeps a long request alive past its own timeout.
  assert.deepEqual(await b.request<any>("slow" as any, {}, 100), { by: "shop 2" });

  // One session leaving changes nothing for the other.
  a.close();
  await until(() => plugin.got.filter((m) => m.type === "sessions").at(-1).sessions.length === 1);
  assert.deepEqual(await b.request<any>("ping", {}), { by: "shop 2", method: "ping" });
  const st = await probePort(port);
  assert.equal(st.kind, "hub");
  assert.equal((st as any).status.sessions.length, 1);

  b.close(); plugin.ws.close(); hub.close();
});

test("an older plugin (no protocol) never gets session messages it would mistake for requests", async () => {
  const port = 17338;
  const hub = new Hub(port, { log: quiet });
  await hub.start();
  const a = new RelayBridge(port, { log: quiet, workdir: "/x/app", startHub: () => {}, anyPort: true });
  await a.start();
  const plugin = fakePlugin(port, { protocol: 0 });
  await until(() => a.connected());
  await a.request("ping", {});
  a.notify({ type: "session-state", waiting: true, kind: "question" });
  a.actionUpdate("q1", "done", "ok");
  a.notify({ type: "server-info", version: "1.0.0" });
  await until(() => plugin.got.some((m) => m.type === "server-info"));
  assert.deepEqual(plugin.got.filter((m) => !m.method).map((m) => m.type), ["server-info"], "no pairing, sessions, action-update or session-state");
  a.close(); plugin.ws.close(); hub.close();
});

test("a session passes only its own kinds of notice to the window, as plain fields", async () => {
  const port = 17325;
  const hub = new Hub(port, { log: quiet });
  await hub.start();
  const a = new RelayBridge(port, { log: quiet, workdir: "/x/app", startHub: () => {}, anyPort: true });
  await a.start();
  const plugin = fakePlugin(port);
  await until(() => a.connected());
  a.notify({ type: "sessions", sessions: [{ id: "x", name: "fake" }] });
  a.notify({ type: "skills", skills: [] });
  a.notify({ id: "fake~1", method: "editNodes", params: {} });
  a.notify({ type: "session-state", waiting: true, kind: "question", text: "Which one?", extra: "<img>" });
  await until(() => plugin.got.some((m) => m.type === "session-state"));
  assert.deepEqual(plugin.got.find((m) => m.type === "session-state"), { type: "session-state", waiting: true, kind: "question", text: "Which one?", session: a.session!.id });
  assert.ok(!plugin.got.some((m) => m.method || m.type === "skills" || (m.type === "sessions" && m.sessions.some((s: any) => s.name === "fake"))));
  a.close(); plugin.ws.close(); hub.close();
});

test("a web page can't reach the hub: no status, no stop, no session, no plugin place; Layerwright's own processes and the plugin window can", async () => {
  const port = 17324;
  const hub = new Hub(port, { log: quiet });
  await hub.start();
  const refused = (path: string, origin?: string) => new Promise<boolean>((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
    ws.on("unexpected-response", () => done(true));
    ws.on("error", () => done(true));
    ws.on("open", () => { ws.close(); done(false); });
  });
  for (const path of ["/doctor", "/stop", "/client", "/"]) assert.equal(await refused(path, "https://evil.example"), true, `${path} from a web page`);
  for (const path of ["/doctor", "/stop", "/client"]) assert.equal(await refused(path, "null"), true, `${path} with Origin: null`);
  assert.equal((await probePort(port)).kind, "hub", "doctor and sessions (no Origin) still get in");
  // The Figma plugin window sends Origin: null.
  const plugin = fakePlugin(port, { origin: "null" });
  await until(() => plugin.got.some((m) => m.type === "pairing" && m.paired));
  // A session without this computer's key is refused.
  const stranger = new RelayBridge(port, { log: quiet, startHub: () => {}, anyPort: true, key: () => "not-the-key" });
  await stranger.start();
  await until(() => /pairing key/.test(stranger.startError ?? ""));
  assert.equal(hub.sessions().length, 0);
  stranger.close(); plugin.ws.close(); hub.close();
});

test("when the hub goes away, a session starts a new one and the plugin comes back to it", async () => {
  const port = 17337;
  const hubs: Hub[] = [];
  const startHub = async () => { const h = new Hub(port, { log: quiet }); if (!(await h.start())) hubs.push(h); };
  const a = new RelayBridge(port, { log: quiet, workdir: "/p/one", startHub, anyPort: true });
  const b = new RelayBridge(port, { log: quiet, workdir: "/p/two", startHub, anyPort: true });
  await a.start(); await b.start(); // nothing on the port: the first one starts the hub, the second joins it
  assert.equal(hubs.length, 1);
  let plugin = fakePlugin(port);
  await until(() => a.connected() && b.connected());

  hubs[0].close(); // e.g. the hub process was killed
  await until(() => !a.connected());
  await until(() => hubs.length === 2, 5000);
  plugin = fakePlugin(port); // the real plugin retries by itself every few seconds
  await until(() => a.connected() && b.connected(), 5000);
  assert.deepEqual(await b.request<any>("ping", {}), { by: "two", method: "ping" });
  a.close(); b.close(); plugin.ws.close(); hubs.forEach((h) => h.close());
});

test("an older single-session server on the port is reported plainly, and the session takes over once it's gone", async () => {
  const port = 17336;
  // What layerwright 0.2.x answers: a /doctor reply without `hub`; any other connection would replace its plugin.
  const { WebSocketServer } = await import("ws");
  const legacy = new WebSocketServer({ host: "127.0.0.1", port });
  let displaced = 0;
  legacy.on("connection", (ws, req) => {
    if (req.url?.startsWith("/doctor")) { ws.send(JSON.stringify({ type: "doctor", version: "0.2.2", port, pluginConnected: true })); ws.close(); return; }
    displaced++;
  });
  await new Promise((r) => legacy.once("listening", r));
  const hubs: Hub[] = [];
  const startHub = async () => { const h = new Hub(port, { log: quiet }); if (!(await h.start())) hubs.push(h); };
  const a = new RelayBridge(port, { log: quiet, workdir: "/p/a", startHub, anyPort: true });
  await a.start();
  assert.match(a.startError ?? "", /held by an older Layerwright \(0\.2\.2\)/);
  await assert.rejects(a.request("ping"), (e: any) => /older Layerwright/.test(e.detail.message));
  assert.equal(displaced, 0, "probing the port never took the plugin's place on the old server");
  await new Promise((r) => legacy.close(r));
  await until(() => hubs.length === 1, 6000);
  const plugin = fakePlugin(port);
  await until(() => a.connected(), 5000);
  assert.equal(a.startError, undefined);
  a.close(); plugin.ws.close(); hubs.forEach((h) => h.close());
});

test("the hub stops by itself when no session is left, and on request when idle", async () => {
  const port = 17335;
  let exited = "";
  const hub = new Hub(port, { log: quiet, idleMs: 100, onExit: (r) => { exited = r; } });
  await hub.start();
  const a = new RelayBridge(port, { log: quiet, startHub: () => {}, anyPort: true });
  await a.start();
  await wait(200);
  assert.equal(exited, "", "a connected session keeps it alive");
  a.close();
  await until(() => exited !== "");
  assert.match(exited, /no session/);

  let exited2 = "";
  const hub2 = new Hub(port, { log: quiet, onExit: (r) => { exited2 = r; } });
  await hub2.start();
  const r: any = await new Promise((done) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/stop`); ws.on("message", (m) => done(JSON.parse(String(m)))); });
  assert.equal(r.stopping, true);
  await until(() => exited2 !== "");
  hub.close(); hub2.close();
});

test("a request with no plugin connected fails at once with how to connect", async () => {
  const port = 17334;
  const hub = new Hub(port, { log: quiet });
  await hub.start();
  const a = new RelayBridge(port, { log: quiet, startHub: () => {}, anyPort: true });
  await a.start();
  assert.equal(a.connected(), false);
  await assert.rejects(a.request("ping"), (e: any) => e.detail.type === "PLUGIN_DISCONNECTED");
  a.close(); hub.close();
});

test("a session's title replaces its folder name in the plugin window, stays unique, and survives a reconnect", async () => {
  const port = 17330;
  const hub = new Hub(port, { log: quiet });
  await hub.start();
  const a = new RelayBridge(port, { log: quiet, workdir: "/work/shop", startHub: () => {}, anyPort: true });
  const b = new RelayBridge(port, { log: quiet, workdir: "/work/admin", startHub: () => {}, anyPort: true });
  await a.start(); await b.start();
  const plugin = fakePlugin(port);
  await until(() => a.connected() && b.connected());
  assert.equal(a.session?.titled, undefined);

  a.setTitle("  Checkout   redesign ");
  b.setTitle("Checkout redesign");
  const names = () => plugin.got.filter((m) => m.type === "sessions").at(-1)?.sessions.map((s: any) => s.name);
  await until(() => JSON.stringify(names()) === JSON.stringify(["Checkout redesign", "Checkout redesign 2"]));
  await until(() => b.session?.name === "Checkout redesign 2");
  assert.equal(a.session?.titled, true);
  assert.equal((await a.request<any>("ping", {})).by, "Checkout redesign");

  // A one-letter title is ignored: the name stays as it was.
  a.setTitle("x");
  await wait(80);
  assert.equal(names()[0], "Checkout redesign");

  // The hub restarts: the session comes back under its title, not its folder.
  hub.close();
  const hub2 = new Hub(port, { log: quiet });
  await hub2.start();
  await until(() => hub2.sessions().length === 2, 5000);
  assert.ok(hub2.sessions().some((s) => s.name.startsWith("Checkout redesign") && s.titled));

  a.close(); b.close(); plugin.ws.close(); hub2.close();
});

test("requests from the Figma window: only a paired window sends them, each reaches its session, and progress comes back", async () => {
  const port = 17329;
  const hub = new Hub(port, { log: quiet, key: () => "k-123" });
  await hub.start();
  const a = new RelayBridge(port, { log: quiet, workdir: "/work/shop", startHub: () => {}, anyPort: true, key: () => "k-123" });
  const b = new RelayBridge(port, { log: quiet, workdir: "/work/admin", startHub: () => {}, anyPort: true, key: () => "k-123" });
  const gotA: any[] = [], gotB: any[] = [];
  a.onAction = (x) => gotA.push(x);
  b.onAction = (x) => gotB.push(x);
  await a.start(); await b.start();

  // An unpaired window (no key, or another computer's): told how to pair, closed, never the plugin; an older one is
  // only closed (it would take the message for a request).
  const stranger = fakePlugin(port, { key: null });
  await until(() => stranger.got.some((m) => m.type === "rejected"));
  assert.match(stranger.got.find((m) => m.type === "rejected").message, /npx layerwright plugin/);
  await until(() => stranger.ws.readyState === WebSocket.CLOSED);
  const old = fakePlugin(port, { key: null, protocol: 0 });
  await until(() => old.ws.readyState === WebSocket.CLOSED);
  assert.deepEqual(old.got, []);
  assert.equal(a.connected(), false, "no session ever saw them as the plugin");
  const action = { id: "q1", kind: "code", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: 1 };

  // The paired window: its request goes to that session only, and the session's progress comes back tagged.
  const plugin = fakePlugin(port, { key: "k-123" });
  await until(() => plugin.got.some((m) => m.type === "pairing" && m.paired));
  assert.equal((await probePort(port) as any).status.pluginPaired, true);
  plugin.ws.send(JSON.stringify({ type: "action", session: a.session!.id, action }));
  await until(() => gotA.length === 1);
  assert.deepEqual(gotA[0], action);
  assert.equal(gotB.length, 0);
  a.actionUpdate("q1", "done", "Card.tsx updated");
  await until(() => plugin.got.some((m) => m.type === "action-update" && m.status === "done"));
  assert.deepEqual(plugin.got.find((m) => m.type === "action-update" && m.status === "done"), { type: "action-update", id: "q1", status: "done", message: "Card.tsx updated", session: a.session!.id });
  // The key never reaches the sessions.
  assert.equal((a.info() as any).key, undefined);

  // A session that left: the window is told.
  const gone = b.session!.id;
  b.close();
  await until(() => hub.sessions().length === 1);
  plugin.ws.send(JSON.stringify({ type: "action", session: gone, action: { ...action, id: "q2" } }));
  await until(() => plugin.got.some((m) => m.type === "action-update" && m.id === "q2"));
  assert.match(plugin.got.find((m) => m.id === "q2").message, /closed/);

  // An unpaired page can't push the paired window out; another paired one (the window reopened) can.
  const intruder = fakePlugin(port);
  await until(() => intruder.got.some((m) => m.type === "rejected"));
  assert.ok(a.connected(), "the paired window is still the plugin");
  const reopened = fakePlugin(port, { key: "k-123" });
  await until(() => reopened.got.some((m) => m.type === "pairing" && m.paired));
  await until(() => plugin.ws.readyState === WebSocket.CLOSED);

  a.close(); reopened.ws.close(); hub.close();
});

test("a session takes a request sent to another only when nobody is on it or the user moves it (/layer:inbox there), never one being worked on; the window can remove a session for good", async () => {
  const port = 17327;
  const hub = new Hub(port, { log: quiet, key: () => "k-1" });
  await hub.start();
  const a = new RelayBridge(port, { log: quiet, workdir: "/work/a", startHub: () => {}, anyPort: true, key: () => "k-1" });
  const b = new RelayBridge(port, { log: quiet, workdir: "/work/b", startHub: () => {}, anyPort: true, key: () => "k-1" });
  const dropped: string[] = [];
  a.onAction = () => {}; a.onActionDrop = (id) => dropped.push(id);
  await a.start(); await b.start();
  const plugin = fakePlugin(port, { key: "k-1" });
  await until(() => plugin.got.some((m) => m.type === "pairing" && m.paired));
  const action = { id: "q9", kind: "polish", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: 1 };
  plugin.ws.send(JSON.stringify({ type: "action", session: a.session!.id, action }));
  await until(() => true);
  await wait(50);
  const list = await b.inboxList();
  assert.deepEqual(list.map((r) => [r.action.id, r.sessionName]), [["q9", "a"]]);
  // Picked up by a watcher (automatic): a has it and may be about to start; it stays there.
  assert.deepEqual(await b.inboxTake("q9"), { heldBy: "a", status: "sent" });
  assert.equal(dropped.length, 0);
  // a starts on another one: not even the user can move that one away.
  plugin.ws.send(JSON.stringify({ type: "action", session: a.session!.id, action: { ...action, id: "q8" } }));
  await wait(50);
  a.actionUpdate("q8", "working");
  await wait(50);
  assert.deepEqual(await b.inboxTake("q8", true), { heldBy: "a", status: "working" });
  // Left alone too long: anyone may take it.
  const was = Hub.UNCLAIMED_MS;
  Hub.UNCLAIMED_MS = 0;
  plugin.ws.send(JSON.stringify({ type: "action", session: a.session!.id, action: { ...action, id: "q7" } }));
  await wait(60);
  assert.equal((await b.inboxTake("q7")).action?.id, "q7");
  Hub.UNCLAIMED_MS = was;
  await until(() => dropped.includes("q7"));
  a.actionUpdate("q8", "done"); b.actionUpdate("q7", "done");
  // Stop in the window: a is told, the request is over, a late update from a doesn't revive it, nobody can take it.
  const stops: string[] = [];
  a.onActionStop = (id) => stops.push(id);
  plugin.ws.send(JSON.stringify({ type: "action", session: a.session!.id, action: { ...action, id: "q6" } }));
  await wait(50);
  plugin.ws.send(JSON.stringify({ type: "action-stop", id: "q6" }));
  await until(() => stops.includes("q6"));
  await until(() => plugin.got.some((m) => m.type === "action-update" && m.id === "q6" && m.status === "stopped"));
  a.actionUpdate("q6", "done", "finished anyway");
  await wait(50);
  assert.ok(!plugin.got.some((m) => m.type === "action-update" && m.id === "q6" && m.status === "done"), "a stopped request stays stopped");
  assert.ok(!(await b.inboxList()).some((r) => r.action.id === "q6"));
  // The user runs /layer:inbox in b: a hasn't started q9, so it moves.
  assert.deepEqual(await b.inboxClaim("q9", true), action);
  await until(() => dropped.includes("q9"));
  await until(() => plugin.got.some((m) => m.type === "action-update" && m.id === "q9" && m.session === b.session!.id && /Picked up by b/.test(m.message)));
  b.actionUpdate("q9", "done", "ok");
  await wait(50);
  assert.deepEqual(await a.inboxList(), [], "done: nobody else picks it up");

  // Removed in the window: it stays away until it asks to join again.
  plugin.ws.send(JSON.stringify({ type: "kick", session: a.session!.id }));
  await until(() => a.kicked);
  // The window keeps it in the list as removed (faded), so it doesn't just vanish.
  const lastSessions = () => [...plugin.got].reverse().find((m) => m.type === "sessions");
  await until(() => lastSessions()?.removed?.some((r: any) => r.id === a.session!.id));
  assert.equal(lastSessions().sessions.length, 1);
  assert.deepEqual(hub.status().removed.map((r: any) => r.name), [a.session!.name], "doctor / hub status show it too");
  await wait(400);
  assert.equal(hub.sessions().length, 1, "it didn't come back by itself");
  await a.rejoin();
  await until(() => hub.sessions().length === 2);
  await until(() => lastSessions()?.sessions.length === 2 && !lastSessions().removed.length, 3000);

  a.close(); b.close(); plugin.ws.close(); hub.close();
});

test("a removed session whose process has exited drops out of the window's Removed list", async () => {
  const port = 17318;
  const hub = new Hub(port, { log: quiet });
  await hub.start();
  const plugin = fakePlugin(port);
  await plugin.open();
  // A session that says it's a process that doesn't exist (pid 2^31-2): once removed, it's never coming back.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/client`);
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify({ type: "hello", protocol: HUB_PROTOCOL, key: KEY, workdir: "/tmp/gone", pid: 2 ** 31 - 2 }));
  await until(() => hub.sessions().length === 1);
  const id = hub.sessions()[0].id;
  await until(() => plugin.got.some((m) => m.type === "pairing"));
  plugin.ws.send(JSON.stringify({ type: "kick", session: id }));
  await until(() => hub.sessions().length === 0);
  assert.deepEqual(hub.removedList(), [], "a closed session isn't listed as removed");
  plugin.ws.close(); hub.close();
});

test("the hub's log lines carry the local time", async () => {
  const { logTime } = await import("../src/cli.ts");
  assert.equal(logTime(new Date(2026, 9, 6, 2, 11, 3)), "2026-10-06 02:11:03");
});

test("the plugin's SessionStart hook: tells a new session to start watching when a Figma window is connected or was used recently", async () => {
  const { sessionHint } = await import("../src/cli.ts");
  const port = 17326;
  const hub = new Hub(port, { log: quiet });
  await hub.start();
  const out: string[] = [];
  const push = (s: string) => { out.push(s); };
  await sessionHint({ port, self: "node cli.js", out: push, recent: false });
  assert.deepEqual(out, [], "no Figma window, none used lately: nothing said");
  await sessionHint({ port, self: "node cli.js", out: push, recent: true });
  assert.match(JSON.parse(out.pop()!).hookSpecificOutput.additionalContext, /used on this computer recently[\s\S]*"node cli\.js inbox-watch"/, "used lately: watch before the window is open again");
  const plugin = fakePlugin(port);
  await until(() => plugin.got.some((m) => m.type === "pairing"));
  await sessionHint({ port, self: "node cli.js", out: push, recent: false });
  const ctx = JSON.parse(out[0]).hookSpecificOutput;
  assert.equal(ctx.hookEventName, "SessionStart");
  assert.match(ctx.additionalContext, /start the Monitor tool with command "node cli\.js inbox-watch"/);
  assert.match(ctx.additionalContext, /Tell the user in one line/, "the watcher is mentioned, never started silently");
  assert.doesNotMatch(ctx.additionalContext, /silently/);
  plugin.ws.close(); hub.close();
});

test("nothing stays in flight: a reopened window fails what the old one had, a request the session gave up on is dropped, and late answers are ignored", async () => {
  const port = 17323;
  const hub = new Hub(port, { log: quiet });
  await hub.start();
  const a = new RelayBridge(port, { log: quiet, workdir: "/work/shop", startHub: () => {}, anyPort: true });
  await a.start();
  const first = fakePlugin(port);
  await until(() => a.connected());
  const lost = a.request("silent" as any, {}, 60_000);
  await until(() => first.got.some((m) => m.method === "silent"));
  // The window is reopened before the old socket's close arrives: the request fails now, not after a minute.
  const second = fakePlugin(port);
  await assert.rejects(lost, (e: any) => e.detail.type === "PLUGIN_DISCONNECTED" && /replaced/.test(e.detail.message));
  const stale = first.got.find((m) => m.method === "silent").id;
  first.ws.send(JSON.stringify({ id: stale, ok: true, result: "late" })); // the old window answers anyway: nobody hears it
  await until(() => a.connected());
  assert.deepEqual(await a.request<any>("ping", {}), { by: "shop", method: "ping" });

  // The session times out: the hub stops waiting too, so `hub stop` isn't blocked by it.
  await assert.rejects(a.request("silent" as any, {}, 80), (e: any) => e.detail.type === "TIMEOUT");
  await wait(50);
  const r: any = await new Promise((done) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/stop`); ws.on("message", (m) => done(JSON.parse(String(m)))); });
  assert.equal(r.stopping, true, "no request is left in flight");
  a.close(); first.ws.close(); second.ws.close(); hub.close();
});

test("a session that reconnects keeps its id, colour and name; one whose id is in use gets a new one", async () => {
  const port = 17322;
  let hub = new Hub(port, { log: quiet });
  await hub.start();
  const a = new RelayBridge(port, { log: quiet, workdir: "/work/shop", startHub: () => {}, anyPort: true });
  const b = new RelayBridge(port, { log: quiet, workdir: "/work/shop", startHub: () => {}, anyPort: true });
  await a.start(); await b.start();
  const before = { a: a.session!, b: b.session! };
  assert.equal(before.b.name, "shop 2");
  hub.close();
  hub = new Hub(port, { log: quiet });
  await hub.start();
  await until(() => hub.sessions().length === 2, 5000);
  const back = new Map(hub.sessions().map((s) => [s.id, s]));
  for (const s of [before.a, before.b]) {
    assert.equal(back.get(s.id)?.name, s.name, "whichever comes back first, names don't swap");
    assert.equal(back.get(s.id)?.color, s.color);
  }
  // Someone else asks for an id a live session has: it gets its own.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/client`);
  const welcome: any = await new Promise((done) => { ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol: HUB_PROTOCOL, key: KEY, resume: before.a.id, color: before.a.color }))); ws.on("message", (m) => done(JSON.parse(String(m)))); });
  assert.equal(welcome.type, "welcome");
  assert.notEqual(welcome.session.id, before.a.id);
  assert.notEqual(welcome.session.color, before.a.color);
  ws.close(); a.close(); b.close(); hub.close();
});

test("an older hub gives the port to a newer session once, and its own sessions wait for the newer hub instead of starting an old one", async () => {
  const port = 17321;
  let exits = 0;
  const hub = new Hub(port, { log: quiet, onExit: () => { exits++; } });
  await hub.start();
  let started = 0;
  const a = new RelayBridge(port, { log: quiet, startHub: () => { started++; }, anyPort: true });
  await a.start();
  const newer = () => new Promise<void>((done) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/client`); ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol: HUB_PROTOCOL + 1 }))); ws.on("close", () => done()); });
  const codes: number[] = [];
  (a as any).ws.on("close", (c: number) => codes.push(c));
  await Promise.all([newer(), newer()]);
  await until(() => exits > 0);
  await wait(800);
  assert.equal(exits, 1);
  assert.deepEqual(codes, [CLOSE_REPLACED]);
  assert.equal(started, 0, "the newer session starts the hub");
  assert.match(a.startError ?? "", /moving to a newer Layerwright/);
  a.close();
});

test("a port held by something that isn't Layerwright: said plainly, and no hub is started to fight over it", async () => {
  const port = 17320;
  const squatter = tcpServer((s) => { s.on("error", () => {}); }); // accepts, never answers
  await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", () => r()));
  let started = 0;
  const a = new RelayBridge(port, { log: quiet, startHub: () => { started++; }, anyPort: true });
  const t0 = Date.now();
  await a.start();
  assert.ok(Date.now() - t0 < 5000, "the first round ends quickly");
  assert.equal(started, 0);
  assert.match(a.startError ?? "", /isn't Layerwright \(timeout\)/);
  a.close();
  squatter.close();
});

test("the hub starts from a checkout (node --import tsx), whatever folder the session runs in", async () => {
  const port = 17319;
  spawnHub(port);
  const end = Date.now() + 20_000;
  let p = await probePort(port);
  while (p.kind !== "hub" && Date.now() < end) { await wait(200); p = await probePort(port); }
  assert.equal(p.kind, "hub");
  const r: any = await new Promise((done) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/stop`); ws.on("message", (m) => done(JSON.parse(String(m)))); });
  assert.equal(r.stopping, true);
});
