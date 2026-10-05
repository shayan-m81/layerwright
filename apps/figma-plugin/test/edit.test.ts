// figma_edit ops, componentize, real sections and page targeting, on the strict mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePlan, validatePlan, emptyDesignSystem } from "@cde/core";
import { resetFigma, loaded } from "./figma-mock.ts";

const { editNodes, cleanup } = await import("../src/edit.ts");
const { executePlan } = await import("../src/execute.ts");
const F = () => (globalThis as any).figma;

/** A page with a board frame holding `n` accordion-like frames (title text inside). */
function board(n: number) {
  const page = resetFigma();
  loaded.add("Inter::Regular");
  const b = F().createFrame(); b.name = "Board"; b.layoutMode = "VERTICAL"; page.appendChild(b);
  const items = Array.from({ length: n }, (_, i) => {
    const f = F().createFrame(); f.name = `Accordion ${i + 1}`; f.width = 320; f.height = 60; b.appendChild(f);
    const t = F().createText(); t.name = "Title"; t.characters = `Step ${i + 1}`; f.appendChild(t);
    return f;
  });
  return { page, board: b, items };
}

test("componentize → variants works on copies next to the board, and exposes text as a property", async () => {
  const { page, board: b, items } = board(3);
  const r = await editNodes({ ops: [{ op: "componentize", nodes: items.map((i) => i.id), name: "Accordion", exposeText: ["Title"],
    variants: [{ State: "Collapsed", Step: "Evidence" }, { State: "Expanded", Step: "Evidence" }, { State: "Paused", Step: "Final" }] }], meta: { session: "s1", run: "s1.1" } });
  assert.equal(r.failed, undefined);
  const set = page.children.find((c: any) => c.type === "COMPONENT_SET");
  assert.ok(set, "set is on the page, not inside the Auto Layout board");
  assert.equal(set.name, "Accordion");
  assert.deepEqual(set.children.map((c: any) => c.name), ["State=Collapsed, Step=Evidence", "State=Expanded, Step=Evidence", "State=Paused, Step=Final"]);
  assert.ok(set.x >= b.x + b.width, "placed to the right of the originals");
  assert.equal(b.children.length, 3, "originals untouched");
  assert.ok(b.children.every((c: any) => c.type === "FRAME"));
  const key = Object.keys(set.componentPropertyDefinitions)[0];
  assert.match(key, /^Title#/);
  assert.ok(set.children.every((c: any) => c.children[0].componentPropertyReferences.characters === key));
  assert.equal(JSON.parse(set.getPluginData("layerwright")).session, "s1");
});

test("componentize rejects duplicate variant combinations before changing anything", async () => {
  const { page, items } = board(2);
  const r = await editNodes({ ops: [{ op: "componentize", nodes: items.map((i) => i.id), variants: [{ State: "A" }, { State: "A" }] }] });
  assert.match(r.failed!.error, /both be the variant/);
  assert.ok(!page.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] }).length);
});

test("rename, duplicate with $ref, move to another page, set text, soft delete without approval", async () => {
  const { items } = board(2);
  const r = await editNodes({ ops: [
    { op: "rename", node: items[0].id, name: "Old Accordion" },
    { op: "duplicate", node: items[1].id, name: "Copy" },
    { op: "move", node: "$1", page: "Playground", x: 10, y: 20 },
    { op: "set", node: items[1].children[0].id, text: "Renamed step" },
    { op: "delete", node: items[0].id },
  ] });
  assert.equal(r.failed, undefined);
  assert.equal(items[1].children[0].characters, "Renamed step");
  const copy = F().root.children[1].children[0];
  assert.deepEqual([copy.name, copy.x, copy.y], ["Copy", 10, 20]);
  assert.equal(items[0].visible, false);
  assert.equal(items[0].name, "🗑 Old Accordion");
  assert.equal(items[0].removed, false);
});

