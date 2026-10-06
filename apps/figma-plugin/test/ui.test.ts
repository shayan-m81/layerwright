// The plugin UI relay, run in a VM with a fake DOM and fake WebSocket: states and the port-change race.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function boot(o: { topLevel?: boolean } = {}) {
  const html = readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] ??= { id, textContent: "", innerHTML: "", value: id === "port" ? "7331" : "", style: {}, dataset: {} as Record<string, string>, onchange: null });
  const sockets: any[] = [];
  const posted: any[] = [];
  class FakeWS {
    readyState = 0; sent: string[] = []; onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void;
    constructor(public url: string) { sockets.push(this); }
    send(s: string) { this.sent.push(s); }
    close() { this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
    open() { this.readyState = 1; this.onopen?.(); }
  }
  const timers: (() => void)[] = [], delays: number[] = [];
  const listeners: Record<string, ((ev?: unknown) => void)[]> = {};
  const win: any = {
    addEventListener: (type: string, fn: (ev?: unknown) => void) => { (listeners[type] ??= []).push(fn); },
    document: { getElementById: el },
    WebSocket: FakeWS,
    parent: { postMessage: (m: any) => posted.push(m.pluginMessage) },
    setTimeout: (fn: () => void, ms?: number) => { timers.push(fn); delays.push(ms ?? 0); return timers.length; },
    clearTimeout: () => {}, setInterval: () => 0, Date, Math, Number, String, JSON, Map,
  };
  win.window = win;
  if (o.topLevel) { win.parent = win; win.postMessage = () => {}; } // a page on its own, not inside Figma's plugin iframe
  runInNewContext(script, win);
  const fromPlugin = (msg: unknown) => win.onmessage({ data: { pluginMessage: msg } });
  const fire = (type: string, ev?: unknown) => { for (const fn of listeners[type] ?? []) fn(ev); };
  return { els, el, sockets, posted, timers, delays, fromPlugin, fire };
}

test("UI states: connecting → connected (file, page, selection) → running op in plain words → friendly error", () => {
  const ui = boot();
  assert.equal(ui.els.dot.dataset.state, "disconnected");
  ui.fromPlugin({ type: "hello", hello: { type: "hello", fileName: "TEST", page: "Designs", selection: 2, pluginBuild: "2026-09-29T12:00:00.000Z" } });
  ui.sockets[0].open();
  assert.equal(ui.els.status.textContent, "Connected · no session", "the hub alone isn't a session to send to");
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [{ id: "sa", name: "shop", color: "#7c3aed", client: "claude-code" }] }) });
  assert.equal(ui.els.status.textContent, "Connected to Claude Code");
  assert.equal(ui.els.detail.textContent, "TEST · Designs · 2 layers selected");
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "r1", method: "executePlan" }) });
  assert.equal(ui.els.dot.dataset.state, "running");
  assert.equal(ui.els.status.textContent, "Building the design…");
  ui.fromPlugin({ type: "response", res: { id: "r1", ok: false, error: { type: "FIGMA_API_ERROR", message: "The font \"IRANYekanX Medium\" could not be loaded" } } });
  assert.equal(ui.els.dot.dataset.state, "connected");
  assert.equal(ui.els.error.style.display, "block");
  assert.match(ui.els.errorText.textContent, /^A font isn't installed on this computer/);
  assert.match(ui.els.errorTech.textContent, /^FIGMA_API_ERROR: The font/);
  assert.match(ui.els.activity.innerHTML, /Building the design failed/);
  assert.deepEqual(JSON.parse(ui.sockets[0].sent.at(-1)).id, "r1");
});

test("activity reads like a log for people; status checks stay quiet; an update shows a banner", () => {
  const ui = boot();
  ui.sockets[0].open();
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "r1", method: "ping" }) });
  ui.fromPlugin({ type: "response", res: { id: "r1", ok: true, result: {} } });
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "r2", method: "executePlan" }) });
  ui.fromPlugin({ type: "response", res: { id: "r2", ok: true, result: { createdRootIds: ["1", "2", "3"] } } });
  assert.match(ui.els.activity.innerHTML, /Built 3 frames/);
  assert.doesNotMatch(ui.els.activity.innerHTML, /ping/);
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "server-info", version: "0.2.0", update: { updateAvailable: true, current: "0.2.0", latest: "0.3.0", command: "npx layerwright@latest init", steps: ["Run: npx layerwright@latest init"] } }) });
  assert.equal(ui.els.update.style.display, "block");
  assert.match(ui.els.update.innerHTML, /Layerwright 0\.3\.0 is available/);
  assert.equal(ui.els.version.textContent, "Layerwright 0.2.0");
});

test("changing the port leaves exactly one live socket (stale onclose no longer reconnects)", async () => {
  const ui = boot();
  ui.sockets[0].open();
  ui.els.port.value = "7336";
  ui.els.port.onchange();
  await new Promise((r) => setTimeout(r, 0)); // let the old socket's onclose fire
  assert.equal(ui.sockets.length, 2);
  assert.equal(ui.sockets[1].url, "ws://localhost:7336");
  assert.equal(ui.timers.length, 0, "no retry was scheduled by the stale socket");
  assert.ok(ui.posted.some((m) => m.type === "set-port" && m.port === 7336));
  ui.sockets[1].open();
  assert.equal(ui.els.status.textContent, "Connected · no session");
});

test("a saved port from clientStorage is applied without re-saving; bad ports are rejected", () => {
  const ui = boot();
  ui.fromPlugin({ type: "port", port: 7337 });
  assert.equal(ui.sockets.at(-1).url, "ws://localhost:7337");
  assert.ok(!ui.posted.some((m) => m.type === "set-port"));
  ui.els.port.value = "80";
  ui.els.port.onchange();
  assert.equal(ui.els.port.value, "7331");
  // Outside the manifest's allowed range (7331–7340) it could never connect: refused too.
  ui.els.port.value = "7400";
  ui.els.port.onchange();
  assert.equal(ui.els.port.value, "7331");
});

test("after repeated failures the UI shows setup help", () => {
  const ui = boot();
  for (let i = 0; i < 3; i++) { ui.sockets.at(-1).onclose(); ui.timers.shift()!(); }
  assert.equal(ui.els.help.style.display, "block");
});

test("changes that didn't apply are explained once, with what to do", () => {
  const ui = boot();
  ui.sockets[0].open();
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "r1", method: "applyTransformations" }) });
  const failed = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, error: `Text style "Fa Text sm/Bold" can't be applied: not in this file under the id from the scan (the library may have been updated since: rescan); import from the library failed: text style import timed out after 30s (is the library enabled for this file?).` }));
  ui.fromPlugin({ type: "response", res: { id: "r1", ok: true, result: { applied: new Array(251), failed, hiddenOriginals: [] } } });
  assert.equal(ui.els.error.style.display, "block");
  assert.match(ui.els.errorText.textContent, /^20 changes couldn't be applied\. A Design System text style couldn't be applied\. The line below says why/);
  assert.match(ui.els.activity.innerHTML, /Applied 251 changes, 20 failed/);
});

