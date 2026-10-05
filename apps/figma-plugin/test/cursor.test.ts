// The AI cursor: it goes where a session looks and works, stays "thinking" between steps, leaves when the session
// goes quiet, and never ends up in an undo step (cursors come off before every commit and go back on after).
import { after, test } from "node:test";
import assert from "node:assert/strict";

const log: string[] = [];
const made: any[] = [];
let ids = 0;
function node(type: string): any {
  const n: any = { id: `o:${++ids}`, type, x: 0, y: 0, opacity: 1, children: [] as any[], removed: false, data: {} as Record<string, string>, characters: "",
    appendChild(c: any) { this.children.push(c); c.parent = this; }, remove() { this.removed = true; log.push(`remove ${this.name ?? type}`); },
    resize() {}, rescale(s: number) { log.push(`rescale ${s}`); }, setRangeFills() {}, setPluginData(k: string, v: string) { this.data[k] = v; }, getPluginData(k: string) { return this.data[k] ?? ""; } };
  made.push(n);
  return n;
}
const page: any = { id: "0:1", type: "PAGE", children: [] as any[], selection: [] as any[], appendChild() {} };
const target = { id: "5:5", type: "FRAME", parent: page, absoluteBoundingBox: { x: 400, y: 300, width: 200, height: 100 } };
const footer = { id: "6:6", type: "FRAME", name: "Footer", parent: page, absoluteBoundingBox: { x: 100, y: 600, width: 300, height: 80 } };
const far = { id: "7:7", type: "FRAME", name: "New screen", parent: page, absoluteBoundingBox: { x: 3000, y: 2000, width: 390, height: 844 } };
(globalThis as any).figma = {
  commitUndo: () => log.push("commit"),
  loadFontAsync: async () => {},
  createFrame: () => node("FRAME"),
  createText: () => node("TEXT"),
  createEllipse: () => node("ELLIPSE"),
  createRectangle: () => node("RECTANGLE"),
  group: (nodes: any[]) => { const g = node("GROUP"); for (const n of nodes) g.appendChild(n); return g; },
  notify: () => {},
  createNodeFromSvg: () => node("FRAME"),
  getNodeByIdAsync: async (id: string) => (id === "5:5" ? { ...target, name: "Header" } : id === "6:6" ? footer : id === "7:7" ? far : null),
  currentPage: page,
  root: { children: [page] },
  viewport: { zoom: 2, center: { x: 500, y: 400 }, bounds: { x: 0, y: 0, width: 1000, height: 800 } },
};
const cursor = await import("../src/cursor.ts");
const { commitUndo } = await import("../src/undo.ts");
cursor.timing.think = 60;
cursor.timing.afterDone = 30;
cursor.timing.glide = 20;
cursor.timing.select = 20;
cursor.timing.type = 0;
cursor.timing.life = 0; // still between moves, unless a test wants it lively
cursor.timing.fade = 10;
after(() => cursor.cursorsClear()); // a failed test must not leave the ticker running (the run would never end)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cursors = () => made.filter((n) => n.name?.includes("(Layerwright cursor)"));
const live = () => cursors().filter((n) => !n.removed);
const labelOf = () => made.filter((n) => n.type === "TEXT" && n.parent?.name === "Name" && !n.parent?.parent?.removed).at(-1)?.characters as string;
const A = { id: "s1", name: "Checkout", color: "#0d99ff" };

test("where the cursor goes: what an edit touches, what an inspect or a picture looks at; where a build lands", () => {
  assert.deepEqual(cursor.cursorTargets("editNodes", { ops: [{ op: "rename", node: "1:1" }, { op: "rename", node: "$0" }, { op: "group", nodes: ["1:2"] }] }), ["1:1", "1:2"]);
  assert.deepEqual(cursor.cursorTargets("inspect", { target: "3:3" }), ["3:3"]);
  assert.deepEqual(cursor.cursorTargets("inspect", { target: "selection" }), []);
  assert.deepEqual(cursor.cursorTargets("exportImage", { nodeId: "4:4" }), ["4:4"]);
  assert.equal(cursor.landingOf("executePlan", { createdRootIds: ["7:1"] }), "7:1");
  assert.equal(cursor.landingOf("importTree", { sectionId: "8:1" }), "8:1");
});