test("a top-level section is a real SectionNode sized to its screens; adding to it later grows it", async () => {
  resetFigma();
  const plan = (p: object) => { const v = validatePlan(p); assert.ok(v.success, JSON.stringify(!v.success && v.errors)); const c = compilePlan(emptyDesignSystem(), v.plan); assert.deepEqual(c.errors, []); return c.plan!; };
  const r = await executePlan(plan({ name: "s", screens: [{ type: "section", name: "Flow", children: [{ type: "screen", name: "A", height: 400 }, { type: "screen", name: "B", height: 400 }] }] }));
  const section = F().currentPage.children[0];
  assert.equal(section.type, "SECTION");
  assert.deepEqual(section.children.map((c: any) => [c.name, c.x, c.y]), [["A", 80, 80], ["B", 550, 80]]);
  assert.deepEqual([section.width, section.height], [1020, 560]);
  await executePlan(plan({ name: "more", target: { parentId: r.createdRootIds[0], x: 1100, y: 80 }, screens: [{ type: "screen", name: "C", height: 900 }] }));
  assert.deepEqual([section.width, section.height], [1570, 1060]);
});

test("target.page builds on that page and switches to it", async () => {
  resetFigma();
  const v = validatePlan({ name: "p", target: { page: "Playground" }, screens: [{ type: "screen", name: "Here" }] });
  assert.ok(v.success);
  const r = await executePlan(compilePlan(emptyDesignSystem(), v.plan).plan!);
  assert.equal(r.page!.name, "Playground");
  assert.equal(F().root.children[1].children[0].name, "Here");
  assert.equal(F().root.children[0].children.length, 0);
});

test("cleanup lists a session's nodes and removes them only with approval", async () => {
  const { items } = board(1);
  await editNodes({ ops: [{ op: "duplicate", node: items[0].id }], meta: { session: "s9", run: "s9.1" } });
  const listed = await cleanup({ session: "s9" });
  assert.equal(listed.nodes.length, 1);
  assert.equal(listed.removed, false);
  const gone = await cleanup({ session: "s9", approved: true });
  assert.equal(gone.removed, true);
  assert.equal((await cleanup({ session: "s9" })).nodes.length, 0);
});

test("cleanup also finds AI cursors a closed window left behind (not another user's live one); the design-system scan doesn't walk them", async () => {
  const page = resetFigma();
  const left = F().createFrame(); left.name = "✦ Claude (Layerwright cursor)";
  left.setPluginData("layerwrightCursor", JSON.stringify({ user: "u:1", at: Date.now() })); // this user's
  const live = F().createFrame();
  live.setPluginData("layerwrightCursor", JSON.stringify({ user: "u:2", at: Date.now() })); // someone else's, drawing now
  const listed = await cleanup({});
  assert.deepEqual(listed.nodes.map((n: any) => n.name), ["✦ Claude (Layerwright cursor)"]);
  await cleanup({ approved: true });
  assert.equal(left.removed, true);
  assert.equal(live.removed, false);
  const tag = F().createText(); tag.textStyleId = "S:in-a-cursor"; live.appendChild(tag);
  const asked: string[] = [];
  const get = F().getStyleByIdAsync;
  F().getStyleByIdAsync = async (id: string) => { asked.push(id); return get(id); };
  const { scanDesignSystem } = await import("../src/scan.ts");
  await scanDesignSystem({});
  assert.ok(!asked.includes("S:in-a-cursor"), "the cursor's text isn't read as a layer of the design");
  assert.ok(page.children.includes(live));
});

test("componentize gives cleanly stacked absolute layers Auto Layout; text fills the column, uneven layouts stay", async () => {
  const page = resetFigma();
  loaded.add("Inter::Regular");
  const mk = (ys: number[]) => {
    const f = F().createFrame(); f.width = 354; f.height = 120; page.appendChild(f);
    for (const [i, y] of ys.entries()) { const t = F().createText(); t.name = `T${i}`; t.characters = "x"; t.x = 17; t.y = y; t.width = 100; t.height = 18; f.appendChild(t); }
    return f;
  };
  const even = mk([17, 43, 69]), uneven = mk([17, 43, 90]);
  await editNodes({ ops: [{ op: "componentize", nodes: [even.id, uneven.id], mode: "multiple" }] });
  const [a, b] = page.children.filter((c: any) => c.type === "COMPONENT");
  assert.equal(a.layoutMode, "VERTICAL");
  assert.deepEqual([a.itemSpacing, a.paddingTop, a.paddingLeft, a.paddingRight], [8, 17, 17, 17], "right padding mirrors the left one");
  assert.ok(a.children.every((t: any) => t.textAutoResize === "HEIGHT" && t.layoutSizingHorizontal === "FILL"), "text in a column wraps inside it");
  assert.equal(b.layoutMode, "NONE", "uneven gaps keep their exact positions");
});