test("several sessions: each is listed with what it's doing; a request for the selection asks the user, and the answer goes to the plugin", () => {
  const ui = boot();
  ui.sockets[0].open();
  const shop = { id: "sa", name: "shop", color: "#7c3aed", client: "claude-code", workdir: "/Users/me/code/shop" };
  const admin = { id: "sb", name: "admin", color: "#0d99ff", client: "cursor", workdir: "/Users/me/code/admin" };
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [shop, admin] }) });
  assert.ok(ui.posted.some((m) => m.type === "sessions" && m.sessions.length === 2), "the plugin learns who is connected");
  assert.equal(ui.els.status.textContent, "Connected · 2 sessions");
  assert.equal(ui.els.sessionsBox.style.display, "block");
  assert.match(ui.els.sessions.innerHTML, /shop.*Claude Code · …\/code\/shop.*Idle/s);

  // Work is shown per session, in the status line and in the list.
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "sb~r1", method: "editNodes", session: admin }) });
  assert.equal(ui.els.status.textContent, "Editing layers…");
  assert.match(ui.els.detail.textContent, /^for admin · /);
  assert.match(ui.els.sessions.innerHTML, /admin.*pill busy">Editing layers…/s);
  ui.fromPlugin({ type: "response", res: { id: "sb~r1", ok: true, result: { applied: [1, 2] } } });
  assert.match(ui.els.activity.innerHTML, /title="admin".*Edited layers: 2 changes/s);

  // The user selects two layers: the card offers them to either session.
  ui.fromPlugin({ type: "desk", count: 2, names: ["Button", "Card"], owner: null, asks: [] });
  assert.equal(ui.els.selCard.style.display, "block");
  assert.match(ui.els.selNames.innerHTML, /<span class="tag">Button<\/span><span class="tag">Card<\/span>/);
  assert.equal(ui.els.selHint.innerHTML, "Choose the session to send this to above. It stays your choice until you pick another.", "two sessions, no pick yet: no guess (not the newest, not the one that just worked)");
  assert.equal(ui.els.selHint.style.display, "block");
  ui.els.selChips.onclick({ target: { dataset: { act: "assign", session: "sa" } } });
  assert.deepEqual({ ...ui.posted.at(-1) }, { type: "assign-selection", session: "sa" });
  ui.fromPlugin({ type: "desk", count: 2, names: ["Button", "Card"], owner: "sa", to: "sa", why: "picked", asks: [] });
  assert.match(ui.els.selHint.innerHTML, /^Goes to <b class="who" style="--c:#7c3aed">shop<\/b>, your pick\. It stays until you pick another above\.$/, "its name in bold, in its colour");
  assert.match(ui.els.selChips.innerHTML, /aria-pressed="true"[^>]*>.*shop/s);

  // admin asks for it: a prominent card, answered with one click.
  ui.fromPlugin({ type: "desk", count: 2, names: ["Button", "Card"], owner: "sa", to: "sa", why: "picked", asks: [{ id: "a1", session: "sb" }] });
  assert.match(ui.els.asks.innerHTML, /admin wants to use your selection.*title="2 layers: Button, Card".*>Button<.*>Card<.*Use for admin/s);
  assert.match(ui.els.sessions.innerHTML, /admin.*Waiting for you/s);
  ui.els.asks.onclick({ target: { dataset: { act: "approve", id: "a1" } } });
  assert.deepEqual({ ...ui.posted.at(-1) }, { type: "answer-selection", id: "a1", ok: true });
  ui.els.asks.onclick({ target: { dataset: {}, parentElement: { dataset: { act: "deny", id: "a1" } } } });
  assert.deepEqual({ ...ui.posted.at(-1) }, { type: "answer-selection", id: "a1", ok: false });
});

test("a conflict is explained in plain words and names the session it happened to", () => {
  const ui = boot();
  ui.sockets[0].open();
  const a = { id: "sa", name: "shop", color: "#7c3aed" }, b = { id: "sb", name: "admin", color: "#0d99ff" };
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [a, b] }) });
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "sa~r2", method: "editNodes", session: a }) });
  ui.fromPlugin({ type: "response", res: { id: "sa~r2", ok: false, error: { type: "CONFLICT", message: "\"Title\" (1:2) was changed by session \"admin\" 3s ago" } } });
  assert.match(ui.els.errorText.textContent, /^shop: Another session changed this layer a moment ago/);
});

test("one session alone: the selection card sends to it without a choice to make", () => {
  const ui = boot();
  ui.sockets[0].open();
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [{ id: "sa", name: "shop", color: "#7c3aed" }] }) });
  ui.fromPlugin({ type: "desk", count: 3, names: ["A", "B", "C"], owner: null, asks: [] });
  assert.equal(ui.els.status.textContent, "Connected to Claude Code");
  assert.equal(ui.els.selCard.style.display, "block");
  assert.match(ui.els.selChips.innerHTML, /aria-pressed="true"[^>]*>.*shop/s);
  assert.equal(ui.els.selHint.style.display, "none");
  assert.doesNotMatch(ui.els.actions.innerHTML, /disabled/);
});

