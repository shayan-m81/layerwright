// The AI cursor, on the strict mock: it shows a session's whole task. It comes with the session's first step (a read
// too), goes where each step works (the work doesn't wait for it), stays near between steps, and goes once the session
// is done or quiet, leaving nothing behind (no layers, no timers). Every undo step is closed with no cursor in it, it
// steps aside while the user works, an undo that takes it away doesn't bring it back on a redo, and its tag says
// briefly who it is and what it's doing.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { pendingTimers } from "./timers.ts";
import { N, loaded, nodes, resetFigma } from "./figma-mock.ts";

const F = () => (globalThis as any).figma;
let page: any;
const commits: number[] = []; // how many overlays were in the file at each commit
function world() {
  page = resetFigma();
  loaded.add("Inter::Semi Bold"); // fonts stay loaded for as long as the plugin runs (the cursor loads its own once)
  const frame = (id: string, name: string, x: number, y: number, width: number, height: number) => { const f = new N("FRAME", id); Object.assign(f, { name, x, y, width, height }); page.appendChild(f); return f; };
  frame("5:5", "Header", 400, 300, 200, 100);
  frame("6:6", "Footer", 100, 600, 300, 80);
  frame("7:7", "New screen", 3000, 2000, 390, 844);
  F().viewport.zoom = 2; // the view shows (0, 0)–(1000, 800)
  F().viewport.center = { x: 500, y: 400 };
  commits.length = 0;
  F().commitUndo = () => commits.push(overlays().length);
}
world();
const cursor = await import("../src/cursor.ts");
const undo = await import("../src/undo.ts");
const own = await import("../src/own.ts");
Object.assign(cursor.timing, { glide: 20, select: 20, type: 0, end: 60, fade: 20, quiet: 150, think: 400, turn: 400, busy: 400, ask: 300, done: 60 });
cursor.timing.life = 0; // still between moves, unless a test wants it lively
cursor.timing.min = 0; // tests that want the minimum time on screen set it
beforeEach(() => { cursor.cursorsClear(); world(); });
after(() => cursor.cursorsClear()); // a failed test must not leave a cursor going

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every overlay in the file: the top level of each page. */
const overlays = () => (F()?.root.children ?? []).flatMap((p: any) => p.children).filter((n: any) => cursor.isOverlay(n));
const cursors = () => overlays().filter((n: any) => n.name.includes("(Layerwright cursor)"));
const at = (name: string) => cursors().find((n: any) => n.name === `✦ ${name} (Layerwright cursor)`);
const texts = (name: string) => at(name)?.findAll((n: any) => n.type === "TEXT") ?? [];
const labelOf = (name = "Checkout") => texts(name)[0]?.characters as string | undefined;
const A = { id: "s1", name: "Checkout", color: "#0d99ff" };
const RENAME = { ops: [{ op: "rename", node: "5:5", name: "Top bar" }] };
/** A request that changes the canvas, the way code.ts runs it: undo step open, cursor, the work, cursor end, the
 *  change's outlines and helpers go, step closes. */
async function change(who: typeof A, method: string, params: unknown, work: () => Promise<unknown> | unknown = () => undo.commitUndo(), result: unknown = {}) {
  undo.holdUndo();
  try {
    cursor.cursorBegin(who, method, params);
    await work();
    await cursor.cursorEnd(who, true, method, result, params);
  } finally { cursor.cursorWorkEnd(); undo.releaseUndo(); }
}
/** A read, the way code.ts runs it: no undo step. */
async function read(who: typeof A, method: string, params: unknown, ms = 60) {
  cursor.cursorBegin(who, method, params);
  await sleep(ms);
  await cursor.cursorEnd(who, true, method, {}, params);
}
/** Wait until the cursors are gone (or fail after a while). */
async function gone(ms = 2000) {
  const t0 = Date.now();
  while (overlays().length && Date.now() - t0 < ms) await sleep(20);
  await sleep(60);
}

