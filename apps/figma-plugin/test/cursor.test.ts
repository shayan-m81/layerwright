// The AI cursor, on the strict mock: it exists only while a request changes the canvas. It goes where the change
// works (the work doesn't wait for it), is erased before the request's undo step closes, leaves nothing behind (no
// layers, no timers), and comes back where it was for the next request. Reads draw nothing.
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
cursor.timing.glide = 20;
cursor.timing.select = 20;
cursor.timing.type = 0;
cursor.timing.life = 0; // still between moves, unless a test wants it lively
cursor.timing.end = 60;
beforeEach(world);
after(() => cursor.cursorsClear()); // a failed test must not leave a run going

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every overlay in the file: the top level of each page. */
const overlays = () => (F()?.root.children ?? []).flatMap((p: any) => p.children).filter((n: any) => cursor.isOverlay(n));
const cursors = () => overlays().filter((n: any) => n.name.includes("(Layerwright cursor)"));
const at = (name: string) => cursors().find((n: any) => n.name === `✦ ${name} (Layerwright cursor)`);
const labelOf = (name = "Checkout") => at(name)?.findAll((n: any) => n.type === "TEXT")[0]?.characters as string | undefined;
const A = { id: "s1", name: "Checkout", color: "#0d99ff" };
const RENAME = { ops: [{ op: "rename", node: "5:5", name: "Top bar" }] };
/** A request that changes the canvas, the way code.ts runs it: undo step open, cursor, the work, cursor end, step closes. */
async function change(who: typeof A, method: string, params: unknown, work: () => Promise<unknown> | unknown = () => undo.commitUndo(), result: unknown = {}) {
  undo.holdUndo();
  try {
    cursor.cursorBegin(who, method, params);
    await work();
    await cursor.cursorEnd(true, method, result, params);
  } finally { cursor.cursorsClear(); undo.releaseUndo(); }
}

test("where the cursor goes: what an edit touches, what an inspect or a picture looks at; where a build lands", () => {
  assert.deepEqual(cursor.cursorTargets("editNodes", { ops: [{ op: "rename", node: "1:1" }, { op: "rename", node: "$0" }, { op: "group", nodes: ["1:2"] }] }), ["1:1", "1:2"]);
  assert.deepEqual(cursor.cursorTargets("inspect", { target: "3:3" }), ["3:3"]);
  assert.deepEqual(cursor.cursorTargets("inspect", { target: "selection" }), []);
  assert.deepEqual(cursor.cursorTargets("exportImage", { nodeId: "4:4" }), ["4:4"]);
  assert.equal(cursor.landingOf("executePlan", { createdRootIds: ["7:1"] }), "7:1");
  assert.equal(cursor.landingOf("importTree", { sectionId: "8:1" }), "8:1");
});

test("a change: the cursor comes and drag-selects the layer while the work runs; it is erased before the step closes, and nothing is left", async () => {
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
  const box = overlays().find((n: any) => n.name === "Checkout is here (Layerwright)");
  assert.equal(box?.type, "GROUP", "the layer is outlined: a group of thin edges, so the layer under it stays clickable");
  assert.equal(box.children.filter((h: any) => h.name === "Handle").length, 4, "with Figma's corner handles");
  undo.commitUndo(); // what the handler does at its end
  assert.deepEqual(commits, [], "held while the request runs");
  const t0 = Date.now();
  await cursor.cursorEnd(true, "editNodes", { applied: [{ nodeId: "5:5" }] }, RENAME);
  assert.ok(Date.now() - t0 < cursor.timing.end + 40, `the ending is short (${Date.now() - t0} ms)`);
  assert.equal(overlays().length, 0, "everything it drew is erased");
  undo.releaseUndo();
  assert.deepEqual(commits, [0], "one commit, with no overlay in the file");
  await sleep(40);
  assert.deepEqual(pendingTimers(), [], "and nothing keeps running");
});

test("the work never waits for the cursor: it starts at once, and a quick request ends the cursor before it was even drawn", async () => {
  const order: string[] = [];
  await change(A, "editNodes", RENAME, () => { order.push(`work with ${overlays().length} overlays`); undo.commitUndo(); });
  assert.deepEqual(order, ["work with 0 overlays"], "the handler ran before the cursor was drawn");
  assert.equal(overlays().length, 0);
  assert.deepEqual(commits, [0]);
  await sleep(60);
  assert.equal(overlays().length, 0, "the cursor's setup, finishing late, draws nothing after the request");
  assert.deepEqual(pendingTimers(), []);
});