test("the selection is shown as a picture with its name and size; nothing selected hides it", () => {
  const ui = boot();
  ui.sockets[0].open();
  ui.fromPlugin({ type: "desk", count: 2, names: ["Card", "Icon"], owner: null, asks: [] });
  ui.fromPlugin({ type: "thumb", count: 2, name: "Card", kind: "FRAME", w: 320, h: 180, png: "iVBORw0KGgo=" });
  assert.equal(ui.els.thumb.style.display, "grid");
  assert.match(ui.els.thumb.innerHTML, /<img alt="" src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(ui.els.thumbMeta.innerHTML, /Card.*\+1.*frame · 320×180/);
  ui.fromPlugin({ type: "thumb", count: 0 });
  ui.fromPlugin({ type: "desk", count: 0, names: [], owner: null, asks: [] });
  assert.equal(ui.els.selCard.style.display, "none");
});

test("the star button opens the repository through the plugin", () => {
  const ui = boot();
  ui.els.star.onclick();
  assert.equal(JSON.stringify(ui.posted.at(-1)), JSON.stringify({ type: "open-repo" }));
});

test("tabs: one panel at a time, the ink follows, and Activity counts what happened while you were elsewhere", () => {
  const ui = boot();
  ui.els.tabs.onclick({ target: { dataset: {}, parentElement: { id: "tab-settings", dataset: { tab: "settings" } } } });
  assert.equal(ui.els.tabs.dataset.tab, "settings");
  assert.equal(ui.el("panel-settings").dataset.active, "1");
  assert.equal(ui.el("panel-home").dataset.active, "");
  assert.equal(ui.els.panels.dataset.dir, "right");
  ui.els.tabs.onkeydown({ key: "ArrowLeft" });
  assert.equal(ui.els.tabs.dataset.tab, "skills");
  assert.equal(ui.els.panels.dataset.dir, "left");
  ui.els.tabs.onkeydown({ key: "ArrowLeft" });
  assert.equal(ui.els.tabs.dataset.tab, "activity");
});

test("the Skills tab: the hub's list by category, switches and removal go back to the hub, a link adds one, and /skill in the chat box adds one too", () => {
  const ui = withSession();
  const sent = () => ui.sockets[0].sent.map((s: string) => JSON.parse(s)).filter((m: any) => String(m.type).startsWith("skills-"));
  assert.ok(sent().some((m: any) => m.type === "skills-get"), "asks for the list once paired");
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "skills", categories: [{ id: "ux", name: "UX" }, { id: "yours", name: "Yours" }], skills: [
    { id: "design-critique", name: "Design Critique", when: "Critiquing a screen", description: "", category: "ux", origin: "library", enabled: true, author: "Anthropic", license: "Apache-2.0" },
    { id: "my-rules", name: "My rules", when: "Our house style", description: "", category: "yours", origin: "yours", enabled: false, source: "https://github.com/me/skills/tree/main/my-rules" },
  ] }) });
  assert.match(ui.els.skillList.innerHTML, /UX[\s\S]*Design Critique[\s\S]*Apache-2\.0[\s\S]*Yours[\s\S]*My rules[\s\S]*github\.com\/me\/skills/);
  assert.equal(ui.els.skillTotal.textContent, "1 of 2 on");
  assert.equal(ui.els.noSkills.style.display, "none");
  ui.els.skillList.onclick({ target: { dataset: { skill: "design-critique" }, parentElement: null } });
  assert.deepEqual(sent().at(-1), { type: "skills-set", id: "design-critique", on: false });
  // Remove asks once more.
  ui.els.skillList.onclick({ target: { dataset: { skillRm: "my-rules" }, parentElement: null } });
  assert.ok(!sent().some((m: any) => m.type === "skills-remove"));
  assert.match(ui.els.skillList.innerHTML, /Remove\?/);
  ui.els.skillList.onclick({ target: { dataset: { skillRm: "my-rules" }, parentElement: null } });
  assert.deepEqual(sent().at(-1), { type: "skills-remove", id: "my-rules" });
  // Add from the tab, and from the chat box.
  ui.els.skillInput.value = "https://github.com/jakubkrehel/skills/tree/main/skills/variant";
  ui.els.skillAddBtn.onclick();
  assert.deepEqual(sent().at(-1), { type: "skills-add", source: "https://github.com/jakubkrehel/skills/tree/main/skills/variant" });
  ui.els.askInput.value = "/skill https://aiuxplayground.com/skills/spacing-audit";
  ui.els.askSend.onclick();
  assert.deepEqual(sent().at(-1), { type: "skills-add", source: "https://aiuxplayground.com/skills/spacing-audit" });
  assert.equal(ui.els.askInput.value, "");
  assert.ok(!ui.posted.some((m: any) => m.type === "compose-action"), "/skill isn't sent to a session as a request");
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "skills", categories: [], skills: [], added: { id: "spacing-audit", name: "Spacing Audit" } }) });
  assert.match(ui.els.toast.innerHTML, /Skill added: Spacing Audit/);
  // Filter.
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "skills", categories: [{ id: "ux", name: "UX" }], skills: [
    { id: "a", name: "Alpha", when: "layout", description: "", category: "ux", origin: "library", enabled: true },
    { id: "b", name: "Beta", when: "colour", description: "", category: "ux", origin: "library", enabled: true }] }) });
  ui.els.skillFilter.value = "colour";
  ui.els.skillFilter.oninput();
  assert.match(ui.els.skillList.innerHTML, /Beta/);
  assert.doesNotMatch(ui.els.skillList.innerHTML, /Alpha/);
});

function withSession() {
  const ui = boot();
  ui.sockets[0].open();
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "pairing", paired: true }) });
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [{ id: "sa", name: "Checkout", color: "#7c3aed", client: "claude-code" }] }) });
  ui.fromPlugin({ type: "desk", count: 1, names: ["Card"], owner: "sa", to: "sa", why: "picked", asks: [] });
  return ui;
}

test("a request from the selection: the plugin adds the layers, it goes to the session, and its progress comes back", () => {
  const ui = withSession();
  ui.els.askInput.value = "use our Card component";
  ui.els.actions.onclick({ target: { dataset: { act: "ask", kind: "code" } } });
  assert.equal(JSON.stringify(ui.posted.at(-1)), JSON.stringify({ type: "compose-action", session: "sa", kind: "code", text: "use our Card component" }));
  assert.equal(ui.els.askInput.value, "");
  const action = { id: "q1", kind: "code", text: "use our Card component", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: 1 };
  ui.fromPlugin({ type: "send-action", session: "sa", action });
  assert.deepEqual(JSON.parse(ui.sockets[0].sent.at(-1)), { type: "action", session: "sa", action });
  assert.match(ui.els.toast.innerHTML, /Sent to Checkout/);
  assert.equal(ui.els.activityBadge.dataset.show, "1");
  assert.match(ui.els.requests.innerHTML, /Build this in code · Checkout.*Card.*Sending…/s);
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "action-update", id: "q1", status: "working", session: "sa" }) });
  assert.match(ui.els.requests.innerHTML, /Working…/);
  assert.match(ui.els.sessions.innerHTML, /On your request…/);
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "action-update", id: "q1", status: "done", message: "Card.tsx updated", session: "sa" }) });
  assert.match(ui.els.requests.innerHTML, /pill ok">Done.*Checkout: <\/i>Card\.tsx updated/s);
  assert.match(ui.els.toast.innerHTML, /Checkout finished/);
  // Opening Activity clears the badge.
  ui.els.tabs.onclick({ target: { id: "tab-activity", dataset: { tab: "activity" } } });
  assert.equal(ui.els.activityBadge.dataset.show, "");
});

test("a request still waiting says how to deliver it; a note from a session shows in Activity", () => {
  const ui = withSession();
  ui.fromPlugin({ type: "send-action", session: "sa", action: { id: "q2", kind: "polish", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: 1 } });
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "action-update", id: "q2", status: "queued", session: "sa" }) });
  assert.match(ui.els.requests.innerHTML, /next Figma step, or type \/layer:inbox.*data-act="copy" data-text="\/layer:inbox"/s);
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "action-update", id: "note-1", status: "done", message: "Which breakpoint first?", session: "sa" }) });
  assert.match(ui.els.activity.innerHTML, /✦.*Checkout: Which breakpoint first\?/s);
});

test("an unpaired window can't send requests, and says how to pair; the hello carries the key", () => {
  const ui = boot();
  ui.fromPlugin({ type: "hello", hello: { type: "hello", fileName: "F", page: "P" } });
  ui.sockets[0].open();
  assert.equal(JSON.parse(ui.sockets[0].sent[0]).key, "__LAYERWRIGHT_KEY__");
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "pairing", paired: false }) });
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [{ id: "sa", name: "Checkout", color: "#7c3aed" }] }) });
  ui.fromPlugin({ type: "desk", count: 1, names: ["Card"], owner: "sa", to: "sa", why: "picked", asks: [] });
  assert.match(ui.els.actions.innerHTML, /disabled/);
  assert.equal(ui.els.askSend.disabled, true);
  assert.match(ui.els.pairing.textContent, /^Not paired: run npx layerwright init/);
});