test("a change: the cursor comes and outlines the layer; the commit waits until the cursor is off; then it thinks, then leaves", async () => {
  log.length = 0;
  made.length = 0;
  await cursor.cursorBegin(A, "editNodes", { ops: [{ op: "rename", node: "5:5", name: "Top bar" }] });
  const root = live()[0];
  assert.ok(root && cursor.isOverlay(root) && root.locked, "a locked, tagged cursor");
  assert.ok(Math.abs(root.x - 600) < 1 && Math.abs(root.y - 400) < 1, `dragged across the layer to its far corner (${root.x}, ${root.y})`);
  assert.ok(log.includes("rescale 0.5"), "half size at 200% zoom: the same size on screen");
  assert.equal(labelOf(), "Checkout  ·  renaming “Header” → “Top bar”");
  const box = made.find((n) => n.name === "Checkout is here (Layerwright)");
  assert.ok(box, "the layer is outlined in the session's colour");
  assert.equal(box.children.filter((h: any) => h.name === "Handle").length, 4, "with Figma's corner handles");
  commitUndo(); // what the handler does at its end
  assert.ok(!log.includes("commit"), "held while the cursor is on the canvas");
  await cursor.cursorEnd(A, "editNodes", { applied: [{ nodeId: "5:5" }] }, true, { ops: [{ op: "rename", node: "5:5", name: "Top bar" }] });
  const c = log.indexOf("commit");
  assert.ok(c > log.findIndex((l) => l.startsWith("remove ✦ Checkout")), "the cursor came off before the commit");
  assert.ok(made.filter((n) => n.name?.includes("is here")).every((n) => n.removed), "outlines too");
  assert.equal(live().length, 1, "and is back on after it");
  assert.match(labelOf(), /thinking/);
  await sleep(120);
  assert.equal(live().length, 0, "quiet for a while: it leaves");
  assert.equal(log.filter((l) => l === "commit").length, 1, "leaving commits nothing of its own");
});

test("looking (inspect) brings the cursor without any commit; a request from the window keeps it until it's done", async () => {
  log.length = 0;
  made.length = 0;
  await cursor.cursorBegin(A, "inspect", { target: "5:5" });
  await sleep(40);
  assert.equal(labelOf(), "Checkout  ·  reading “Header”");
  await cursor.cursorEnd(A, "inspect", {}, true);
  await cursor.cursorBusy(A, true, ["5:5"], "component");
  assert.equal(labelOf(), "Checkout  ·  on it: making a component");
  await sleep(120);
  assert.equal(live().length, 1, "busy: it doesn't leave after the usual pause");
  await cursor.cursorBusy(A, false);
  await sleep(80);
  assert.equal(live().length, 0);
  assert.ok(!log.includes("commit"));
});

test("two sessions: a commit takes both cursors off and puts both back; switched off, nothing is drawn; leftovers go", async () => {
  log.length = 0;
  made.length = 0;
  const B = { id: "s2", name: "Admin", color: "#14ae5c" };
  await cursor.cursorBegin(B, "inspect", { target: "5:5" });
  await cursor.cursorBegin(A, "executePlan", { plan: { target: { parentId: "5:5" } } });
  commitUndo();
  await cursor.cursorEnd(A, "executePlan", { createdRootIds: [] }, true);
  const c = log.indexOf("commit");
  assert.ok(log.slice(0, c).some((l) => l.startsWith("remove ✦ Admin")) && log.slice(0, c).some((l) => l.startsWith("remove ✦ Checkout")));
  assert.equal(live().length, 2);
  cursor.setCursorEnabled(false);
  assert.equal(live().length, 0);
  made.length = 0;
  await cursor.cursorBegin(A, "editNodes", {});
  assert.equal(made.length, 0);
  commitUndo();
  assert.equal(log.at(-1), "commit", "no cursors: commits go through at once");
  cursor.setCursorEnabled(true);
  const stray = node("FRAME");
  stray.setPluginData("layerwrightCursor", "1");
  const keep = node("FRAME");
  page.children = [stray, keep];
  cursor.removeLeftovers();
  assert.equal(stray.removed, true);
  assert.equal(keep.removed, false);
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

  made.length = 0;
  await cursor.cursorBegin(A, "executePlan", { plan: { roots: [{ name: "Hero" }] } });
  assert.equal(labelOf(), "Checkout  ·  building “Hero”");
  cursor.cursorProgress('Building "Hero"', 1, 4);
  assert.equal(labelOf(), "Checkout  ·  building “Hero” · 2/4", "the plugin's own progress, on the tag");
  await cursor.cursorEnd(A, "executePlan", { createdRootIds: [] }, true);
  cursor.cursorProgress("Scanning", 1, 2);
  assert.match(labelOf(), /thinking/, "no request running: progress leaves the tag alone");
  cursor.cursorsClear();
});