test("reads draw nothing: inspect, pictures, scans, selecting", async () => {
  const before = nodes.size;
  for (const m of ["inspect", "exportImage", "scanDesignSystem", "select", "ping", "ensurePages"]) cursor.cursorBegin(A, m, { target: "5:5", nodeId: "5:5", nodeIds: ["5:5"] });
  await sleep(80);
  for (const m of ["inspect", "exportImage"]) await cursor.cursorEnd(true, m, {});
  assert.equal(nodes.size, before, "not a single node was created");
  assert.deepEqual(pendingTimers(), []);
});

test("two changes back to back are two undo steps, each without the cursor", async () => {
  await change(A, "editNodes", RENAME, async () => { await sleep(80); undo.commitUndo(); });
  await change(A, "editNodes", { ops: [{ op: "rename", node: "6:6", name: "Bottom" }] }, async () => { await sleep(80); undo.commitUndo(); });
  assert.deepEqual(commits, [0, 0]);
});

test("a failed change commits nothing of its own, and still leaves no cursor", async () => {
  undo.holdUndo();
  cursor.cursorBegin(A, "editNodes", RENAME);
  await sleep(60);
  assert.ok(at("Checkout"));
  await cursor.cursorEnd(false, "editNodes");
  undo.releaseUndo();
  assert.equal(overlays().length, 0);
  assert.deepEqual(commits, [], "no step: the handler asked for none");
});

test("the next request's cursor comes back where the last one was, without fading in again", async () => {
  await change(A, "editNodes", RENAME, () => sleep(100));
  undo.holdUndo();
  cursor.cursorBegin(A, "editNodes", { ops: [{ op: "rename", node: "6:6", name: "Bottom" }] });
  await sleep(5);
  const c = at("Checkout");
  assert.ok(c && Math.abs(c.x - 600) < 1 && Math.abs(c.y - 400) < 1, `it starts where the last one ended (${c?.x}, ${c?.y})`);
  assert.equal(c.opacity, 1);
  cursor.cursorsClear(); undo.releaseUndo();
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
  cursor.cursorsClear(); undo.releaseUndo();
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
  const ending = cursor.cursorEnd(true, "executePlan", { createdRootIds: ["7:7"] });
  assert.equal(labelOf(), "Checkout  ·  built 1 frame ✓", "what it did, for the moment before it goes");
  await ending;
  cursor.cursorProgress("Scanning", 1, 2);
  assert.equal(overlays().length, 0, "no request running: progress draws nothing");
  undo.releaseUndo();
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
  await cursor.cursorEnd(true, "editNodes", { applied: [{ nodeId: "5:5" }, { nodeId: "6:6" }] }, { ops });
  undo.releaseUndo();
  assert.equal(overlays().length, 0, "the crew goes with the request");
});

test("step by step: progress moves a cursor to the layer that step works on", async () => {
  const ops = [{ op: "rename", node: "5:5", name: "A" }, { op: "rename", node: "5:5", name: "B" }, { op: "delete", node: "6:6" }, { op: "rename", node: "5:5", name: "C" }];
  undo.holdUndo();
  cursor.cursorBegin({ id: "s9", name: "Solo", color: "#14ae5c" }, "editNodes", { ops });
  await sleep(100);
  cursor.cursorProgress("Editing layers (delete)", 2, 4);
  await sleep(400);
  const c = at("Solo")!;
  assert.ok(c.x >= 100 && c.x <= 400 && c.y >= 600 && c.y <= 680, `on the footer for the step that deletes it (${c.x}, ${c.y})`);
  cursor.cursorsClear(); undo.releaseUndo();
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
  cursor.cursorsClear(); undo.releaseUndo();
  await sleep(60);
  assert.deepEqual(pendingTimers(), []);
});

test("the request opens another page: the cursor goes along", async () => {
  undo.holdUndo();
  cursor.cursorBegin(A, "editNodes", RENAME);
  await sleep(60);
  const other = F().root.children[1];
  await own.openPage(other);
  await sleep(60);
  assert.equal(at("Checkout")?.parent, other);
  cursor.cursorsClear(); undo.releaseUndo();
  assert.equal(overlays().length, 0);
});

test("leftovers: this user's (a window that closed mid-request), an older version's and stale ones go; another user's live cursor stays", () => {
  const left = (data: string) => { const f = F().createFrame(); f.setPluginData("layerwrightCursor", data); return f; };
  const mine = left(JSON.stringify({ user: "u:1", at: Date.now() }));
  const theirs = left(JSON.stringify({ user: "u:2", at: Date.now() - 60_000 }));
  const stale = left(JSON.stringify({ user: "u:2", at: Date.now() - 31 * 60_000 }));
  const legacy = left("1");
  const keep = F().createFrame();
  assert.equal(cursor.removeLeftovers(), 3);
  assert.deepEqual([mine.removed, theirs.removed, stale.removed, legacy.removed, keep.removed], [true, false, true, true, false]);
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