test("inserts fill several existing parents in one run, at the given index", async () => {
  const { board: b, items } = board(2);
  const v = validatePlan({ name: "slots", inserts: [
    { parentId: items[0].id, nodes: [{ type: "text", content: "Slot A" }] },
    { parentId: b.id, index: 0, nodes: [{ type: "frame", name: "Header", width: 320, height: 40 }] },
  ] });
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  const r = await executePlan(compilePlan(emptyDesignSystem(), v.plan).plan!);
  assert.equal(r.createdRootIds.length, 2);
  assert.equal(items[0].children.at(-1).characters, "Slot A");
  assert.equal(b.children[0].name, "Header");
});

test("prototype: interactions by plan id / screen name, transitions, scroll, flows; invalid targets are plan errors", async () => {
  resetFigma();
  loaded.add("Inter::Regular");
  const v = validatePlan({ name: "Flow", prototype: { flows: [{ name: "Checkout", start: "Cart" }] }, screens: [
    { type: "screen", name: "Cart", scroll: "vertical", children: [
      { type: "frame", id: "pay", name: "Pay", width: 200, height: 44, interactions: [{ action: "navigate", to: "Done", transition: { type: "smart-animate", duration: 400 } }] },
      { type: "frame", name: "Help", width: 44, height: 44, interactions: [{ trigger: "hover", action: "overlay", to: "tip" }] } ] },
    { type: "screen", name: "Done", interactions: [{ trigger: "after-delay", delay: 1500, action: "back" }] },
    { type: "frame", id: "tip", name: "Tip", width: 200, height: 80 },
  ] });
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  const c = compilePlan(emptyDesignSystem(), v.plan);
  assert.deepEqual(c.errors, []);
  const r = await executePlan(c.plan!);
  const page = F().currentPage;
  const [cart, done, tip] = page.children;
  const pay = cart.children[0];
  assert.deepEqual(pay.reactions[0], { trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: done.id, navigation: "NAVIGATE", transition: { type: "SMART_ANIMATE", easing: { type: "EASE_OUT" }, duration: 0.4 } }] });
  assert.equal(cart.children[1].reactions[0].actions[0].navigation, "OVERLAY");
  assert.equal(cart.children[1].reactions[0].actions[0].destinationId, tip.id);
  assert.deepEqual(done.reactions[0], { trigger: { type: "AFTER_TIMEOUT", timeout: 1.5 }, actions: [{ type: "BACK" }] });
  assert.equal(cart.overflowDirection, "VERTICAL");
  assert.deepEqual(page.flowStartingPoints, [{ nodeId: cart.id, name: "Checkout" }]);
  assert.ok(r.warnings.every((w: string) => !/interaction/.test(w)));

  const bad = validatePlan({ name: "x", screens: [{ type: "screen", name: "A", interactions: [{ action: "navigate", to: "Nope" }] }] });
  assert.ok(bad.success);
  const e = compilePlan(emptyDesignSystem(), bad.plan).errors[0];
  assert.match(e.message, /"Nope" is not a node id or screen name/);
  assert.deepEqual(e.suggestions, ["A"]);
});