test("the AI cursor and zoom-to-result switches are saved in the plugin; the star opens the repository", () => {
  const ui = boot();
  ui.fromPlugin({ type: "settings", cursor: true });
  assert.equal(ui.els.cursorToggle.dataset.on, "1");
  ui.els.cursorToggle.onclick();
  assert.equal(JSON.stringify(ui.posted.at(-1)), JSON.stringify({ type: "set-cursor", on: false }));
  assert.equal(ui.els.cursorToggle.dataset.on, "");
  assert.equal(ui.els.zoomToggle.dataset.on, "1", "zoom to the result: on unless turned off");
  ui.els.zoomToggle.onclick();
  assert.equal(JSON.stringify(ui.posted.at(-1)), JSON.stringify({ type: "set-zoom", on: false }));
  ui.fromPlugin({ type: "settings", cursor: true, zoom: false });
  assert.equal(ui.els.zoomToggle.dataset.on, "");
  ui.els.starCard.onclick();
  assert.equal(JSON.stringify(ui.posted.at(-1)), JSON.stringify({ type: "open-repo" }));
});

test("opened outside Figma (a browser, a preview) the window never connects, so it can't take the plugin's place", () => {
  const ui = boot({ topLevel: true });
  assert.equal(ui.sockets.length, 0);
});

test("a session that never acknowledges a request (an older Layerwright) is pointed out after a few seconds", () => {
  const ui = withSession();
  const realNow = Date.now;
  ui.fromPlugin({ type: "send-action", session: "sa", action: { id: "q3", kind: "code", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: 1 } });
  try {
    Date.now = () => realNow() + 9000;
    ui.fromPlugin({ type: "desk", count: 1, names: ["Card"], owner: "sa", to: "sa", why: "picked", asks: [] }); // any render
    assert.match(ui.els.requests.innerHTML, /didn't answer: it may run an older Layerwright/);
  } finally { Date.now = realNow; }
});

test("the session picker: the chosen session up top, every session in the menu, no Remove in it; work brings Activity forward", () => {
  const ui = withSession();
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [{ id: "sa", name: "Checkout", color: "#7c3aed", client: "claude-code" }, { id: "sb", name: "Admin", color: "#0d99ff", client: "codex-mcp-client" }] }) });
  ui.fromPlugin({ type: "desk", count: 1, names: ["Card"], owner: "sa", to: "sa", why: "picked", asks: [] });
  assert.match(ui.els.pickerBtn.innerHTML, /Checkout.*Claude Code · idle/s);
  assert.match(ui.els.selChips.innerHTML, /Checkout.*Admin.*Codex/s);
  ui.els.pickerBtn.onclick();
  assert.equal(ui.els.picker.dataset.open, "1");
  assert.doesNotMatch(ui.els.selChips.innerHTML, /data-act="kick"/, "no Remove inside a session you give the selection to: a second click there removed it");
  // Remove is on the Sessions tab, and asks once more there.
  const now = Date.now;
  try {
    let t = now();
    Date.now = () => t;
    ui.els.sessions.onclick({ target: { dataset: { act: "kick", session: "sb" } } });
    assert.match(ui.els.sessions.innerHTML, /<li[^>]*data-confirm="1"><span class="avatar"[^>]*>A.*<button type="button" class="kick" data-act="kick" data-session="sb" data-confirm="1"[^>]*>Remove<\/button>/s, "armed: a real button reading Remove, and its row marked so the state pill makes room");
    t += 150; // the second click of a double-click
    ui.els.sessions.onclick({ target: { dataset: { act: "kick", session: "sb" } } });
    assert.ok(!ui.sockets[0].sent.some((m: string) => JSON.parse(m).type === "kick"), "a double-click doesn't remove");
    assert.match(ui.els.sessions.innerHTML, />Remove<\/button>/, "still asking");
    t += 600;
    ui.els.sessions.onclick({ target: { dataset: { act: "kick", session: "sb" } } });
    assert.deepEqual(JSON.parse(ui.sockets[0].sent.at(-1)), { type: "kick", session: "sb" });
  } finally { Date.now = now; }
  ui.els.selChips.onclick({ target: { dataset: { act: "assign", session: "sb" } } });
  assert.equal(ui.els.picker.dataset.open, "", "choosing closes the menu");
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "sa~r1", method: "editNodes", session: { id: "sa", name: "Checkout" } }) });
  assert.equal(ui.els.tabs.dataset.tab, "activity");
});

const plain = (x: unknown) => JSON.parse(JSON.stringify(x)); // objects from the window's own realm

test("the picture of the selection zooms Figma to that layer; a request tells the cursor what kind it is", () => {
  const ui = withSession();
  ui.fromPlugin({ type: "desk", count: 1, names: ["Card"], owner: "sa", to: "sa", why: "picked", asks: [] });
  ui.fromPlugin({ type: "thumb", count: 1, id: "1:2", name: "Card", kind: "FRAME", w: 320, h: 200, png: "AAAA" });
  assert.match(ui.els.thumb.innerHTML, /Zoom to layer/);
  ui.els.thumb.onclick();
  assert.deepEqual(plain(ui.posted.at(-1)), { type: "zoom-to", id: "1:2" });
  ui.fromPlugin({ type: "send-action", session: "sa", action: { id: "q9", kind: "component", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: 1 } });
  assert.ok(ui.posted.some((m) => m.type === "session-activity" && m.kind === "component" && m.status === "sent"));
});

test("compact mode: remembered by the plugin, sized to fit; the selection, the four actions, the chat box and the last request", () => {
  const ui = withSession();
  ui.el("mini").offsetHeight = 212;
  ui.fromPlugin({ type: "desk", count: 1, names: ["Card"], owner: "sa", to: "sa", why: "picked", asks: [] });
  ui.fromPlugin({ type: "thumb", count: 1, id: "1:2", name: "Card", kind: "FRAME", w: 320, h: 200, png: "AAAA" });
  ui.fromPlugin({ type: "settings", cursor: true, mini: true });
  assert.equal(ui.els.app.dataset.mini, "1");
  assert.deepEqual(plain(ui.posted.filter((m) => m.type === "resize").at(-1)), { type: "resize", width: 300, height: 212 }, "the window fits what it shows");
  assert.equal(ui.els.mName.textContent, "Card");
  assert.match(ui.els.mMeta.textContent, /frame · 320×200/);
  assert.match(ui.els.mActs.innerHTML, /Code.*Polish.*Component.*Mobile/s);
  assert.doesNotMatch(ui.els.mActs.innerHTML, /disabled/);
  ui.els.mActs.onclick({ target: { dataset: { act: "ask", kind: "mobile" } } });
  assert.deepEqual(plain(ui.posted.at(-1)), { type: "compose-action", session: "sa", kind: "mobile", text: "" });
  ui.els.mInput.value = "Make the title bigger";
  ui.els.mSend.onclick();
  assert.deepEqual(plain(ui.posted.at(-1)), { type: "compose-action", session: "sa", kind: "ask", text: "Make the title bigger" });
  assert.equal(ui.els.mInput.value, "");
  ui.fromPlugin({ type: "send-action", session: "sa", action: { id: "q7", kind: "ask", text: "Make the title bigger", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: 1 } });
  assert.match(ui.els.mLast.innerHTML, /Help with this/);
  assert.notEqual(ui.els.tabs.dataset.tab, "activity", "compact: no tab switching");
  ui.fromPlugin({ type: "desk", count: 1, names: ["Card"], owner: null, asks: [{ id: "k1", session: "sa" }] });
  assert.match(ui.els.mAsks.innerHTML, /wants your selection/);
  ui.els.maxBtn.onclick();
  assert.equal(ui.els.app.dataset.mini, "");
  assert.deepEqual(plain(ui.posted.at(-1)), { type: "set-mini", on: false });
});