test("where the cursor goes: what an edit touches, what an inspect or a picture looks at; where a build lands", () => {
  assert.deepEqual(cursor.cursorTargets("editNodes", { ops: [{ op: "rename", node: "1:1" }, { op: "rename", node: "$0" }, { op: "group", nodes: ["1:2"] }] }), ["1:1", "1:2"]);
  assert.deepEqual(cursor.cursorTargets("inspect", { target: "3:3" }), ["3:3"]);
  assert.deepEqual(cursor.cursorTargets("inspect", { target: "selection" }), []);
  assert.deepEqual(cursor.cursorTargets("exportImage", { nodeId: "4:4" }), ["4:4"]);
  assert.equal(cursor.landingOf("executePlan", { createdRootIds: ["7:1"] }), "7:1");
  assert.equal(cursor.landingOf("importTree", { sectionId: "8:1" }), "8:1");
});

test("a change: the cursor drag-selects the layer while the work runs; the step closes without it, and it stays, thinking", async () => {
  undo.holdUndo();
  cursor.cursorBegin(A, "editNodes", RENAME);
  await sleep(120);
  const root = at("Checkout");
  assert.ok(root && root.locked, "a locked cursor");
  const mark = JSON.parse(root.getPluginData("layerwrightCursor"));
  assert.equal(mark.user, "u:1", "tagged with the Figma user who drew it");
  assert.ok(Date.now() - mark.at < 2000, "and when");
  assert.ok(Math.abs(root.x - 600) < 1 && Math.abs(root.y - 400) < 1, `dragged across the layer to its far corner (${root.x}, ${root.y})`);
  assert.equal(root.width, 0.5, "half size at 200% zoom: the same size on screen");
  assert.equal(labelOf(), "Checkout  ·  renaming “Header” → “Top bar”");
  assert.equal(texts("Checkout").length, 1, "one line: who it is and what it's doing");
  const box = overlays().find((n: any) => n.name === "Checkout is here (Layerwright)");
  assert.equal(box?.type, "GROUP", "the layer is outlined: a group of thin edges, so the layer under it stays clickable");
  assert.equal(box.children.filter((h: any) => h.name === "Handle").length, 4, "with Figma's corner handles");
  undo.commitUndo(); // what the handler does at its end
  assert.deepEqual(commits, [], "held while the request runs");
  const t0 = Date.now();
  await cursor.cursorEnd(A, true, "editNodes", { applied: [{ nodeId: "5:5" }] }, RENAME);
  assert.ok(Date.now() - t0 < cursor.timing.end + 40, `the ending is short (${Date.now() - t0} ms)`);
  cursor.cursorWorkEnd();
  undo.releaseUndo();
  assert.deepEqual(commits, [0], "one commit, with no overlay in the file");
  assert.equal(cursors().length, 1, "drawn again right after: it stays near");
  assert.equal(overlays().length, 1, "the outline went with the change");
  assert.equal(labelOf(), "Checkout  ·  1 change done ✓", "saying what it did");
  await sleep(150);
  assert.match(labelOf()!, /^Checkout {2}· {2}thinking\.{0,3}$/, "then thinking until the session's next step");
  await gone();
  assert.equal(overlays().length, 0, "a quiet session's cursor goes");
  assert.deepEqual(pendingTimers(), [], "and nothing keeps running");
});

test("a whole task: reads, the change and the time between them are one cursor, from the first step to the end", async () => {
  await read(A, "inspect", { target: "5:5" });
  const first = at("Checkout");
  assert.ok(first, "a read brings it too");
  assert.equal(labelOf(), "Checkout  ·  reading “Header”");
  assert.deepEqual(commits, [], "a read is no undo step");
  await sleep(100);
  assert.match(labelOf()!, /^Checkout {2}· {2}thinking\.{0,3}$/, "between steps it thinks");
  await read(A, "scanDesignSystem", {});
  assert.equal(at("Checkout"), first, "the same cursor, not a new one");
  await change(A, "editNodes", RENAME, async () => { await sleep(40); undo.commitUndo(); });
  assert.deepEqual(commits, [0], "the change's step holds no cursor");
  assert.equal(cursors().length, 1, "and it's still there");
  await cursor.cursorAsk(A, false, "done"); // Claude Code: its turn ended
  assert.equal(labelOf(), "Checkout  ·  done ✓");
  await gone();
  assert.equal(overlays().length, 0, "it goes once the session is done");
  assert.deepEqual(pendingTimers(), []);
});