test("prototype via figma_edit on existing frames: a nested frame is refused as a navigate destination; flow ops", async () => {
  const page = resetFigma();
  const a = F().createFrame(); a.name = "Home"; page.appendChild(a);
  const b = F().createFrame(); b.name = "Details"; page.appendChild(b);
  const btn = F().createFrame(); btn.name = "Open"; a.appendChild(btn);
  const r = await editNodes({ ops: [
    { op: "prototype", node: btn.id, interactions: [{ trigger: "ON_CLICK", action: "NAVIGATE", to: { nodeId: b.id }, transition: { type: "PUSH", direction: "LEFT", duration: 0.3, easing: "EASE_IN_AND_OUT" } }] },
    { op: "prototype", node: btn.id, interactions: [{ trigger: "ON_CLICK", action: "NAVIGATE", to: { nodeId: btn.id } }] },
    { op: "flow", name: "Main", start: a.id },
  ] });
  assert.equal(r.failed?.op, 1, "a nested frame can't be a navigate destination");
  assert.equal(btn.reactions[0].actions[0].transition.direction, "LEFT");
  const r2 = await editNodes({ ops: [{ op: "flow", name: "Main", start: a.id }] });
  assert.equal(r2.failed, undefined);
  assert.deepEqual(page.flowStartingPoints, [{ nodeId: a.id, name: "Main" }]);
});

test("componentize keeps a Design System instance linked: it is wrapped, not detached", async () => {
  const page = resetFigma();
  // An instance that filled its Auto Layout parent: it must keep its 300px, not collapse in the hugging wrapper.
  const col = F().createFrame(); col.layoutMode = "VERTICAL"; page.appendChild(col);
  const inst: any = new (page.constructor as any)("INSTANCE"); inst.name = "Alert"; inst.width = 300; inst.height = 100;
  inst.detachInstance = () => { throw new Error("must not detach"); };
  col.appendChild(inst); inst.layoutSizingHorizontal = "FILL";
  const r = await editNodes({ ops: [{ op: "componentize", nodes: [inst.id], name: "AI Alert", autoLayout: false }] });
  assert.equal(r.failed, undefined);
  const comp = page.children.find((c: any) => c.type === "COMPONENT");
  assert.equal(comp.children[0].type, "INSTANCE");
  assert.deepEqual([comp.width, comp.children[0].width, comp.children[0].x], [300, 300, 0]);
});

test("move with an index past the end (and no new parent) is clamped instead of failing the call", async () => {
  const { board: b, items } = board(3);
  const r = await editNodes({ ops: [{ op: "move", node: items[0].id, index: 99 }], approved: true });
  assert.equal(r.failed, undefined);
  assert.equal(b.children.at(-1).id, items[0].id);
});

test("swap keeps the instance and its overrides; annotate adds notes with a category; plan annotations are applied", async () => {
  const page = resetFigma();
  loaded.add("Inter::Regular");
  const comp = await F().getNodeByIdAsync("1:2"); // Type=Primary
  const inst = comp.createInstance(); page.appendChild(inst);
  inst.children[0].characters = "Continue";
  const r = await editNodes({ ops: [
    { op: "swap", node: inst.id, componentId: "1:3", componentName: "Button / Secondary" },
    { op: "annotate", node: inst.id, annotations: [{ label: "Uses **Button/Secondary**", properties: ["padding", "fills"], category: "Development" }] },
    { op: "annotate", node: inst.id, annotations: [{ label: "Second note", category: "Development" }] },
  ], approved: true });
  assert.equal(r.failed, undefined);
  assert.equal(inst.mainComponent.id, "1:3");
  assert.equal(inst.children[0].characters, "Continue", "override kept");
  assert.equal(inst.annotations.length, 2);
  assert.deepEqual(inst.annotations[0], { labelMarkdown: "Uses **Button/Secondary**", properties: [{ type: "padding" }, { type: "fills" }], categoryId: "cat1" });
  assert.equal(inst.annotations[1].categoryId, "cat1", "the category is reused, not duplicated");
  const frame = F().createFrame(); page.appendChild(frame);
  const bad = await editNodes({ ops: [{ op: "swap", node: frame.id, componentId: "1:3" }], approved: true });
  assert.match(bad.failed!.error, /not an instance/);

  resetFigma();
  const v = validatePlan({ name: "n", screens: [{ type: "frame", name: "Card", annotations: [{ label: "Spacing: **spacing/md**", properties: ["itemSpacing"] }] }] });
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  await executePlan(compilePlan(emptyDesignSystem(), v.plan).plan!);
  assert.deepEqual(F().currentPage.children[0].annotations, [{ labelMarkdown: "Spacing: **spacing/md**", properties: [{ type: "itemSpacing" }] }]);
});