test("a session asks in its chat: the window says so first, with the question and where to answer; the answer clears it", () => {
  const ui = withSession();
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "session-state", session: "sa", waiting: true, kind: "question", text: "Which button style?" }) });
  assert.match(ui.els.chatAsks.innerHTML, /Checkout asked you something[\s\S]*Which button style\?[\s\S]*Answer in Claude Code/);
  assert.match(ui.els.sessions.innerHTML, /Answer in the chat/);
  assert.deepEqual(plain(ui.posted.at(-1)), { type: "session-state", session: "sa", waiting: true, kind: "question", text: "Which button style?" }, "the plugin makes the cursor wave");
  assert.match(ui.els.toast.innerHTML, /asked you something in Claude Code/);
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "session-state", session: "sa", waiting: false }) });
  assert.equal(ui.els.chatAsks.innerHTML, "");
});

test("several requests at once: each one has its id for its own cursor; the session shows how many it's on", () => {
  const ui = withSession();
  ui.fromPlugin({ type: "send-action", session: "sa", action: { id: "q1", kind: "component", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: 1 } });
  ui.fromPlugin({ type: "send-action", session: "sa", action: { id: "q2", kind: "mobile", nodes: [{ id: "1:3", name: "Home", type: "FRAME" }], at: 2 } });
  assert.deepEqual(ui.posted.filter((m) => m.type === "session-activity").map((m) => m.id), ["q1", "q2"]);
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "action-update", id: "q1", status: "working", session: "sa" }) });
  assert.match(ui.els.sessions.innerHTML, /On 2 requests/);
  assert.match(ui.els.pickerBtn.innerHTML, /on 2 requests/);
});

test("a result held while the user worked: the window offers to show it", () => {
  const ui = withSession();
  ui.fromPlugin({ type: "result-ready", ids: ["7:7"], session: "sa" });
  assert.equal(ui.els.resultBar.dataset.show, "1");
  ui.els.resultBar.onclick();
  assert.deepEqual(plain(ui.posted.at(-1)), { type: "show-result", ids: ["7:7"] });
  assert.equal(ui.els.resultBar.dataset.show, "");
});

function withSkills() {
  const ui = withSession();
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "skills", categories: [{ id: "ux", name: "UX" }, { id: "code", name: "Design → code" }], skills: [
    { id: "design-critique", name: "Design Critique", when: "Critiquing a screen", description: "", category: "ux", origin: "library", enabled: true, author: "Anthropic", license: "Apache-2.0", source: "https://github.com/anthropics/knowledge-work-plugins/tree/abc/design/skills/design-critique" },
    { id: "design-handoff", name: "Design Handoff", when: "A spec with every state", description: "", category: "code", origin: "library", enabled: true },
    { id: "animate", name: "Animate", when: "Motion", description: "", category: "code", origin: "library", enabled: false },
  ] }) });
  return ui;
}
const sentOf = (ui: any, type: string) => ui.sockets[0].sent.map((s: string) => JSON.parse(s)).filter((m: any) => m.type === type);

test("@ in the chat box: the enabled skills that match, arrows and Enter pick one, it shows as a chip and goes with the request", () => {
  const ui = withSkills();
  ui.els.askInput.value = "polish this @des";
  ui.els.askInput.oninput();
  assert.equal(ui.els.skMenu.dataset.open, "1");
  assert.match(ui.els.skMenu.innerHTML, /Design Critique[\s\S]*Design Handoff/);
  assert.doesNotMatch(ui.els.skMenu.innerHTML, /Animate/, "a skill that's off isn't offered");
  ui.els.askInput.onkeydown({ key: "ArrowDown" });
  ui.els.askInput.onkeydown({ key: "Enter" });
  assert.equal(ui.els.askInput.value, "polish this ");
  assert.equal(ui.els.skMenu.dataset.open, "");
  assert.match(ui.els.skPicked.innerHTML, /Design Handoff/);
  // Typed in full without the menu counts too; Enter now sends.
  ui.els.askInput.value = "polish this with @design-critique";
  ui.els.askInput.oninput();
  ui.els.askInput.onkeydown({ key: "Escape" });
  ui.els.askInput.onkeydown({ key: "Enter" });
  const sent = ui.posted.filter((m: any) => m.type === "compose-action").at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.skills)), ["design-handoff", "design-critique"]);
  assert.equal(sent.text, "polish this with @design-critique");
  assert.equal(ui.els.skPicked.innerHTML, "", "picked skills go with one request");
  // A chip can be removed; a picked skill alone (no words) is a request too.
  ui.els.mInput.value = "@anim";
  ui.els.mInput.oninput();
  assert.match(ui.els.mSkMenu.innerHTML, /No skill matches/);
  ui.els.skMenu.onclick({ target: { dataset: {}, parentElement: null } });
});

test("a skill's page: opens from its row, its Markdown is shown safely, its files and links work, and Use in chat picks it", () => {
  const ui = withSkills();
  ui.els.skillList.onclick({ target: { dataset: { open: "design-critique" }, parentElement: null } });
  assert.deepEqual(sentOf(ui, "skills-read").at(-1), { type: "skills-read", id: "design-critique", file: "SKILL.md" });
  assert.equal(ui.els.skillPage.dataset.open, "1");
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "skill-text", id: "design-critique", file: "SKILL.md", files: ["SKILL.md", "references/steps.md"],
    skill: { id: "design-critique", name: "Design Critique", author: "Anthropic", license: "Apache-2.0", origin: "library", enabled: true, source: "https://github.com/x/y" },
    text: "---\nname: design-critique\ndescription: Get structured design feedback.\n---\n# Critique\n\nSee [steps](references/steps.md) and [docs](https://example.com).\n\n- **Hierarchy** first\n- `code` here\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n```\nconst x = 1;\n```" }) });
  const body = ui.els.spBody.innerHTML;
  assert.match(body, /<div class="fm" dir="auto">Get structured design feedback\.<\/div>/);
  assert.match(body, /<h1 dir="auto">Critique<\/h1>/);
  assert.match(body, /<li dir="auto"><b>Hierarchy<\/b> first<\/li>/);
  assert.match(body, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr>/);
  assert.match(body, /<pre><code>const x = 1;<\/code><\/pre>/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "a skill's HTML is shown as text, never run");
  assert.equal(ui.els.spTitle.textContent, "Design Critique");
  assert.match(ui.els.spFiles.innerHTML, /references\/steps/);
  // A link to its own file opens it here; an https link goes to the browser through the plugin.
  ui.els.spBody.onclick({ target: { dataset: { href: "references/steps.md" }, parentElement: null } });
  assert.deepEqual(sentOf(ui, "skills-read").at(-1), { type: "skills-read", id: "design-critique", file: "references/steps.md" });
  ui.els.spBody.onclick({ target: { dataset: { href: "https://example.com" }, parentElement: null } });
  assert.deepEqual(JSON.parse(JSON.stringify(ui.posted.at(-1))), { type: "open-url", url: "https://example.com" });
  // Off from the page; Use in chat picks it and goes home.
  ui.els.spToggle.onclick();
  assert.deepEqual(sentOf(ui, "skills-set").at(-1), { type: "skills-set", id: "design-critique", on: false });
  ui.els.spUse.onclick();
  assert.equal(ui.els.skillPage.dataset.open, "");
  assert.equal(ui.els.tabs.dataset.tab, "home");
  assert.match(ui.els.skPicked.innerHTML, /Design Critique/);
  ui.els.spBack.onclick();
});

