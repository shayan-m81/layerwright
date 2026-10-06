// Issue #8, on the strict mock: a design made in Figma → figma_inspect format "plan" (snapshot + export) → preview
// (validate + compile, no Design System scan) → execute builds the same structure: grid placement, a pill's radius,
// image fills by hash, mixed-colour text, a wrapping row's row gap and an absolute child of Auto Layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePlan, emptyDesignSystem, snapshotToPlan, validatePlan } from "@cde/core";
import { resetFigma } from "./figma-mock.ts";

const { executePlan } = await import("../src/execute.ts");
const { snapshot } = await import("../src/scan.ts");

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
const solid = (r: number, g: number, b: number) => ({ type: "SOLID", color: { r, g, b } });
const fig = () => (globalThis as any).figma;

/** A desktop section as a designer made it, through the Plugin API (the mock enforces the API's rules). */
async function designed() {
  resetFigma();
  const figma = fig();
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Bold" });
  const img = figma.createImage(PNG);
  const frame = (name: string, parent: any, w: number, h: number) => { const f = figma.createFrame(); parent?.appendChild(f); f.name = name; f.resize(w, h); return f; };

  const root = frame("Desktop", undefined, 1200, 900);
  root.layoutMode = "VERTICAL"; root.itemSpacing = 24;
  // A grid: its cells sit where the grid puts them.
  const grid = frame("Gallery", root, 1200, 400);
  grid.layoutMode = "GRID";
  for (const [i, [x, y]] of [[0, 0], [408, 0], [0, 208]].entries()) { const c = frame(`Cell ${i + 1}`, grid, 392, 192); c.x = x; c.y = y; }
  // A photo: an image fill, by the file's own hash.
  const hero = figma.createRectangle(); root.appendChild(hero); hero.name = "Hero photo"; hero.resize(1200, 300);
  hero.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" }];
  // A pill: Figma reports its "full" radius as 33554400.
  const pill = frame("Pill", root, 96, 32); pill.cornerRadius = 33554400; pill.fills = [solid(0.09, 0.42, 0.4)];
  // A badge taken out of the flow.
  const badge = frame("Badge", root, 40, 40); badge.layoutPositioning = "ABSOLUTE"; badge.x = 1140; badge.y = 20;
  // Tags that wrap, with a row gap of their own.
  const tags = frame("Tags", root, 600, 80);
  tags.layoutMode = "HORIZONTAL"; tags.layoutWrap = "WRAP"; tags.itemSpacing = 8; tags.counterAxisSpacing = 12;
  for (const name of ["New", "Sale", "Popular"]) frame(name, tags, 80, 28);
  // A price whose last word is bold and red.
  const price = figma.createText(); root.appendChild(price); price.name = "Price";
  price.characters = "Now only $9"; price.fills = [solid(0.06, 0.09, 0.16)]; price.textAutoResize = "WIDTH_AND_HEIGHT";
  price.setRangeFontName(9, 11, { family: "Inter", style: "Bold" }); price.setRangeFills(9, 11, [solid(0.85, 0.18, 0.13)]);
  return { root, img };
}

/** figma_inspect({ format: "plan", values: "raw" }) without a Design System scan, then figma_preview_plan. */
async function exportAndCompile(node: any) {
  const { plan, warnings } = snapshotToPlan(await snapshot(node, { depth: 20, maxNodes: 5000, expandInstances: true, plan: true }), undefined, { values: "raw" });
  const v = validatePlan(JSON.parse(JSON.stringify(plan)));
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  const c = compilePlan(emptyDesignSystem(), v.plan);
  assert.deepEqual(c.errors, []);
  return { plan, warnings, resolved: c.plan! };
}