const at = (name: string) => live().find((n) => n.name === `✦ ${name} (Layerwright cursor)`);

test("work on several layers brings a crew: a helper in a nearby shade goes to each other layer and says what it does there", async () => {
  made.length = 0;
  cursor.timing.think = 3000;
  const ops = [{ op: "rename", node: "5:5", name: "Top" }, { op: "set", node: "6:6", text: "© 2026" }];
  await cursor.cursorBegin(A, "editNodes", { ops });
  await sleep(150);
  const helper = at("Checkout 2");
  assert.ok(helper, "a helper split off");
  assert.ok(Math.abs(helper.x - 400) < 1 && Math.abs(helper.y - 680) < 1, `it drag-selected the footer (${helper.x}, ${helper.y})`);
  assert.ok(made.some((n) => n.type === "TEXT" && n.characters === "Checkout 2  ·  typing “© 2026”"), "it says what it does there");
  assert.notEqual(cursor.shade("#0d99ff", 26), "#0d99ff");
  await cursor.cursorEnd(A, "editNodes", { applied: [{ nodeId: "5:5" }, { nodeId: "6:6" }] }, true, { ops });
  await sleep(500);
  assert.equal(at("Checkout 2"), undefined, "when the change is done, the helpers fade out and go");
  assert.ok(at("Checkout"), "the session's own cursor stays, thinking");
  cursor.timing.think = 60;
  cursor.cursorsClear();
});

test("step by step: progress moves a cursor to the layer that step works on", async () => {
  made.length = 0;
  const ops = [{ op: "rename", node: "5:5", name: "A" }, { op: "rename", node: "5:5", name: "B" }, { op: "delete", node: "6:6" }, { op: "rename", node: "5:5", name: "C" }];
  await cursor.cursorBegin({ id: "s9", name: "Solo", color: "#14ae5c" }, "editNodes", { ops });
  cursor.cursorProgress("Editing layers (delete)", 2, 4);
  await sleep(400);
  const c = at("Solo")!;
  assert.ok(c.x >= 100 && c.x <= 400 && c.y >= 600 && c.y <= 680, `on the footer for the step that deletes it (${c.x}, ${c.y})`);
  cursor.cursorsClear();
});

test("lively: a working cursor keeps moving over its layer instead of standing still", async () => {
  made.length = 0;
  cursor.timing.life = 4;
  await cursor.cursorBegin({ id: "s8", name: "Busy", color: "#e83e8c" }, "editNodes", { ops: [{ op: "rename", node: "5:5", name: "X" }] });
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) { await sleep(60); const c = at("Busy"); if (c) seen.add(`${Math.round(c.x)},${Math.round(c.y)}`); }
  cursor.timing.life = 0;
  assert.ok(seen.size >= 3, `it moved around (${seen.size} places)`);
  const c = at("Busy")!;
  assert.ok(c.x >= 400 && c.x <= 610 && c.y >= 300 && c.y <= 410, `and stayed on the layer (${c.x}, ${c.y})`);
  cursor.cursorsClear();
});