test("Activity: a running request can be stopped (asked once more), finished ones and log lines can be removed, both lists cleared", () => {
  const ui = withSession();
  ui.fromPlugin({ type: "send-action", session: "sa", action: { id: "q1", kind: "polish", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: Date.now() } });
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "action-update", id: "q1", status: "working", session: "sa" }) });
  assert.match(ui.els.requests.innerHTML, /data-act="stop-req" data-id="q1"/);
  const press = (act: string, extra: Record<string, string> = {}) => ui.els.requests.onclick({ target: { dataset: { act, ...extra }, parentElement: null } });
  press("stop-req", { id: "q1" });
  assert.equal(sentOf(ui, "action-stop").length, 0, "the first press only asks");
  assert.match(ui.els.requests.innerHTML, /Stop\?/);
  press("stop-req", { id: "q1" });
  assert.deepEqual(sentOf(ui, "action-stop"), [{ type: "action-stop", id: "q1" }]);
  assert.ok(ui.posted.some((m: any) => m.type === "session-activity" && m.id === "q1" && m.status === "stopped"), "its cursor goes");
  assert.match(ui.els.requests.innerHTML, /Stopped/);
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "action-update", id: "q1", status: "done", session: "sa", message: "late" }) });
  assert.match(ui.els.requests.innerHTML, /Stopped/, "a late update doesn't revive it");
  press("del-req", { id: "q1" });
  assert.doesNotMatch(ui.els.requests.innerHTML, /q1/);
  // The log: one line removed, then all.
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "r1", method: "editNodes" }) });
  ui.fromPlugin({ type: "response", res: { id: "r1", ok: true, result: { applied: [1] } } });
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "r2", method: "executePlan" }) });
  ui.fromPlugin({ type: "response", res: { id: "r2", ok: true, result: { createdRootIds: ["9:9"] } } });
  assert.match(ui.els.activity.innerHTML, /Built 1 frame[\s\S]*Edited layers/);
  ui.els.activity.onclick({ target: { dataset: { act: "del-ev", i: "0" }, parentElement: null } });
  assert.doesNotMatch(ui.els.activity.innerHTML, /Built 1 frame/);
  assert.match(ui.els.activity.innerHTML, /Edited layers/);
  ui.els.clearLog.onclick();
  assert.equal(ui.els.activity.innerHTML, "");
});

test("the tab highlight sits under each tab: TABS follows the buttons, and the highlight takes the active tab's real box", () => {
  const html = readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const order = [...html.matchAll(/<button id="tab-(\w+)" role="tab"/g)].map((m) => m[1]);
  assert.equal(order.length, 5);
  assert.match(html, new RegExp(`const TABS = \\[${order.map((t) => `"${t}"`).join(", ")}\\]`), "TABS follows the buttons");
  const ui = boot();
  order.forEach((t, i) => Object.assign(ui.el("tab-" + t), { offsetLeft: 3 + i * 60, offsetWidth: 50 + i }));
  ui.els.tabs.onclick({ target: { id: "tab-" + order[3], dataset: { tab: order[3] } } });
  assert.equal(ui.el("ink").style.transform, "translateX(183px)");
  assert.equal(ui.el("ink").style.width, "53px");
});

test("a skill alone is a request: picked with no words it sends, reads 'Apply <skill>', and Backspace takes a token back out", () => {
  const ui = withSkills();
  ui.els.askInput.value = "@crit";
  ui.els.askInput.oninput();
  assert.match(ui.els.skMenu.innerHTML, /<kbd>↵<\/kbd> add/);
  ui.els.askInput.onkeydown({ key: "Enter" });
  assert.match(ui.els.skPicked.innerHTML, /sk-chip[\s\S]*Design Critique/);
  assert.match(ui.els.askInput.placeholder, /optional/);
  assert.match(ui.els.askSend.title, /Apply the skill to the selection/);
  // Backspace in the empty field removes the token; pick it again and send with no words.
  ui.els.askInput.value = "";
  ui.els.askInput.onkeydown({ key: "Backspace", target: ui.els.askInput });
  assert.equal(ui.els.skPicked.innerHTML, "");
  ui.els.askInput.value = "@design-crit";
  ui.els.askInput.oninput();
  ui.els.askInput.onkeydown({ key: "Tab" });
  ui.els.askInput.onkeydown({ key: "Enter" });
  const sent = ui.posted.filter((m: any) => m.type === "compose-action").at(-1);
  assert.equal(sent.text, "");
  assert.deepEqual(JSON.parse(JSON.stringify(sent.skills)), ["design-critique"]);
  ui.fromPlugin({ type: "send-action", session: "sa", action: { id: "q5", kind: "ask", skills: ["design-critique"], nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: Date.now() } });
  assert.match(ui.els.requests.innerHTML, /Apply Design Critique · Checkout/);
});