test("the tag stays brief: who it is, and a short line of what it's doing", async () => {
  const LONG = { ops: [{ op: "rename", node: "5:5", name: "A very long new name for the header frame" }] };
  undo.holdUndo();
  cursor.cursorBegin(A, "editNodes", LONG);
  await sleep(60);
  assert.equal(labelOf(), "Checkout  ·  renaming “Header” → “A very long …");
  await cursor.cursorEnd(A, true, "editNodes", {}, LONG);
  cursor.cursorWorkEnd(); undo.releaseUndo();
});

test("calls that bring no cursor: a status check, a link, setting up pages", async () => {
  const before = nodes.size;
  for (const m of ["ping", "refs", "ensurePages"]) await read(A, m, {}, 20);
  assert.equal(nodes.size, before, "not a single node was created");
  assert.deepEqual(pendingTimers(), []);
});

test("the work never waits for the cursor, and a quick change still shows it: the ending waits for it and keeps it on screen a moment", async () => {
  cursor.timing.min = 150;
  try {
    const order: string[] = [];
    let seen = 0;
    const t0 = Date.now();
    const done = change(A, "editNodes", RENAME, () => { order.push(`work with ${overlays().length} overlays`); undo.commitUndo(); });
    while (Date.now() - t0 < 2000 && !seen) { await sleep(10); seen = cursors().length; }
    await done;
    assert.deepEqual(order, ["work with 0 overlays"], "the handler ran at once, before the cursor was drawn");
    assert.equal(seen, 1, "the cursor was drawn even though the work was already done");
    assert.ok(Date.now() - t0 >= 150, `and stayed at least timing.min (${Date.now() - t0} ms)`);
    assert.deepEqual(commits, [0], "one step, with no overlay in the file");
  } finally { cursor.timing.min = 0; }
});

test("a cursor that can't be set up never holds a change for long", async () => {
  cursor.timing.drawWait = 80;
  const find = F().getNodeByIdAsync;
  F().getNodeByIdAsync = () => new Promise(() => {}); // where the change lands is never found: the cursor never comes
  try {
    const t0 = Date.now();
    await change(A, "editNodes", RENAME);
    assert.ok(Date.now() - t0 < 400, `the request ended after drawWait (${Date.now() - t0} ms)`);
    assert.equal(overlays().length, 0);
    assert.deepEqual(commits, [0]);
  } finally { F().getNodeByIdAsync = find; cursor.timing.drawWait = 1500; }
});

test("two changes back to back are two undo steps, each without the cursor", async () => {
  await change(A, "editNodes", RENAME, async () => { await sleep(80); undo.commitUndo(); });
  await change(A, "editNodes", { ops: [{ op: "rename", node: "6:6", name: "Bottom" }] }, async () => { await sleep(80); undo.commitUndo(); });
  assert.deepEqual(commits, [0, 0]);
  assert.equal(cursors().length, 1);
});

test("a write outside any request (a note's answer) is a step of its own, without the cursor either", async () => {
  await read(A, "inspect", { target: "5:5" });
  assert.equal(cursors().length, 1);
  undo.ownStep(() => { page.name = "Renamed"; });
  await sleep(0);
  assert.deepEqual(commits, [0]);
  assert.equal(cursors().length, 1, "drawn again after it");
});

