// Requests from the Figma window reaching a session: pushed into Claude Code's conversation as a channel message,
// riding along with the next tool result for every client, listed by figma_inbox, and answered with figma_reply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FigmaAction } from "@cde/core";
import type { FigmaTransport } from "../src/bridge.ts";
import { createServer } from "../src/server.ts";
import { FigmaInbox, actionMeta, actionPrompt } from "../src/inbox.ts";

// Never the real ~/.layerwright, and never the inbox of the Claude Code session that runs these tests (its watcher
// would announce the test's requests as if the user had sent them).
process.env.LAYERWRIGHT_HOME = mkdtempSync(join(tmpdir(), "lw-home-"));
delete process.env.CLAUDE_CODE_SESSION_ID;

const action: FigmaAction = { id: "q1", kind: "code", text: "use our Card", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], page: "Checkout", file: "Shop", at: 1 };

async function connect(clientName: string) {
  const updates: { id: string; status: string; message?: string }[] = [];
  const bridge: FigmaTransport = {
    connected: () => false,
    info: () => undefined,
    request: async () => { throw new Error("not connected"); },
    actionUpdate: (id, status, message) => { updates.push({ id, status, message }); },
  };
  const server = createServer(bridge, { workdir: mkdtempSync(join(tmpdir(), "lw-inbox-")), noUpdateCheck: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: "1" });
  const pushed: any[] = [];
  client.fallbackNotificationHandler = async (n) => { pushed.push(n); };
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as any;
  return { bridge, updates, pushed, call, client };
}

test("Claude Code gets the request pushed into the conversation; it also rides along once with the next tool result", async () => {
  const t = await connect("claude-code");
  assert.ok(t.client.getServerCapabilities()?.experimental?.["claude/channel"], "the server declares itself a channel");
  t.bridge.onAction!(action);
  await new Promise((r) => setTimeout(r, 20));
  const n = t.pushed.find((x) => x.method === "notifications/claude/channel");
  assert.ok(n, "a channel message was pushed");
  assert.match(n.params.content, /Build this in code[\s\S]*"use our Card"[\s\S]*"Card" \(frame, id 1:2\)[\s\S]*figma_reply/);
  assert.deepEqual(n.params.meta, { request_id: "q1", action: "code", layers: "1", page: "Checkout" });
  assert.deepEqual(t.updates.at(-1), { id: "q1", status: "sent", message: undefined });

  const r = await t.call("figma_status");
  const extra = r.content.map((c: any) => c.text).find((x: string) => x?.includes("fromFigma"));
  assert.ok(extra, "the next tool result carries the request");
  assert.equal(JSON.parse(extra).fromFigma[0].id, "q1");
  assert.equal(t.updates.at(-1)!.status, "seen");
  const again = await t.call("figma_status");
  assert.ok(!again.content.some((c: any) => c.text?.includes("fromFigma")), "only once");

  const inbox = JSON.parse((await t.call("figma_inbox")).content[0].text);
  assert.equal(inbox.requests[0].id, "q1");
  assert.equal((await t.call("figma_reply", { id: "q1", status: "working" })).isError, undefined);
  assert.deepEqual(t.updates.at(-1), { id: "q1", status: "working", message: undefined });
  await t.call("figma_reply", { id: "q1", status: "done", message: "Card.tsx updated" });
  assert.deepEqual(t.updates.at(-1), { id: "q1", status: "done", message: "Card.tsx updated" });
  assert.deepEqual(JSON.parse((await t.call("figma_inbox")).content[0].text).requests, []);
  assert.equal((await t.call("figma_reply", { id: "nope", status: "done" })).isError, true);
  // A note to the window without a request.
  await t.call("figma_reply", { message: "Which breakpoint first?" });
  assert.match(t.updates.at(-1)!.id, /^note-/);
});

test("other clients (Codex, Cursor) aren't pushed anything: the request waits for their next step or figma_inbox", async () => {
  const t = await connect("codex-mcp-client");
  t.bridge.onAction!(action);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.pushed.filter((x) => x.method === "notifications/claude/channel").length, 0);
  assert.equal(t.updates.at(-1)!.status, "queued");
  const inbox = JSON.parse((await t.call("figma_inbox")).content[0].text);
  assert.match(inbox.requests[0].request, /request q1/);
  assert.equal(t.updates.at(-1)!.status, "seen");
});