test("the session picker: with several sessions nobody is chosen until the user picks; the pick holds, whoever joins, reconnects or works", () => {
  const ui = boot();
  ui.sockets[0].open();
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "pairing", paired: true }) });
  const old = { id: "s1", name: "Old one", color: "#7c3aed", connectedAt: 1000 };
  const mid = { id: "s2", name: "Middle", color: "#0d99ff", connectedAt: 2000 };
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [old, mid] }) });
  ui.fromPlugin({ type: "desk", count: 1, names: ["Card"], owner: null, to: null, why: null, asks: [] });
  assert.match(ui.els.pickerBtn.innerHTML, /<b>Choose a session<\/b>/, "no guess");
  assert.match(ui.els.selChips.innerHTML, /<b>Middle<\/b>[\s\S]*<b>Old one<\/b>/, "newest first in the menu");
  assert.doesNotMatch(ui.els.selChips.innerHTML, /Newest/, "no label that reads like a default");
  ui.els.askInput.value = "hi";
  ui.els.askSend.onclick();
  assert.ok(!ui.posted.some((m: any) => m.type === "compose-action"), "nothing is sent before a pick");
  ui.els.selChips.onclick({ target: { dataset: { act: "assign", session: "s1" } } });
  assert.match(ui.els.pickerBtn.innerHTML, /<b>Old one<\/b>/, "the pick shows at once");
  ui.fromPlugin({ type: "desk", count: 1, names: ["Card"], owner: "s1", to: "s1", why: "picked", asks: [] });
  const brandNew = { id: "s3", name: "Brand new", color: "#14ae5c", connectedAt: Date.now() + 1000 };
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [old, { ...mid, connectedAt: Date.now() + 2000 }, brandNew] }) });
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "s2~r1", method: "editNodes", session: mid }) });
  assert.match(ui.els.pickerBtn.innerHTML, /<b>Old one<\/b>/, "not the one that joined, reconnected or worked");
  ui.els.askInput.value = "hi";
  ui.els.askSend.onclick();
  assert.equal(ui.posted.filter((m: any) => m.type === "compose-action").at(-1).session, "s1");
});
test("a window that isn't paired: the hub says so; the window shows what to do and stops knocking every few seconds", () => {
  const ui = boot();
  ui.sockets[0].open();
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "rejected", message: "This Figma plugin isn't paired with Layerwright on this computer. Run npx layerwright plugin, then reopen the plugin." }) });
  assert.equal(ui.els.status.textContent, "Not paired with Layerwright");
  assert.equal(ui.els.error.style.display, "block");
  assert.match(ui.els.errorText.textContent, /npx layerwright plugin/);
  assert.equal(ui.posted.filter((m: any) => m.type === "request").length, 0, "never forwarded as a request");
  const before = ui.delays.length;
  ui.sockets[0].onclose({ code: 4003 });
  assert.deepEqual(ui.delays.slice(before), [30000], "it tries again only every 30 s");
  assert.equal(ui.sockets.length, 1);
  assert.equal(ui.els.help.style.display, "none");
});

test("session colours from the hub go into the page only as #rrggbb colours", () => {
  const ui = boot();
  ui.sockets[0].open();
  const bad = { id: "sx", name: "evil", color: 'red;background:url(https://x.test/a.png)"><img src=x>', client: "claude-code" };
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [bad] }) });
  assert.doesNotMatch(ui.els.sessions.innerHTML + ui.els.avatars.innerHTML, /url\(|<img/);
  assert.match(ui.els.sessions.innerHTML, /--c:#8b5cf6/);
});

test("between steps a session is thinking (in the window, not on the canvas); an @name that is no session's is a low-key card", () => {
  const ui = boot();
  ui.sockets[0].open();
  const shop = { id: "sa", name: "shop", color: "#7c3aed", client: "claude-code" };
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [shop] }) });
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "sa~r1", method: "editNodes", session: shop }) });
  ui.fromPlugin({ type: "response", res: { id: "sa~r1", ok: true, result: { applied: [1] } } });
  assert.match(ui.els.sessions.innerHTML, /pill busy">Thinking…/);
  ui.fromPlugin({ type: "note-asks", asks: [{ key: "5:6", text: "followed you", name: "john_doe", quiet: true }] });
  assert.match(ui.els.asks.innerHTML, /class="ask quiet".*@john_doe isn't a session/s);
  assert.match(ui.els.asks.innerHTML, /data-act="note-send" data-key="5:6" data-session="sa">Send to shop/);
});

test("the selection's picture isn't rewritten on every redraw (the browser reads SVG back differently: it blinked)", () => {
  const ui = boot();
  ui.fromPlugin({ type: "hello", hello: { type: "hello", fileName: "TEST", page: "Designs", selection: 1 } });
  ui.sockets[0].open();
  // Like a browser: self-closing SVG elements read back with a closing tag.
  const thumb = ui.el("thumb");
  let stored = "", writes = 0;
  Object.defineProperty(thumb, "innerHTML", { get: () => stored, set: (v: string) => { writes++; stored = v.replace(/<(\w+)([^<>]*)\/>/g, "<$1$2></$1>"); } });
  ui.fromPlugin({ type: "desk", count: 1, names: ["Note"], owner: null, asks: [] });
  writes = 0;
  ui.fromPlugin({ type: "thumb", count: 1, id: "1:2", name: "Note", kind: "TEXT", w: 180, h: 30, png: "iVBORw0KGgo=" });
  assert.equal(writes, 1);
  for (let i = 0; i < 5; i++) ui.fromPlugin({ type: "desk", count: 1, names: ["Note"], owner: null, asks: [] }); // redraws
  assert.equal(writes, 1, "drawn once, left alone after");
  ui.fromPlugin({ type: "thumb", count: 1, id: "1:3", name: "Other", kind: "FRAME", w: 100, h: 40, png: "iVBORw0KGgp=" });
  assert.equal(writes, 2, "a new picture is drawn");
});

test("the guide: opens by itself the first time, closing it is remembered; the ? opens it again; the README link opens in the browser", () => {
  const ui = boot();
  ui.fromPlugin({ type: "settings", cursor: true, zoom: true, mini: false, guideSeen: false });
  assert.equal(ui.els.guide.dataset.open, "1", "first run: the guide is open");
  ui.els.guideOk.onclick();
  assert.equal(ui.els.guide.dataset.open, "");
  assert.ok(ui.posted.some((m) => m.type === "guide-seen"), "and the plugin remembers it");
  const seen = ui.posted.filter((m) => m.type === "guide-seen").length;
  ui.els.helpBtn.onclick();
  assert.equal(ui.els.guide.dataset.open, "1", "the ? opens it");
  ui.els.guideClose.onclick();
  assert.equal(ui.posted.filter((m) => m.type === "guide-seen").length, seen, "remembered once");
  ui.els.guideReadme.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.posted.at(-1))), { type: "open-url", url: "https://github.com/shayan-m81/layerwright#readme" });
  const later = boot();
  later.fromPlugin({ type: "settings", cursor: true, zoom: true, mini: false, guideSeen: true });
  assert.notEqual(later.el("guide").dataset.open, "1", "seen before: it stays closed");
});

test("the remove button has its own style: Activity's 18px × rule never squeezes it, and armed it takes the pill's place", () => {
  const css = readFileSync(new URL("../src/ui.html", import.meta.url), "utf8").match(/<style>([\s\S]*?)<\/style>/)![1];
  assert.match(css, /\.kick \{[^}]*min-width: 24px[^}]*white-space: nowrap/);
  assert.doesNotMatch(css, /\.kick \{[^}]*[^-]width: \d/, "no fixed width: it fits its label");
  assert.match(css, /#sessions li\[data-confirm="1"\] \.pill \{ display: none; \}/);
  assert.doesNotMatch(css, /#sessions li:hover \.x/, "the session list no longer uses .x");
});

test("a press on the session list holds its redraws until the click lands (a redraw under the pointer lost the click)", () => {
  const ui = withSession();
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [{ id: "sa", name: "Checkout", color: "#7c3aed", client: "claude-code" }, { id: "sb", name: "Admin", color: "#0d99ff" }] }) });
  const before = ui.els.sessions.innerHTML;
  ui.els.sessions.onpointerdown();
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "sb~r1", method: "editNodes", session: { id: "sb", name: "Admin" } }) }); // work starts: the list would redraw
  assert.equal(ui.els.sessions.innerHTML, before, "not redrawn while pressed");
  const pending = ui.timers.length;
  ui.fire("pointerup");
  assert.equal(ui.timers.length, pending + 1, "released: one redraw scheduled after the click");
  ui.timers.at(-1)!();
  assert.match(ui.els.sessions.innerHTML, /Admin.*Editing layers/s, "and then it catches up");
});