test("a failed change commits nothing of its own, and its cursor says so", async () => {
  undo.holdUndo();
  cursor.cursorBegin(A, "editNodes", RENAME);
  await sleep(60);
  assert.ok(at("Checkout"));
  await cursor.cursorEnd(A, false, "editNodes");
  assert.equal(labelOf(), "Checkout  ·  hit a problem");
  cursor.cursorWorkEnd();
  undo.releaseUndo();
  assert.deepEqual(commits, [], "no step: the handler asked for none");
});

test("the user works in Figma: the cursors step aside, and come back with the session's next step once the user leaves Figma alone", async () => {
  await read(A, "inspect", { target: "5:5" });
  assert.equal(cursors().length, 1);
  cursor.cursorsYield();
  assert.equal(overlays().length, 0, "off the canvas at once");
  await read(A, "inspect", { target: "6:6" }, 30);
  assert.equal(overlays().length, 0, "a read right after doesn't bring it back while the user is busy");
  await sleep(cursor.timing.quiet);
  await read(A, "inspect", { target: "6:6" });
  assert.equal(cursors().length, 1, "the user left Figma alone: the next step brings it back");
});

test("while a change runs, the user working doesn't take its cursor away; the step then closes without drawing it again", async () => {
  undo.holdUndo();
  cursor.cursorBegin(A, "editNodes", RENAME);
  await sleep(80);
  cursor.cursorsYield();
  assert.equal(cursors().length, 1, "the change finishes with its cursor");
  undo.commitUndo();
  await cursor.cursorEnd(A, true, "editNodes", {}, RENAME);
  cursor.cursorWorkEnd();
  undo.releaseUndo();
  assert.deepEqual(commits, [0]);
  assert.equal(overlays().length, 0, "not drawn again while the user is busy");
});

test("an undo that takes the cursor away: it stays away until the session's next step, and a redo doesn't bring it back", async () => {
  await sleep(cursor.timing.quiet); // the user's work in the test before
  await read(A, "inspect", { target: "5:5" });
  const was = at("Checkout");
  const pg = was.parent;
  was.remove(); // what an undo does
  await sleep(80);
  assert.equal(overlays().length, 0, "not drawn back by itself");
  pg.appendChild(was); was.removed = false; // what a redo does: the same layer, back
  await sleep(80);
  assert.equal(was.removed, true, "taken away again");
  assert.equal(overlays().length, 0);
  await sleep(cursor.timing.quiet);
  await read(A, "inspect", { target: "5:5" });
  assert.equal(cursors().length, 1, "the session's next step brings it back");
});

test("the user zooms while it works: it keeps its size on screen", async () => {
  undo.holdUndo();
  cursor.cursorBegin(A, "editNodes", RENAME);
  await sleep(100);
  assert.equal(at("Checkout").width, 0.5);
  own.lookAtView();
  F().viewport.zoom = 4; // the user, not Layerwright
  await sleep(90);
  assert.equal(at("Checkout").width, 0.25, "rescaled to the new zoom");
  assert.ok(Date.now() - own.userActiveAt() < 500, "and the user moving the view counts as them working");
  cursor.cursorWorkEnd(); undo.releaseUndo();
});