test("foundations: colour styles (hex with alpha, bound to a variable, gradient), effect and grid styles, upserted by name", async () => {
  resetFigma();
  const { foundations } = await import("../src/import.ts");
  const r = await foundations({ collection: "Tokens", colors: { "color/overlay": "#00000080", "color/brand": "#7C3AED" },
    paintStyles: [{ name: "Brand", variable: "color/brand" }, { name: "Scrim", color: "#0000004D" }, { name: "Hero", gradient: { angle: 90, stops: [{ color: "#7C3AED", position: 0 }, { color: "#176B66", position: 1 }] } }],
    effectStyles: [{ name: "Card", shadows: [{ y: 4, blur: 12, color: "#0000001A" }] }, { name: "Frost", blur: { type: "background", radius: 20 } }],
    gridStyles: [{ name: "Desktop 12", columns: { count: 12, gutter: 24, margin: 80 } }] });
  assert.deepEqual([r.colors, r.paintStyles, r.effectStyles, r.gridStyles, r.warnings], [2, 3, 2, 1, []]);
  const made = await F().variables.getLocalVariablesAsync();
  assert.equal(made.find((v: any) => v.name === "color/overlay").values.m1.a.toFixed(2), "0.50", "alpha is kept");
  const paint = await F().getLocalPaintStylesAsync();
  assert.equal(paint[0].paints[0].boundVariables.color.id, made.find((v: any) => v.name === "color/brand").id);
  assert.equal(paint[1].paints[0].opacity.toFixed(2), "0.30");
  assert.equal(paint[2].paints[0].type, "GRADIENT_LINEAR");
  const fx = await F().getLocalEffectStylesAsync();
  assert.deepEqual([fx[0].effects[0].type, fx[1].effects[0].type], ["DROP_SHADOW", "BACKGROUND_BLUR"]);
  const grid = (await F().getLocalGridStylesAsync())[0].layoutGrids[0];
  assert.deepEqual([grid.pattern, grid.count, grid.gutterSize, grid.offset], ["COLUMNS", 12, 24, 80]);
  await foundations({ paintStyles: [{ name: "Scrim", color: "#00000066" }] });
  assert.equal((await F().getLocalPaintStylesAsync()).length, 3, "same name updates, doesn't duplicate");
});

test("bind a variable to fills, padding and radius; apply fill and text styles", async () => {
  const page = resetFigma();
  loaded.add("Inter::Regular"); loaded.add("Inter::Bold");
  const f = F().createFrame(); f.layoutMode = "VERTICAL"; page.appendChild(f);
  const t = F().createText(); t.characters = "Hi"; f.appendChild(t);
  const r = await editNodes({ approved: true, ops: [
    { op: "bind", node: f.id, field: "fills", variableId: "v5" },
    { op: "bind", node: f.id, field: "padding", variableId: "v2" },
    { op: "bind", node: f.id, field: "cornerRadius", variableId: "v4" },
    { op: "style", node: t.id, kind: "text", styleId: "S:h1" },
  ] });
  assert.equal(r.failed, undefined);
  assert.equal(f.fills[0].boundVariables.color.id, "v5");
  assert.deepEqual(["paddingTop", "paddingLeft", "topLeftRadius"].map((k) => f.boundVariables[k]?.id), ["v2", "v2", "v4"]);
  assert.equal(t.textStyleId, "S:h1");
  const bad = await editNodes({ approved: true, ops: [{ op: "style", node: f.id, kind: "text", styleId: "S:h1" }] });
  assert.match(bad.failed!.error, /needs a text layer/);
});