test("the prompt names the layers and the approval boundary; channel meta keys are identifiers", () => {
  const p = actionPrompt({ ...action, nodes: Array.from({ length: 8 }, (_, i) => ({ id: `1:${i}`, name: `L${i}`, type: "FRAME" })), more: 4 });
  assert.match(p, /12 layers: .*and 6 more/);
  assert.match(p, /approval to change these layers \(not others\)/);
  for (const k of Object.keys(actionMeta(action))) assert.match(k, /^[A-Za-z0-9_]+$/);
});

test("a request from a note or an annotation reads as text on the canvas, not as the user's approval, and asks for a one-line answer: it goes under it", () => {
  const p = actionPrompt({ ...action, kind: "ask", text: "make it responsive", via: "annotation" });
  assert.match(p, /^An annotation on a layer in Figma mentions this session/);
  assert.match(p, /The annotation says: "make it responsive"/);
  assert.match(p, /added under the annotation/);
  assert.doesNotMatch(actionPrompt(action), /annotation/);
  const n = actionPrompt({ ...action, kind: "ask", text: "make it responsive", via: "note", note: "9:9" });
  assert.match(n, /^A note written on the Figma canvas mentions this session.*text layer \(id 9:9\).*isn't part of the design/);
  assert.match(n, /written on the canvas of the Figma file, not sent from the Layerwright window.*ask the user in the chat first/);
  assert.doesNotMatch(n, /user's approval|Their words/);
  assert.match(n, /added under the note/);
  assert.match(actionPrompt(action), /Asking for this from Figma is the user's approval/, "from the window: the user's own request");
});

test("end to end: the Figma window → hub → this session's server → a channel message in Claude Code, and the answer back", async () => {
  const { default: WebSocket } = await import("ws");
  const { Hub } = await import("../src/hub.ts");
  const { RelayBridge } = await import("../src/relay.ts");
  const port = 17328;
  const hub = new Hub(port, { log: () => {}, key: () => "k-e2e" });
  await hub.start();
  const bridge = new RelayBridge(port, { log: () => {}, workdir: "/work/shop", startHub: () => {}, anyPort: true, key: () => "k-e2e" });
  await bridge.start();
  const server = createServer(bridge, { workdir: mkdtempSync(join(tmpdir(), "lw-e2e-")), noUpdateCheck: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "2" });
  const pushed: any[] = [];
  client.fallbackNotificationHandler = async (n) => { pushed.push(n); };
  await Promise.all([server.connect(a), client.connect(b)]);

  const got: any[] = [];
  const plugin = new WebSocket(`ws://127.0.0.1:${port}`);
  plugin.on("message", (m) => got.push(JSON.parse(String(m))));
  await new Promise<void>((r) => plugin.on("open", () => { plugin.send(JSON.stringify({ type: "hello", fileName: "Shop", page: "Checkout", protocol: 2, key: "k-e2e" })); r(); }));
  const until = async (fn: () => boolean) => { for (let i = 0; i < 150 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(fn()); };
  await until(() => got.some((m) => m.type === "sessions" && m.sessions?.length === 1));
  const session = got.find((m) => m.type === "sessions").sessions[0].id;

  plugin.send(JSON.stringify({ type: "action", session, action }));
  await until(() => pushed.some((n) => n.method === "notifications/claude/channel"));
  await until(() => got.some((m) => m.type === "action-update" && m.status === "sent"));
  await client.callTool({ name: "figma_reply", arguments: { id: "q1", status: "done", message: "Card.tsx updated" } });
  await until(() => got.some((m) => m.type === "action-update" && m.status === "done"));
  assert.equal(got.find((m) => m.status === "done").message, "Card.tsx updated");

  plugin.close(); bridge.close(); hub.close();
});

test("Claude Code's monitor: the server writes the request for its own session, inbox-watch turns it into one line for Claude", async () => {
  const { mkdtempSync: mk } = await import("node:fs");
  process.env.LAYERWRIGHT_HOME = mk(join(tmpdir(), "lw-home-"));
  process.env.CLAUDE_CODE_SESSION_ID = "sess-1234567";
  const { inboxWatch } = await import("../src/cli.ts");
  const lines: string[] = [];
  const stop = new AbortController();
  const watching = inboxWatch({ out: (s) => lines.push(s), pollMs: 20, signal: stop.signal });
  await new Promise((r) => setTimeout(r, 60)); // it starts at the end of the file: older requests aren't replayed
  const t = await connect("claude-code");
  t.bridge.onAction!(action);
  t.bridge.onAction!({ ...action, id: "q2", kind: "ask", text: "tighter", via: "note", note: "9:9" });
  for (let i = 0; i < 50 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  stop.abort();
  await watching;
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Request q1 from the Layerwright window in Figma: Build this in code \("use our Card"\) on 1 layer: "Card" \(frame, id 1:2\)\. Call figma_inbox now/);
  assert.match(lines[1], /^Request q2 from a note on the Figma canvas that mentions this session: Help with this \("tighter"\)/);
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

test("one watcher per session: a second inbox-watch (plugin monitor + one the agent started) exits at once", async () => {
  const { mkdtempSync: mk } = await import("node:fs");
  process.env.LAYERWRIGHT_HOME = mk(join(tmpdir(), "lw-home-"));
  process.env.CLAUDE_CODE_SESSION_ID = "sess-lock-1";
  const { inboxWatch } = await import("../src/cli.ts");
  const stop = new AbortController();
  const first = inboxWatch({ out: () => {}, pollMs: 20, signal: stop.signal });
  await new Promise((r) => setTimeout(r, 40));
  const started = Date.now();
  // Another process would hold the lock; here the same process stands in for it, so fake an owner that's alive.
  const { writeFileSync } = await import("node:fs");
  const { inboxFile } = await import("../src/meta.ts");
  writeFileSync(inboxFile()! + ".lock", String(process.ppid));
  assert.equal(await inboxWatch({ out: () => {}, pollMs: 20 }), 0);
  assert.ok(Date.now() - started < 500, "returned at once");
  stop.abort();
  await first;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

test("figma_status tells Claude Code, once, how to start watching for requests from the Figma window", async () => {
  process.env.CLAUDE_CODE_SESSION_ID = "sess-hint-1";
  const t = await connect("claude-code");
  const first = JSON.parse((await t.call("figma_status")).content[0].text);
  assert.equal(first.doFirst.tool, "Monitor");
  assert.match(first.doFirst.command, / inbox-watch$/);
  assert.equal(first.doFirst.timeout_ms, 1800000);
  assert.match(first.requestsFromFigma, /^Before you answer the user, start the Monitor/);
  const second = JSON.parse((await t.call("figma_status")).content[0].text);
  assert.equal(second.doFirst, undefined);
  const connect2 = JSON.parse((await t.call("figma_status", { listen: true })).content[0].text);
  assert.equal(connect2.doFirst.tool, "Monitor", "/layer:connect asks for it again");
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

test("the language the user chose: saved once, every session's figma_status says it", async () => {
  const t = await connect("claude-code");
  assert.equal(JSON.parse((await t.call("figma_status")).content[0].text).language, undefined);
  const saved = JSON.parse((await t.call("layerwright_memory", { action: "language", language: "Persian" })).content[0].text);
  assert.equal(saved.language, "Persian");
  const other = await connect("codex-mcp-client");
  const st = JSON.parse((await other.call("figma_status")).content[0].text);
  assert.equal(st.language, "Persian");
  assert.match(st.languageNote, /Explain things to the user in Persian/);
  await t.call("layerwright_memory", { action: "language", language: "" });
});

test("waiting for the user: a question at the end of a message (options may follow), a permission, or a stop with a request still open", async () => {
  const { lastQuestion, waitingFor } = await import("../src/inbox.ts");
  assert.equal(lastQuestion("Done. Which style do you want?\n- Filled\n- Outline"), "Which style do you want?");
  assert.equal(lastQuestion("کدوم رنگ رو می‌خوای؟"), "کدوم رنگ رو می‌خوای؟");
  assert.equal(lastQuestion("All done, the card is a component now."), undefined);
  assert.deepEqual(waitingFor({ event: "ask", text: "Pick one" }, false), { kind: "question", text: "Pick one" });
  assert.deepEqual(waitingFor({ event: "permission", text: "Claude needs your permission to use Bash" }, false), { kind: "permission", text: "Claude needs your permission to use Bash" });
  assert.deepEqual(waitingFor({ event: "stop", text: "I made it. Should I also do the dark mode?" }, false), { kind: "question", text: "Should I also do the dark mode?" });
  assert.equal(waitingFor({ event: "stop", text: "All done." }, false), undefined);
  assert.deepEqual(waitingFor({ event: "stop", text: "I need the brand colours first." }, true), { kind: "turn", text: "I need the brand colours first." });
  assert.equal(waitingFor({ event: "answered" }, true), undefined);
});

test("the chat hooks note what the session does (hook-event); its server tells the Figma window, until it works again", async () => {
  const { hookEvent } = await import("../src/cli.ts");
  const { stateFile } = await import("../src/meta.ts");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const transcript = join(mkdtempSync(join(tmpdir(), "lw-tr-")), "t.jsonl");
  writeFileSync(transcript, [JSON.stringify({ type: "user", message: { content: "make it" } }), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Made the card. Want a dark version too?" }] } })].join("\n"));
  await hookEvent({ input: JSON.stringify({ session_id: "sess-chat-1", hook_event_name: "Stop", transcript_path: transcript }) });
  assert.deepEqual(JSON.parse(readFileSync(stateFile("sess-chat-1")!, "utf8")).text, "Made the card. Want a dark version too?");
  await hookEvent({ input: JSON.stringify({ session_id: "sess-chat-1", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which style?" }] } }) });
  assert.deepEqual(JSON.parse(readFileSync(stateFile("sess-chat-1")!, "utf8")).event, "ask");

  process.env.CLAUDE_CODE_SESSION_ID = "sess-chat-2";
  const t = await connect("claude-code");
  const told: any[] = [];
  t.bridge.notify = (m) => { told.push(m); };
  await t.call("figma_status"); // it works in Figma
  writeFileSync(stateFile("sess-chat-2")!, JSON.stringify({ event: "ask", text: "Which style?", at: Date.now() }));
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(told.at(-1), { type: "session-state", waiting: true, kind: "question", text: "Which style?" });
  await t.call("figma_status");
  assert.deepEqual(told.at(-1), { type: "session-state", waiting: false, kind: undefined, text: undefined }, "working again: the window stops asking");
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

test("multitasking: a Figma call names the request it works for (requestId); the bridge carries it, the tool never sees it", async () => {
  const { currentTask } = await import("../src/task.ts");
  const seen: (string | undefined)[] = [];
  const bridge: FigmaTransport = {
    connected: () => true,
    info: () => undefined,
    request: async (method: string) => { seen.push(currentTask()); return method === "inspect" ? { page: "P", nodes: [] } : {}; },
  } as any;
  const server = createServer(bridge, { workdir: mkdtempSync(join(tmpdir(), "lw-task-")), noUpdateCheck: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.find((x) => x.name === "figma_edit")!.inputSchema.properties!.requestId, "Figma tools take the request id");
  assert.ok(!tools.find((x) => x.name === "figma_reply")!.inputSchema.properties!.requestId, "not the inbox ones");
  assert.equal((tools.find((x) => x.name === "figma_get_design_context")!.inputSchema.properties!.task as any).type, "string", "a tool's own task argument is left alone");
  await client.callTool({ name: "figma_inspect", arguments: { target: "1:2", requestId: "q42" } });
  await client.callTool({ name: "figma_inspect", arguments: { target: "1:2" } });
  assert.deepEqual(seen, ["q42", undefined]);
});

test("a request another session took over is no longer this session's, and figma_reply can say who has it", () => {
  const box = new FigmaInbox();
  const a = { id: "q1", kind: "polish", nodes: [{ id: "1:2", name: "Card", type: "FRAME" }], at: 1 } as FigmaAction;
  box.add(a, true);
  box.drop("q1", "Checkout redesign");
  assert.equal(box.reply("q1", "working"), false);
  assert.equal(box.takenBy("q1"), "Checkout redesign");
  box.adopt(a); // taken back
  assert.equal(box.takenBy("q1"), undefined);
  assert.equal(box.reply("q1", "done"), true);
});

test("the user stops a request in the Figma window: the session hears it once, its watcher wakes it, and nothing more happens for it", async () => {
  const { mkdtempSync: mk } = await import("node:fs");
  process.env.LAYERWRIGHT_HOME = mk(join(tmpdir(), "lw-home-"));
  process.env.CLAUDE_CODE_SESSION_ID = "sess-stop-1";
  const { inboxWatch } = await import("../src/cli.ts");
  const lines: string[] = [];
  const stop = new AbortController();
  const watching = inboxWatch({ out: (s) => lines.push(s), pollMs: 20, signal: stop.signal });
  await new Promise((r) => setTimeout(r, 60));
  const t = await connect("claude-code");
  t.bridge.onAction!({ ...action, id: "q7", skills: ["design-handoff"] });
  const got = JSON.parse((await t.call("figma_inbox")).content[0].text);
  assert.match(got.requests[0].request, /The user picked this skill for it: design-handoff\. Read it first with layerwright_skills/);
  assert.equal((await t.call("figma_reply", { id: "q7", status: "working" })).isError, undefined);
  t.bridge.onActionStop!("q7");
  for (let i = 0; i < 50 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  stop.abort();
  await watching;
  assert.match(lines.at(-1)!, /^The user stopped request q7 in the Layerwright window in Figma\. Stop working on it now/);
  assert.ok(t.pushed.some((n: any) => n.params?.meta?.action === "stop" && /stopped request q7/.test(n.params.content)), "Claude Code also gets it pushed");
  // Any tool result carries it once; the request's own Figma calls and its reply are refused.
  const next = await t.call("figma_status", { title: "Stop test" });
  assert.match(next.content.map((c: any) => c.text).join("\n"), /"stoppedInFigma":\["q7"\]/);
  const again = await t.call("figma_status", { title: "Stop test" });
  assert.doesNotMatch(again.content.map((c: any) => c.text).join("\n"), /stoppedInFigma/);
  const work = await t.call("figma_inspect", { target: "1:2", requestId: "q7" });
  assert.ok(work.isError);
  assert.match(work.content[0].text, /"type":"STOPPED"/);
  const reply = await t.call("figma_reply", { id: "q7", status: "done", message: "built it" });
  assert.ok(reply.isError);
  assert.match(reply.content[0].text, /stopped request q7/);
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

test("a skill sent on its own: the brief is to apply it to the layers, and the watcher's line names it", async () => {
  const { actionPrompt: prompt } = await import("../src/inbox.ts");
  const p = prompt({ ...action, kind: "ask", text: undefined, skills: ["design-critique"] });
  assert.match(p, /The user picked this skill for it: design-critique/);
  assert.match(p, /What to do: Apply the picked skill to the selected layers: follow its own process/);
  const { mkdtempSync: mk } = await import("node:fs");
  process.env.LAYERWRIGHT_HOME = mk(join(tmpdir(), "lw-home-"));
  process.env.CLAUDE_CODE_SESSION_ID = "sess-skill-1";
  const { inboxWatch } = await import("../src/cli.ts");
  const lines: string[] = [];
  const stop = new AbortController();
  const watching = inboxWatch({ out: (s) => lines.push(s), pollMs: 20, signal: stop.signal });
  await new Promise((r) => setTimeout(r, 60));
  const t = await connect("claude-code");
  t.bridge.onAction!({ ...action, id: "q8", kind: "ask", text: undefined, skills: ["design-critique"] });
  for (let i = 0; i < 50 && !lines.length; i++) await new Promise((r) => setTimeout(r, 20));
  stop.abort();
  await watching;
  assert.match(lines[0], /^Request q8 from the Layerwright window in Figma: Apply with the skill design-critique on 1 layer: "Card"/);
  delete process.env.CLAUDE_CODE_SESSION_ID;
});