test("the tag says what is really happening: the layer, the text typed, what was built, and how far along it is", async () => {
  const nm = (id: unknown) => (id === "1:1" ? "“Header”" : "a layer");
  assert.equal(cursor.describeRequest("editNodes", { ops: [{ op: "set", node: "1:1", text: "Pay now" }] }, nm), "typing “Pay now”");
  assert.equal(cursor.describeRequest("editNodes", { ops: [{ op: "componentize", nodes: ["1:1"] }] }, nm), "turning “Header” into a component");
  assert.equal(cursor.describeRequest("editNodes", { ops: [{ op: "rename", node: "1:1", name: "A" }, { op: "rename", node: "1:2", name: "B" }] }, nm), "renaming 2 layers");
  assert.equal(cursor.describeRequest("editNodes", { ops: [{ op: "delete", node: "1:1" }, { op: "move", node: "1:2" }] }, nm), "deleting “Header” · 2 changes");
  assert.equal(cursor.describeRequest("executePlan", { plan: { roots: [{ name: "Checkout" }, { name: "Cart" }] } }, nm), "building “Checkout” +1");
  assert.equal(cursor.describeRequest("importTree", { screens: [{ name: "Landing page" }] }, nm), "importing “Landing page”");
  assert.equal(cursor.describeRequest("inspect", { target: "selection" }, nm), "reading your selection");
  assert.equal(cursor.describeRequest("exportImage", { nodeId: "1:1" }, nm), "taking a picture of “Header”");
  assert.equal(cursor.describeDone("executePlan", {}, { createdRootIds: ["1", "2"] }), "built 2 frames ✓");
  assert.equal(cursor.describeDone("editNodes", { ops: [{ op: "componentize" }] }, { applied: [{}] }), "component ready ✓");

  undo.holdUndo();
  cursor.cursorBegin(A, "executePlan", { plan: { roots: [{ name: "Hero" }] } });
  await sleep(30);
  assert.equal(labelOf(), "Checkout  ·  building “Hero”");
  cursor.cursorProgress('Building "Hero"', 1, 4);
  assert.equal(labelOf(), "Checkout  ·  building “Hero” · 2/4", "the plugin's own progress, on the tag");
  const ending = cursor.cursorEnd(A, true, "executePlan", { createdRootIds: ["7:7"] });
  assert.equal(labelOf(), "Checkout  ·  built 1 frame ✓", "what it did, for a moment");
  await ending;
  cursor.cursorWorkEnd();
  undo.releaseUndo();
  cursor.cursorProgress("Scanning", 1, 2);
  assert.equal(labelOf(), "Checkout  ·  built 1 frame ✓", "no change running: progress moves nothing");
});

test("work on several layers brings a crew: a helper in a nearby shade goes to each other layer and says what it does there", async () => {
  const ops = [{ op: "rename", node: "5:5", name: "Top" }, { op: "set", node: "6:6", text: "© 2026" }];
  undo.holdUndo();
  cursor.cursorBegin(A, "editNodes", { ops });
  await sleep(200);
  const helper = at("Checkout 2");
  assert.ok(helper, "a helper split off");
  assert.ok(Math.abs(helper.x - 400) < 1 && Math.abs(helper.y - 680) < 1, `it drag-selected the footer (${helper.x}, ${helper.y})`);
  assert.equal(labelOf("Checkout 2"), "Checkout 2  ·  typing “© 2026”", "it says what it does there");
  assert.notEqual(cursor.shade("#0d99ff", 26), "#0d99ff");
  await cursor.cursorEnd(A, true, "editNodes", { applied: [{ nodeId: "5:5" }, { nodeId: "6:6" }] }, { ops });
  cursor.cursorWorkEnd();
  undo.releaseUndo();
  assert.deepEqual(cursors().map((n: any) => n.name), ["✦ Checkout (Layerwright cursor)"], "the crew goes with the change; the session's own stays");
});

test("step by step: progress moves a cursor to the layer that step works on", async () => {
  const ops = [{ op: "rename", node: "5:5", name: "A" }, { op: "rename", node: "5:5", name: "B" }, { op: "delete", node: "6:6" }, { op: "rename", node: "5:5", name: "C" }];
  const solo = { id: "s9", name: "Solo", color: "#14ae5c" };
  undo.holdUndo();
  cursor.cursorBegin(solo, "editNodes", { ops });
  await sleep(100);
  cursor.cursorProgress("Editing layers (delete)", 2, 4);
  await sleep(400);
  const c = at("Solo")!;
  assert.ok(c.x >= 100 && c.x <= 400 && c.y >= 600 && c.y <= 680, `on the footer for the step that deletes it (${c.x}, ${c.y})`);
  cursor.cursorWorkEnd(); undo.releaseUndo();
});