test("group, boolean (subtract) and ungroup keep layer order; boolean refuses a frame; ops chain with $n", async () => {
  const page = resetFigma();
  const host = F().createFrame(); host.name = "Host"; page.appendChild(host);
  const bg = F().createRectangle(); bg.name = "BG"; host.appendChild(bg);
  const a = F().createEllipse(); a.name = "A"; a.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }]; host.appendChild(a);
  const b = F().createRectangle(); b.name = "B"; host.appendChild(b);
  const res = await editNodes({ approved: true, ops: [
    { op: "boolean", nodes: [b.id, a.id], operation: "subtract", name: "Cut" },
    { op: "group", nodes: [bg.id, "$0"], name: "Icon" },
    { op: "ungroup", node: "$1" },
  ] });
  assert.equal(res.failed, undefined, JSON.stringify(res.failed));
  assert.deepEqual(host.children.map((c: any) => c.name), ["BG", "Cut"]);
  const cut = host.children[1];
  assert.deepEqual([cut.type, cut.booleanOperation, cut.children.map((c: any) => c.name)], ["BOOLEAN_OPERATION", "SUBTRACT", ["A", "B"]]);
  assert.deepEqual(cut.fills[0].color, { r: 0, g: 0, b: 1 }, "the base layer's fill, not Figma's default grey");
  assert.deepEqual(res.applied[2].nodeIds, [bg.id, cut.id]);
  const back = await editNodes({ approved: true, ops: [{ op: "ungroup", node: cut.id }] });
  assert.deepEqual(back.applied[0].nodeIds, [a.id, b.id], "ungrouping a boolean gives the shapes back");
  const frame = F().createFrame(); host.appendChild(frame);
  const bad = await editNodes({ approved: true, ops: [{ op: "boolean", nodes: [frame.id, bg.id], operation: "union" }] });
  assert.match(bad.failed!.error, /FRAME can't be used/);
  const other = F().createFrame(); page.appendChild(other);
  const apart = await editNodes({ approved: true, ops: [{ op: "group", nodes: [bg.id, other.id] }] });
  assert.match(apart.failed!.error, /same parent/);
});

test("set changes a text's weight, size, family and colour, and a frame's background, with the fonts loaded first (one undo step)", async () => {
  const { items } = board(1);
  const frame = items[0], title = frame.children[0];
  loaded.clear(); // nothing loaded yet: set must load what it uses (the strict mock refuses otherwise)
  let r = await editNodes({ ops: [{ op: "set", node: title.id, weight: "semibold", fontSize: 18, fill: "#1a7f37" }, { op: "set", node: frame.id, fill: "#dff5e1" }], approved: true });
  assert.equal(r.failed, undefined, JSON.stringify(r.failed));
  assert.deepEqual(title.fontName, { family: "Inter", style: "Semi Bold" });
  assert.equal(title.fontSize, 18);
  assert.equal(title.fills[0].type, "SOLID");
  assert.ok(Math.abs(title.fills[0].color.g - 0x7f / 255) < 1e-6);
  assert.ok(Math.abs(frame.fills[0].color.r - 0xdf / 255) < 1e-6, "the frame's background");
  assert.match(r.applied[0].note ?? "", /font Inter Semi Bold/, "the agent learns which style was used");
  // The closest style a family has: Vazirmatn writes "SemiBold"; 800 has no exact match there, so Bold.
  r = await editNodes({ ops: [{ op: "set", node: title.id, fontFamily: "vazirmatn", weight: "extrabold" }], approved: true });
  assert.equal(r.failed, undefined, JSON.stringify(r.failed));
  assert.deepEqual(title.fontName, { family: "Vazirmatn", style: "Bold" });
  r = await editNodes({ ops: [{ op: "set", node: title.id, fontFamily: "Inter", italic: true }], approved: true });
  assert.deepEqual(title.fontName, { family: "Inter", style: "Italic" }, "upright Bold has no italic here: the closest italic");
  // Clear errors, nothing half-done.
  r = await editNodes({ ops: [{ op: "set", node: title.id, fontFamily: "Comic Neue", weight: "bold" }], approved: true });
  assert.match(r.failed!.error, /"Comic Neue" isn't available/);
  r = await editNodes({ ops: [{ op: "set", node: frame.id, weight: "bold" }], approved: true });
  assert.match(r.failed!.error, /need a text layer/);
});