test("zoom to the result: a build always, an edit only off screen, and everything a request from the window changed when it's done", async () => {
  const zoom = await import("../src/zoom.ts");
  zoom.zoomTiming.glide = 30;
  zoom.zoomTiming.gap = 0;
  const v = (globalThis as any).figma.viewport;
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

test("working beside the user: when they work in Figma the cursors carry on at full colour; outlines are thin edges that cover nothing", async () => {
  made.length = 0;
  cursor.timing.life = 4;
  cursor.timing.think = 3000;
  await cursor.cursorBegin(A, "editNodes", { ops: [{ op: "rename", node: "5:5", name: "X" }] });
  const box = made.find((n) => n.name === "Checkout is here (Layerwright)");
  assert.equal(box.type, "GROUP", "a group: only its edges and handles can be hit, the layer under it stays clickable");
  assert.ok(box.children.every((k: any) => k.type === "RECTANGLE"), "edges and handles, no frame over the layer");
  assert.ok(cursor.isOverlayId(at("Checkout")!.id) && cursor.isOverlayId(box.children[0].id), "their own changes aren't changes to the design");
  await sleep(300);
  cursor.userActed();
  await sleep(150);
  const c = at("Checkout")!;
  const where = `${c.x},${c.y}`;
  assert.ok(c.opacity > 0.9, `full colour while the user works (${c.opacity})`);
  await sleep(200);
  assert.notEqual(`${c.x},${c.y}`, where, "and still working: it keeps moving over its layer");
  cursor.timing.life = 0;
  cursor.timing.think = 60;
  cursor.cursorsClear();
});

test("asking in the chat: the cursor comes into view, says where to answer, waves with a ? bubble; the answer ends it", async () => {
  made.length = 0;
  cursor.timing.think = 3000;
  await cursor.cursorBegin(A, "exportImage", { nodeId: "7:7" }); // it looks at a frame far off screen
  const v = (globalThis as any).figma.viewport.bounds;
  await cursor.cursorAsk(A, true, "question", "Which button style?");
  assert.equal(labelOf(), "Checkout  ·  asks you in Claude Code ↗ “Which button style?”");
  const c = at("Checkout")!;
  assert.ok(c.children.some((k: any) => k.name === "Asking"), "a ? bubble over the pointer");
  assert.ok(c.x >= v.x && c.x <= v.x + v.width && c.y >= v.y && c.y <= v.y + v.height, `it came into view (${c.x}, ${c.y})`);
  for (let i = 0; i < 30 && !made.some((n) => n.name === "Click (Layerwright)"); i++) await sleep(20);
  assert.ok(made.some((n) => n.name === "Click (Layerwright)"), "a ring pulses from it");
  await cursor.cursorAsk(A, false);
  assert.equal(labelOf(), "Checkout  ·  thanks! back to work");
  assert.ok(!c.children.some((k: any) => k.name === "Asking" && !k.removed), "the bubble goes");
  await cursor.cursorAsk(A, true, "permission");
  assert.equal(labelOf(), "Checkout  ·  needs your OK in Claude Code ↗");
  cursor.timing.think = 60;
  cursor.cursorsClear();
});

test("multitasking: each request from the window has its own cursor, and they go when their session leaves", async () => {
  made.length = 0;
  cursor.timing.think = 3000;
  const task = { id: "s1~q2", name: "Checkout · Mobile", color: cursor.shade("#0d99ff", 38) };
  await cursor.cursorBusy(task, true, ["6:6"], "mobile");
  await cursor.cursorBegin(A, "inspect", { target: "5:5" });
  assert.ok(at("Checkout · Mobile") && at("Checkout"), "two cursors, one per request");
  assert.ok(made.some((n) => n.type === "TEXT" && n.characters === "Checkout · Mobile  ·  on it: making a mobile version"));
  cursor.cursorGone("s1");
  assert.equal(at("Checkout · Mobile"), undefined, "the session left: its requests' cursors go too");
  cursor.timing.think = 60;
  cursor.cursorsClear();
});

test("zoom to the result waits while the user works: the result is held for the window to offer", async () => {
  const zoom = await import("../src/zoom.ts");
  zoom.zoomTiming.glide = 30;
  const v = (globalThis as any).figma.viewport;
  v.zoom = 2; v.center = { x: 500, y: 400 };
  cursor.userActed();
  const r = await zoom.zoomAfter("s1", "executePlan", { createdRootIds: ["7:7"] });
  assert.deepEqual(r, { shown: false, held: ["7:7"] });
  assert.deepEqual(v.center, { x: 500, y: 400 }, "the view stays where the user has it");
  assert.equal(await zoom.showResult(["7:7"]), true, "until they ask for it");
  assert.deepEqual(v.center, { x: 3195, y: 2422 });
});