test("with no session the window says so; a session removed here stays listed, faded, with how it comes back", () => {
  const ui = boot();
  ui.fromPlugin({ type: "hello", hello: { type: "hello", fileName: "TEST", page: "Designs", selection: 0 } });
  ui.sockets[0].open();
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [] }) });
  assert.equal(ui.els.status.textContent, "Connected · no session");
  assert.equal(ui.els.connText.textContent, "No session");
  assert.equal(ui.els.detail.textContent, "Start Claude Code or Codex in a project");
  assert.equal(ui.els.dot.dataset.state, "idle", "not the green of a working connection");
  assert.equal(ui.els.conn.dataset.state, "idle");
  assert.equal(ui.els.noSessions.style.display, "block");
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [], removed: [{ id: "sa", name: "gift-mvp", color: "#7c3aed", client: "claude-code", workdir: "/Users/me/gift-mvp", at: 1 }] }) });
  assert.equal(ui.els.detail.textContent, "You removed gift-mvp");
  assert.match(ui.els.detail.title, /joins again the next time you ask it for Figma work/);
  assert.equal(ui.els.sessionsBox.style.display, "block");
  assert.equal(ui.els.noSessions.style.display, "none");
  assert.match(ui.els.sessions.innerHTML, /<li class="gone"[^>]*>.*gift-mvp.*Rejoins when you ask it for Figma.*pill off">Removed/s);
  assert.doesNotMatch(ui.els.sessions.innerHTML, /data-act="kick"/, "nothing to remove twice");
  // It joins again: listed as a session, not as removed.
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [{ id: "sa", name: "gift-mvp", color: "#7c3aed", client: "claude-code" }], removed: [{ id: "sa", name: "gift-mvp", at: 1 }] }) });
  assert.doesNotMatch(ui.els.sessions.innerHTML, /class="gone"/);
  assert.equal(ui.els.status.textContent, "Connected to Claude Code");
  assert.equal(ui.els.dot.dataset.state, "connected");
  assert.equal(ui.els.detail.title, "", "the hint goes with the state");
});

test("Send to and the line under it always name the same session: the plugin's choice, with its reason", () => {
  const ui = boot();
  ui.sockets[0].open();
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "pairing", paired: true }) });
  const cd = { id: "sa", name: "claude-design-engineer", color: "#14ae5c", client: "claude-code", connectedAt: 1 };
  const home = { id: "sb", name: "shayan 2", color: "#7c3aed", client: "cursor-vscode", connectedAt: 9 };
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "sessions", sessions: [cd, home] }) });
  const both = () => [/<b>([^<]+)<\/b>/.exec(ui.els.pickerBtn.innerHTML)?.[1], /class="who"[^>]*>([^<]+)<\/b>/.exec(ui.els.selHint.innerHTML)?.[1]];
  // The screenshot: the plugin had given "Undo test C" to shayan 2 while the window guessed claude-design-engineer.
  ui.fromPlugin({ type: "desk", count: 1, names: ["Undo test C"], owner: "sb", to: "sb", why: "picked", asks: [] });
  assert.deepEqual(both(), ["shayan 2", "shayan 2"], "one choice, shown in both places");
  for (const [why, says] of [["picked", ", your pick"], ["kept", ", the session you were using"]]) {
    ui.fromPlugin({ type: "desk", count: 1, names: ["Undo test C"], owner: "sa", to: "sa", why, asks: [] });
    assert.deepEqual(both(), ["claude-design-engineer", "claude-design-engineer"]);
    assert.ok(ui.els.selHint.innerHTML.includes(`</b>${says}.`), `${why}: ${ui.els.selHint.innerHTML}`);
  }
  ui.fromPlugin({ type: "desk", count: 1, names: ["Undo test C"], owner: null, to: null, why: null, asks: [] });
  assert.deepEqual(both(), ["Choose a session", undefined], "nobody: both say to choose");
  // A pick in the menu shows at once in both places, before the plugin answers; sending goes there.
  ui.els.selChips.onclick({ target: { dataset: { act: "assign", session: "sb" } } });
  assert.deepEqual(both(), ["shayan 2", "shayan 2"]);
  assert.match(ui.els.selHint.innerHTML, /, your pick\./);
  ui.els.askInput.value = "make it red";
  ui.els.askSend.onclick();
  assert.equal(ui.posted.filter((m: any) => m.type === "compose-action").at(-1).session, "sb");
});

test("the question box: Enter sends, Shift+Enter and an input method's Enter don't; it grows with the text up to its limit, then scrolls, and goes back to one line after sending", () => {
  const ui = withSession();
  const box = ui.els.askInput;
  let full = 18;
  Object.defineProperty(box, "scrollHeight", { get: () => full });
  const sent = () => ui.posted.filter((m: any) => m.type === "compose-action").length;
  box.value = "first line";
  let prevented = 0;
  const key = (o: object) => box.onkeydown({ key: "Enter", preventDefault: () => { prevented++; }, ...o });
  key({ shiftKey: true });
  key({ isComposing: true });
  key({ keyCode: 229 });
  assert.equal(sent(), 0, "a new line, or an input method finishing a character, isn't a send");
  // Option+Enter (Mac) / Alt+Enter (Windows): a new line too. The box doesn't add it by itself, so the window does,
  // where the caret is.
  box.value = "first line"; box.selectionStart = box.selectionEnd = 5;
  key({ altKey: true });
  assert.equal(box.value, "first\n line", "a line break at the caret");
  assert.equal(sent(), 0);
  box.value = "first line"; box.selectionStart = box.selectionEnd = 10; prevented = 0;
  full = 90; box.oninput();
  assert.equal(box.style.height, "90px", "taller with the text");
  assert.equal(box.style.overflowY, "hidden");
  full = 400; box.oninput();
  assert.equal(box.style.height, "152px", "up to its limit");
  assert.equal(box.style.overflowY, "auto", "then it scrolls");
  full = 18;
  key({});
  assert.equal(sent(), 1, "Enter sends");
  assert.equal(prevented, 1, "without adding a new line");
  assert.equal(ui.posted.filter((m: any) => m.type === "compose-action").at(-1).text, "first line");
  assert.equal(box.value, "");
  assert.equal(box.style.height, "18px", "back to one line");
  // ⌘+Enter (Mac) / Ctrl+Enter (Windows) send too.
  box.value = "again"; key({ metaKey: true }); key({ ctrlKey: true, key: "Enter" });
  assert.equal(sent(), 2, "⌘/Ctrl+Enter sends (the second has nothing left to send)");
});
