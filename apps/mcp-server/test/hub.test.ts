// The shared bridge: several sessions (RelayBridge) through one hub to one plugin, and what happens when the hub
// goes away, when an older single-session server holds the port, and when a session leaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Hub } from "../src/hub.ts";
import { RelayBridge, probePort } from "../src/relay.ts";

const quiet = () => {};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out waiting"); await wait(20); }
}

/** A fake Figma plugin: answers every request with who asked, records what it was sent. */
function fakePlugin(port: number, o: { protocol?: number; key?: string } = {}) {
  const got: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", fileName: "TEST", page: "Page 1", protocol: o.protocol ?? 2, key: o.key })));
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    got.push(m);
    if (m.method === "slow") {
      // 200 ms of work against a 100 ms timeout, reporting progress every 60 ms.
      for (const at of [0, 60, 120, 180]) setTimeout(() => ws.send(JSON.stringify({ type: "progress", label: "Working" })), at);
      setTimeout(() => ws.send(JSON.stringify({ id: m.id, ok: true, result: { by: m.session?.name } })), 200);
      return;
    }
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
  assert.ok(!plugin.got.some((m) => m.type === "sessions"));
  a.close(); plugin.ws.close(); hub.close();
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
  const a = new RelayBridge(port, { log: quiet, workdir: "/work/shop", startHub: () => {}, anyPort: true });
  const b = new RelayBridge(port, { log: quiet, workdir: "/work/admin", startHub: () => {}, anyPort: true });
  const gotA: any[] = [], gotB: any[] = [];
  a.onAction = (x) => gotA.push(x);
  b.onAction = (x) => gotB.push(x);
  await a.start(); await b.start();

  // An unpaired window (no key): connected, told it isn't paired, and its requests are refused.
  const stranger = fakePlugin(port);
  await until(() => stranger.got.some((m) => m.type === "pairing"));
  assert.equal(stranger.got.find((m) => m.type === "pairing").paired, false);
  const action = { id: "q1", kind: "code", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: 1 };
  stranger.ws.send(JSON.stringify({ type: "action", session: a.session!.id, action }));
  await until(() => stranger.got.some((m) => m.type === "action-update"));
  assert.match(stranger.got.find((m) => m.type === "action-update").message, /isn't paired/);
  assert.equal(gotA.length, 0);
  stranger.ws.close();

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
  const a = new RelayBridge(port, { log: quiet, workdir: "/work/a", startHub: () => {}, anyPort: true });
  const b = new RelayBridge(port, { log: quiet, workdir: "/work/b", startHub: () => {}, anyPort: true });
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
  await wait(400);
  assert.equal(hub.sessions().length, 1, "it didn't come back by itself");
  await a.rejoin();
  await until(() => hub.sessions().length === 2);

  a.close(); b.close(); plugin.ws.close(); hub.close();
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
  assert.match(ctx.additionalContext, /start the Monitor tool silently with command "node cli\.js inbox-watch"/);
  plugin.ws.close(); hub.close();
});