test("lively: a working cursor keeps moving over its layer instead of standing still", async () => {
  cursor.timing.life = 4;
  undo.holdUndo();
  cursor.cursorBegin({ id: "s8", name: "Busy", color: "#e83e8c" }, "editNodes", { ops: [{ op: "rename", node: "5:5", name: "X" }] });
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) { await sleep(60); const c = at("Busy"); if (c) seen.add(`${Math.round(c.x)},${Math.round(c.y)}`); }
  cursor.timing.life = 0;
  assert.ok(seen.size >= 3, `it moved around (${seen.size} places)`);
  const c = at("Busy")!;
  assert.ok(c.x >= 400 && c.x <= 610 && c.y >= 300 && c.y <= 410, `and stayed on the layer (${c.x}, ${c.y})`);
  cursor.cursorWorkEnd(); undo.releaseUndo();
});

test("the request opens another page: the cursor goes along", async () => {
  undo.holdUndo();
  cursor.cursorBegin(A, "editNodes", RENAME);
  await sleep(60);
  const other = F().root.children[1];
  await own.openPage(other);
  await sleep(60);
  assert.equal(at("Checkout")?.parent, other);
  cursor.cursorWorkEnd(); undo.releaseUndo();
});

test("a request from the window: once the session has it, its cursor goes to the request's layers and says what it's on, until it's finished", async () => {
  await cursor.cursorBusy(A, true, ["6:6"], "polish");
  await sleep(80);
  const c = at("Checkout");
  assert.ok(c, "it comes for the request");
  assert.match(labelOf()!, /^Checkout {2}· {2}on it: polishing this\.{0,3}$/);
  assert.ok(c.x >= 100 && c.x <= 400 && c.y >= 600 && c.y <= 680, `on the request's layer (${c.x}, ${c.y})`);
  await read(A, "inspect", { target: "6:6" });
  await sleep(40);
  assert.match(labelOf()!, /^Checkout {2}· {2}on it: polishing this\.{0,3}$/, "between steps, it's still on the request (thinking dots and all)");
  await cursor.cursorBusy(A, false);
  assert.equal(labelOf(), "Checkout  ·  finished your request ✓");
  await gone();
  assert.equal(overlays().length, 0);
});

test("the session asks the user in its chat: its cursor says so and waves until the answer, then gets back to work", async () => {
  await read(A, "inspect", { target: "5:5" });
  await cursor.cursorAsk(A, true, "question");
  assert.equal(labelOf(), "Checkout  ·  asks you in Claude Code");
  await cursor.cursorAsk(A, false);
  assert.equal(labelOf(), "Checkout  ·  thanks! back to work");
  await cursor.cursorAsk({ ...A, id: "s404" }, true, "question");
  assert.equal(cursors().length, 1, "a session with no cursor here asks only in its chat (the window says so)");
});

test("a session leaves: its cursor goes at once; the switch turned off takes every cursor away", async () => {
  cursor.cursorBegin(A, "inspect", { target: "5:5" });
  cursor.cursorBegin({ id: "s2", name: "Docs", color: "#14ae5c" }, "inspect", { target: "6:6" });
  await sleep(60);
  assert.equal(cursors().length, 2);
  cursor.cursorGone("s1");
  assert.deepEqual(cursors().map((n: any) => n.name), ["✦ Docs (Layerwright cursor)"]);
  cursor.setCursorEnabled(false);
  assert.equal(overlays().length, 0);
  cursor.setCursorEnabled(true);
  await sleep(60);
  assert.deepEqual(pendingTimers(), []);
});