test("round trip: a frame exported as a plan rebuilds with the same structure, and exports to the same plan again", async () => {
  const { root, img } = await designed();
  const first = await exportAndCompile(root);
  assert.ok(first.warnings.some((w) => /"Gallery" uses a grid layout/.test(w)));
  const report = await executePlan(first.resolved);
  const rebuilt = await fig().getNodeByIdAsync(report.createdRootIds[0]);
  const [grid, hero, pill, badge, tags, price] = rebuilt.children;

  assert.deepEqual(grid.children.map((c: any) => [c.name, c.x, c.y, c.width]), [["Cell 1", 0, 0, 392], ["Cell 2", 408, 0, 392], ["Cell 3", 0, 208, 392]]);
  assert.deepEqual(hero.fills, [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" }], "the same image, nothing uploaded");
  assert.equal(pill.cornerRadius, 9999);
  assert.deepEqual([badge.layoutPositioning, badge.x, badge.y], ["ABSOLUTE", 1140, 20]);
  assert.deepEqual([tags.layoutWrap, tags.itemSpacing, tags.counterAxisSpacing], ["WRAP", 8, 12]);
  const segs = price.getStyledTextSegments(["fontName", "fills"]).map((s: any) => [s.characters, s.fontName.style, Math.round(s.fills[0].color.r * 100)]);
  assert.deepEqual(segs, [["Now only ", "Regular", 6], ["$9", "Bold", 85]]);
  assert.deepEqual(report.warnings, []);

  // The rebuild exports to the same plan as the original: nothing more was lost on the way.
  const second = await exportAndCompile(rebuilt);
  assert.deepEqual(second.plan.screens, first.plan.screens);
});

test("an image hash this file doesn't have leaves the image out with a warning, and never fails the build", async () => {
  resetFigma();
  const v = validatePlan({ name: "x", screens: [{ type: "frame", name: "Card", width: 200, height: 100, fill: "#FFFFFF", image: { hash: "not-in-this-file" }, children: [
    { type: "image", name: "Photo", imageHash: "not-in-this-file", width: 50, height: 50 },
    { type: "shape", shape: "ellipse", name: "Dot", image: { hash: "not-in-this-file", fit: "fit" } },
  ] }] });
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  const report = await executePlan(compilePlan(emptyDesignSystem(), v.plan).plan!);
  const card = await fig().getNodeByIdAsync(report.createdRootIds[0]);
  assert.deepEqual(card.fills.map((p: any) => p.type), ["SOLID"]);
  assert.deepEqual(card.children[0].fills.map((p: any) => p.type), ["SOLID"], "the photo keeps its placeholder");
  assert.deepEqual(card.children[1].fills, [], "the dot has no grey placeholder under an image");
  assert.equal(report.warnings.filter((w) => /no image with hash not-in-this-file/.test(w)).length, 3);
});

test("an image node paints an image of this file by hash with its fit", async () => {
  resetFigma();
  const img = fig().createImage(PNG);
  const v = validatePlan({ name: "x", screens: [{ type: "image", name: "Logo", imageHash: img.hash, fit: "fit", width: 64, height: 64 }] });
  assert.ok(v.success);
  const report = await executePlan(compilePlan(emptyDesignSystem(), v.plan).plan!);
  const logo = await fig().getNodeByIdAsync(report.createdRootIds[0]);
  assert.deepEqual(logo.fills, [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FIT" }]);
});

test("the mock enforces Figma's wrap rules, and a counterGap the layout can't use never reaches Figma", async () => {
  resetFigma();
  const f = fig().createFrame();
  f.layoutMode = "VERTICAL";
  assert.throws(() => { f.layoutWrap = "WRAP"; }, /only be set on layers with layoutMode HORIZONTAL/);
  f.layoutMode = "HORIZONTAL";
  assert.throws(() => { f.counterAxisSpacing = 10; }, /layoutWrap WRAP/);
  f.layoutWrap = "WRAP";
  assert.throws(() => { f.counterAxisSpacing = -1; }, /must be positive/);
  f.itemSpacing = 6; f.counterAxisSpacing = null;
  assert.equal(f.counterAxisSpacing, 6, "null follows itemSpacing");
  assert.equal(fig().getImageByHash("nope"), null);

  const v = validatePlan({ name: "x", screens: [{ type: "stack", name: "List", layout: { direction: "vertical", wrap: true, counterGap: 12 }, children: [{ type: "row", name: "Row", layout: { direction: "horizontal", gap: 4, counterGap: 9 } }] }] });
  assert.ok(v.success);
  const c = compilePlan(emptyDesignSystem(), v.plan);
  assert.equal(c.warnings.filter((w) => /counterGap only applies/.test(w)).length, 2);
  const report = await executePlan(c.plan!);
  const list = await fig().getNodeByIdAsync(report.createdRootIds[0]);
  assert.deepEqual([list.layoutWrap, list.children[0].layoutWrap], ["NO_WRAP", "NO_WRAP"]);
});