test("leftovers: this user's (a window that closed with a cursor drawn), an older version's and stale ones go; another user's live cursor and this window's own stay", async () => {
  cursor.cursorBegin(A, "inspect", { target: "5:5" });
  await sleep(60);
  const left = (data: string) => { const f = F().createFrame(); f.setPluginData("layerwrightCursor", data); return f; };
  const mine = left(JSON.stringify({ user: "u:1", at: Date.now() }));
  const theirs = left(JSON.stringify({ user: "u:2", at: Date.now() - 60_000 }));
  const stale = left(JSON.stringify({ user: "u:2", at: Date.now() - 31 * 60_000 }));
  const legacy = left("1");
  const keep = F().createFrame();
  assert.equal(cursor.removeLeftovers(), 3);
  assert.deepEqual([mine.removed, theirs.removed, stale.removed, legacy.removed, keep.removed], [true, false, true, true, false]);
  assert.ok(at("Checkout") && !at("Checkout").removed, "the cursor this window shows now isn't a leftover");
  await cursor.cursorEnd(A, true, "inspect", {});
});

test("zoom to the result: a build always, an edit only off screen, and everything a request from the window changed when it's done", async () => {
  const zoom = await import("../src/zoom.ts");
  zoom.zoomTiming.glide = 30;
  zoom.zoomTiming.gap = 0;
  zoom.zoomTiming.respect = 0; // the user zoomed in an earlier test
  const v = F().viewport;
  const reset = () => { v.zoom = 2; v.center = { x: 500, y: 400 }; };
  assert.deepEqual(zoom.resultIds("editNodes", { applied: [{ nodeId: "1:1", kind: "rename" }, { nodeId: "1:2", kind: "delete" }] }), ["1:1"]);
  const f = zoom.fitView({ x: 0, y: 0, width: 1000, height: 1000 }, { w: 1000, h: 800 }, 2);
  assert.deepEqual(f.center, { x: 500, y: 500 });
  assert.ok(Math.abs(f.zoom - 800 / 1300) < 1e-9, "the whole box, with some air");
  assert.equal(zoom.fitView({ x: 0, y: 0, width: 10, height: 10 }, { w: 1000, h: 800 }, 0.5).zoom, 1, "a small result: no closer than 100%");

  reset();
  await zoom.zoomAfter("s1", "executePlan", { createdRootIds: ["7:7"] });
  assert.deepEqual(v.center, { x: 3195, y: 2422 }, "a build: the view glides to the new frame");
  reset();
  await zoom.zoomAfter("s1", "editNodes", { applied: [{ nodeId: "5:5", kind: "rename" }] });
  assert.deepEqual(v.center, { x: 500, y: 400 }, "an edit the user can see: the view stays");

  reset();
  await zoom.zoomRequest("s1", "working");
  await zoom.zoomAfter("s1", "editNodes", { applied: [{ nodeId: "5:5", kind: "rename" }] });
  await zoom.zoomAfter("s1", "editNodes", { applied: [{ nodeId: "6:6", kind: "rename" }] });
  await zoom.zoomRequest("s1", "done");
  assert.deepEqual(v.center, { x: 350, y: 490 }, "the request from the window is done: everything it changed, together");
  zoom.setZoomEnabled(false);
  reset();
  await zoom.zoomAfter("s1", "executePlan", { createdRootIds: ["7:7"] });
  assert.deepEqual(v.center, { x: 500, y: 400 }, "switched off: the view is left alone");
  zoom.setZoomEnabled(true);
});

test("zoom to the result waits while the user works: the result is held for the window to offer", async () => {
  const zoom = await import("../src/zoom.ts");
  zoom.zoomTiming.glide = 30;
  zoom.zoomTiming.respect = 4000;
  const v = F().viewport;
  v.zoom = 2; v.center = { x: 500, y: 400 };
  own.userActed();
  const r = await zoom.zoomAfter("s1", "executePlan", { createdRootIds: ["7:7"] });
  assert.deepEqual(r, { shown: false, held: ["7:7"] });
  assert.deepEqual(v.center, { x: 500, y: 400 }, "the view stays where the user has it");
  assert.equal(await zoom.showResult(["7:7"]), true, "until they ask for it");
  assert.deepEqual(v.center, { x: 3195, y: 2422 });
});
