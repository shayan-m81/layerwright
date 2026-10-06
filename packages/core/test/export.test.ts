// Figma snapshot → Design Plan → compile: an exported subtree is a valid plan that rebuilds the same structure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePlan, emptyDesignSystem, snapshotToPlan, validatePlan, type DesignPlan, type NodeSnapshot, type ResolvedFrame } from "../src/index.ts";
import { fixtureDs } from "./fixture.ts";

const snap: NodeSnapshot = {
  id: "10:1", type: "FRAME", name: "Card", x: 0, y: 0, w: 360, h: 200, fills: ["#ffffff"], radius: 12, bound: { itemSpacing: "spacing/md" },
  layout: { mode: "VERTICAL", gap: 16, padding: { top: 24, right: 24, bottom: 24, left: 24 }, primaryAlign: "MIN", counterAlign: "MIN", sizingH: "FIXED", sizingV: "HUG" },
  children: [
    { id: "10:2", type: "TEXT", name: "Title", w: 120, h: 28, fills: ["#101828"], layout: { mode: "NONE", sizingH: "HUG", sizingV: "HUG" },
      text: { chars: "Welcome back", fontSize: 28, font: "Inter Bold", styleId: "S:h1", style: "Heading/H1", autoResize: "WIDTH_AND_HEIGHT" } },
    { id: "10:3", type: "TEXT", name: "Body", w: 312, h: 40, fills: ["#6b7280"], layout: { mode: "NONE", sizingH: "FILL", sizingV: "HUG" },
      text: { chars: "Sign in to continue", fontSize: 15, font: "Plus Jakarta Sans Semi Bold", lineHeight: 20, autoResize: "HEIGHT" } },
    { id: "10:4", type: "INSTANCE", name: "Button", w: 312, h: 44, layout: { mode: "HORIZONTAL", sizingH: "FILL", sizingV: "HUG" },
      instance: { componentId: "1:3", componentSetId: "1:1", componentSet: "Button", variants: { Type: "Secondary", Size: "Medium" }, props: { "Label#10:0": "Continue" }, overrides: { Label: ["characters"] } },
      children: [{ id: "I10:4;1", type: "TEXT", name: "Label", text: { chars: "Continue" } }] },
    { id: "10:5", type: "VECTOR", name: "Sparkle" },
  ],
};

test("an inspected subtree exports to a valid plan: layout, tokens, text styles, fonts, instances with variants and props", () => {
  const { plan, warnings } = snapshotToPlan(snap, fixtureDs());
  const v = validatePlan(plan);
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  const card: any = plan.screens[0];
  assert.deepEqual([card.layout.direction, card.layout.gap, card.layout.padding, card.width, card.height, card.fill, card.radius], ["vertical", "spacing/md", 24, 360, "hug", "#FFFFFF", 12]);
  const [title, body, button] = card.children;
  assert.deepEqual([title.style, title.width], ["Heading/H1", "hug"]);
  assert.deepEqual([body.fontFamily, body.weight, body.fontSize, body.lineHeight, body.width], ["Plus Jakarta Sans", "semibold", 15, { unit: "px", value: 20 }, "fill"]);
  assert.deepEqual([button.component, button.variant, button.props, button.width], [{ id: "1:1" }, { Type: "Secondary", Size: "Medium" }, { Label: "Continue" }, "fill"]);
  assert.ok(warnings.some((w) => /vector "Sparkle"/.test(w)));

  const c = compilePlan(fixtureDs(), v.plan);
  assert.deepEqual(c.errors, []);
  const root = c.plan!.roots[0] as ResolvedFrame;
  assert.equal(root.layout!.gap!.variableId, "v2");
  assert.equal((root.children[0] as any).textStyleId, "S:h1");
  assert.equal((root.children[2] as any).componentId, "1:3", "the same variant");
  assert.deepEqual((root.children[2] as any).properties, { "Label#10:0": "Continue" });
});

test("ellipses, lines, polygons and stars export as shapes (arc, points, strokes) and compile back to the same kinds", () => {
  const s: NodeSnapshot = { id: "20:1", type: "FRAME", name: "Shapes", w: 200, h: 100, layout: { mode: "VERTICAL", sizingH: "FIXED", sizingV: "HUG" }, children: [
    { id: "20:2", type: "ELLIPSE", name: "Ring", w: 40, h: 40, fills: ["#176b66"], shape: { arc: { start: -90, end: 180, innerRadius: 0.8 } } },
    { id: "20:3", type: "LINE", name: "Rule", w: 200, h: 0, strokes: ["#e5e7eb"], strokeWeight: 2, layout: { mode: "NONE", sizingH: "FILL", sizingV: "FIXED" } },
    { id: "20:4", type: "STAR", name: "Star", w: 24, h: 24, fills: ["#f59e0b"], shape: { pointCount: 5, innerRadius: 0.382 } },
  ] };
  const { plan } = snapshotToPlan(s);
  const [ring, rule, star] = (plan.screens[0] as any).children;
  assert.deepEqual([ring.type, ring.shape, ring.arc, ring.fill], ["shape", "ellipse", { start: -90, end: 180, innerRadius: 0.8 }, "#176B66"]);
  assert.deepEqual([rule.shape, rule.width, rule.stroke, rule.strokeWeight, rule.height], ["line", "fill", "#E5E7EB", 2, undefined]);
  assert.deepEqual([star.shape, star.pointCount, star.innerRadius], ["star", 5, 0.382]);
  const v = validatePlan(plan);
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  const c = compilePlan(fixtureDs(), v.plan);
  assert.deepEqual(c.errors, []);
  assert.deepEqual((c.plan!.roots[0] as ResolvedFrame).children.map((x: any) => x.shape), ["ellipse", "line", "star"]);
});

// Issue #8: a big frame exported with figma_inspect({ format: "plan" }) previews and builds again as it is.

/** Validate (the schema must accept it) and compile against a Design System. */
function rebuild(plan: unknown, ds = emptyDesignSystem()) {
  const v = validatePlan(plan);
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  return compilePlan(ds, v.plan);
}

test("a pill's 'full' radius (33554400) exports as 9999; the schema and the compiler clamp a larger radius instead of rejecting it", () => {
  const pill: NodeSnapshot = { id: "30:1", type: "RECTANGLE", name: "Pill", w: 80, h: 32, fills: ["#176b66"], radius: 33554400 };
  assert.equal((snapshotToPlan(pill).plan.screens[0] as any).radius, 9999);
  // An export made before the fix still validates (clamped), and a plan that skipped validation compiles clamped.
  const v = validatePlan({ name: "old", screens: [{ type: "frame", radius: 33554400, children: [{ type: "image", radius: 50000 }] }] });
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  assert.equal((v.plan.screens[0] as any).radius, 9999);
  assert.equal(((compilePlan(emptyDesignSystem(), v.plan).plan!.roots[0] as ResolvedFrame).children[0] as any).radius.value, 9999);
  const raw = { name: "x", version: 1, screenGap: 80, screens: [{ type: "frame", radius: 33554400, children: [] }] } as unknown as DesignPlan;
  assert.deepEqual((compilePlan(emptyDesignSystem(), raw).plan!.roots[0] as ResolvedFrame).radius, { value: 9999 });
});

const tokens: NodeSnapshot = {
  id: "40:1", type: "FRAME", name: "Promo", w: 390, h: 300, fills: ["#ffffff"], radius: 12,
  bound: { fills: "color/bg/surface", itemSpacing: "spacing/md", paddingTop: "spacing/lg", paddingRight: "spacing/lg", paddingBottom: "spacing/lg", paddingLeft: "spacing/lg", topLeftRadius: "radius/md" },
  layout: { mode: "VERTICAL", gap: 16, padding: { top: 24, right: 24, bottom: 24, left: 24 }, sizingH: "FIXED", sizingV: "HUG" },
  children: [
    { id: "40:2", type: "TEXT", name: "Title", w: 200, h: 34, fills: ["#101828"], bound: { fills: "core/color/ink" }, layout: { mode: "NONE", sizingH: "HUG", sizingV: "HUG" },
      text: { chars: "Spring sale", fontSize: 28, font: "Inter Bold", lineHeight: "120%", styleId: "S:gone", style: "style/heading/xl", autoResize: "WIDTH_AND_HEIGHT" } },
    { id: "40:3", type: "FRAME", name: "Card", w: 342, h: 80, fills: ["#f2f4f7"], effectStyle: "E:1", effects: { shadows: [{ type: "drop", x: 0, y: 2, blur: 8, spread: 0, color: "#0000001a" }] },
      layout: { mode: "HORIZONTAL", gap: 8, padding: { top: 0, right: 0, bottom: 0, left: 0 }, sizingH: "FILL", sizingV: "FIXED" }, children: [] },
  ],
};

test("values: raw exports what tokens resolve to (hex, px, font fields), so the plan compiles without a Design System scan", () => {
  const { plan, warnings } = snapshotToPlan(tokens, fixtureDs(), { values: "raw" });
  const root: any = plan.screens[0];
  assert.deepEqual([root.fill, root.layout.gap, root.layout.padding, root.radius], ["#FFFFFF", 16, 24, 12]);
  const [title, card] = root.children;
  assert.equal(title.style, undefined);
  assert.deepEqual([title.fontFamily, title.weight, title.fontSize, title.lineHeight, title.color], ["Inter", "bold", 28, { unit: "percent", value: 120 }, "#101828"]);
  assert.deepEqual([card.effect, card.shadows?.[0].color, card.width], [undefined, "#0000001A", "fill"]);
  assert.deepEqual(warnings, []);
  const c = rebuild(plan);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.summary.tokensUsed, []);
});

test("values: tokens keeps the names the scan knows, and writes the raw value (with a warning) for one it doesn't", () => {
  const { plan, warnings } = snapshotToPlan(tokens, fixtureDs());
  const root: any = plan.screens[0];
  assert.deepEqual([root.fill, root.layout.gap, root.layout.padding, root.radius], ["color/bg/surface", "spacing/md", "spacing/lg", "radius/md"]);
  // Neither "core/color/ink" nor "style/heading/xl" is in the scan: the values they stand for are written instead.
  const [title] = root.children;
  assert.deepEqual([title.style, title.fontFamily, title.weight, title.color], [undefined, "Inter", "bold", "#101828"]);
  assert.match(warnings[0], /^2 variable\(s\) or text style\(s\) aren't in the Design System scan .*raw values are used instead/);
  assert.ok(warnings[0].includes("core/color/ink") && warnings[0].includes("style/heading/xl"));
  assert.deepEqual(rebuild(plan, fixtureDs()).errors, []);
  // Without a scan to check them against, tokens mode keeps every name (they were asked for).
  assert.equal((snapshotToPlan(tokens).plan.screens[0] as any).children[0].color, "core/color/ink");
});

test("a grid layout exports as a fixed frame whose children keep their positions; an absolute child of Auto Layout keeps its own", () => {
  const s: NodeSnapshot = { id: "50:1", type: "FRAME", name: "Page", w: 1200, h: 800, layout: { mode: "VERTICAL", gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, sizingH: "FIXED", sizingV: "FIXED" }, children: [
    { id: "50:2", type: "FRAME", name: "Gallery", x: 0, y: 0, w: 1200, h: 400, layout: { mode: "GRID", gap: 16, padding: { top: 0, right: 0, bottom: 0, left: 0 }, sizingH: "FILL", sizingV: "FIXED" }, children: [
      { id: "50:3", type: "FRAME", name: "A", x: 0, y: 0, w: 392, h: 192, fills: ["#eeeeee"], layout: { mode: "NONE", sizingH: "FILL", sizingV: "FILL" } },
      { id: "50:4", type: "FRAME", name: "B", x: 408, y: 0, w: 392, h: 192, fills: ["#dddddd"], layout: { mode: "NONE", sizingH: "FILL", sizingV: "FILL" } },
      { id: "50:5", type: "TEXT", name: "C", x: 816, y: 208, w: 100, h: 20, layout: { mode: "NONE", sizingH: "FILL", sizingV: "HUG" }, text: { chars: "Caption", fontSize: 14, font: "Inter Regular", autoResize: "HEIGHT" } },
    ] },
    { id: "50:6", type: "FRAME", name: "Badge", x: 1100, y: 20, w: 40, h: 40, absolute: true, layout: { mode: "NONE", sizingH: "FIXED", sizingV: "FIXED" } },
  ] };
  const { plan, warnings } = snapshotToPlan(s);
  const [gallery, badge] = (plan.screens[0] as any).children;
  assert.deepEqual([gallery.layout, gallery.width, gallery.height, gallery.position], [{ direction: "none" }, "fill", 400, undefined]);
  assert.deepEqual(gallery.children.map((c: any) => [c.position, c.width]), [[{ type: "absolute", x: 0, y: 0 }, 392], [{ type: "absolute", x: 408, y: 0 }, 392], [{ type: "absolute", x: 816, y: 208 }, 100]]);
  assert.deepEqual(badge.position, { type: "absolute", x: 1100, y: 20 });
  assert.ok(warnings.some((w) => /"Gallery" uses a grid layout/.test(w)));
  const c = rebuild(plan);
  assert.deepEqual(c.errors, []);
  const g = (c.plan!.roots[0] as ResolvedFrame).children[0] as ResolvedFrame;
  assert.deepEqual([g.layout?.direction, g.sizingH, g.children.map((x) => x.absolute)], ["NONE", "fill", [{ x: 0, y: 0 }, { x: 408, y: 0 }, { x: 816, y: 208 }]]);
});

test("image fills export by hash with their scale mode and compile to the image to paint; an image node takes imageHash", () => {
  const s: NodeSnapshot = { id: "60:1", type: "FRAME", name: "Hero", w: 390, h: 200, fills: ["#000000", "image", "gradient_linear"], image: { hash: "abc123", scaleMode: "FILL" },
    gradient: { type: "linear", angle: 180, stops: [{ color: "#00000000", position: 0 }, { color: "#00000080", position: 1 }] }, layout: { mode: "NONE" }, children: [
      { id: "60:2", type: "RECTANGLE", name: "Photo", x: 0, y: 0, w: 100, h: 100, radius: 8, fills: ["image"], image: { hash: "def456", scaleMode: "CROP" } },
      { id: "60:3", type: "ELLIPSE", name: "Avatar", x: 120, y: 0, w: 40, h: 40, fills: ["image"], image: { hash: "fff000", scaleMode: "TILE" } },
    ] };
  const { plan, warnings } = snapshotToPlan(s);
  const hero: any = plan.screens[0];
  const [photo, avatar] = hero.children;
  assert.deepEqual([hero.fill, hero.image, hero.gradient.type], ["#000000", { hash: "abc123", fit: "fill" }, "linear"]);
  assert.deepEqual([photo.type, photo.image, photo.radius, photo.fill], ["frame", { hash: "def456", fit: "fill" }, 8, undefined]);
  assert.deepEqual([avatar.type, avatar.image], ["shape", { hash: "fff000", fit: "tile" }]);
  assert.ok(warnings.some((w) => /"Photo" crops its image/.test(w)));
  assert.ok(!warnings.some((w) => /image fill/.test(w)), "images aren't dropped any more");
  const c = rebuild(plan);
  assert.deepEqual(c.errors, []);
  const root = c.plan!.roots[0] as ResolvedFrame;
  const [p, a] = root.children as any[];
  assert.deepEqual([root.image, p.image, a.image, a.fill], [{ hash: "abc123", scaleMode: "FILL" }, { hash: "def456", scaleMode: "FILL" }, { hash: "fff000", scaleMode: "TILE" }, undefined]);
  // An image node can point at an image of this file too, but not at new bytes and a hash at once.
  const img = rebuild({ name: "i", screens: [{ type: "image", imageHash: "abc123", fit: "fit" }] });
  assert.deepEqual([(img.plan!.roots[0] as any).imageHash, (img.plan!.roots[0] as any).fit], ["abc123", "FIT"]);
  assert.match(rebuild({ name: "i", screens: [{ type: "image", imageHash: "abc123", src: "https://example.com/a.png" }] }).errors[0].message, /or imageHash .* not both/);
});

test("a text whose colour, weight or size changes inside it exports runs, which compile to styled ranges", () => {
  const s: NodeSnapshot = { id: "70:1", type: "TEXT", name: "Price", w: 200, h: 24, layout: { mode: "NONE", sizingH: "HUG", sizingV: "HUG" },
    // Mixed: the text reports no single colour, font or size, only its pieces.
    text: { chars: "Now only $9", font: "mixed", autoResize: "WIDTH_AND_HEIGHT", runs: [
      { chars: "Now only ", font: "Inter Regular", fontSize: 16, fill: "#101828" },
      { chars: "$9", font: "Inter Bold", fontSize: 20, fill: "#d92d20", href: "https://example.com/buy" },
    ] } };
  const t: any = snapshotToPlan(s).plan.screens[0];
  assert.deepEqual([t.fontFamily, t.weight, t.fontSize, t.color], ["Inter", "regular", 16, "#101828"]);
  assert.deepEqual(t.runs, [{ text: "Now only " }, { text: "$9", weight: "bold", fontSize: 20, color: "#D92D20", href: "https://example.com/buy" }]);
  const c = rebuild({ name: "t", screens: [t] });
  assert.deepEqual(c.errors, []);
  assert.deepEqual((c.plan!.roots[0] as any).runs, [{ start: 9, end: 11, fontFamily: undefined, fontWeight: "Bold", italic: undefined, fontSize: 20, fill: { hex: "#D92D20" }, hyperlink: "https://example.com/buy" }]);
  // Pieces that change nothing aren't worth runs.
  const same = snapshotToPlan({ ...s, text: { ...s.text!, runs: [{ chars: "Now only ", font: "Inter Regular", fontSize: 16, fill: "#101828" }, { chars: "$9", font: "Inter Regular", fontSize: 16, fill: "#101828" }] } });
  assert.equal((same.plan.screens[0] as any).runs, undefined);
  // A text an inspect cut short (300 characters and "…") has its runs cut with it; one that really ends with "…" keeps it.
  const long = `${"x".repeat(299)}yz`;
  const cut: any = snapshotToPlan({ ...s, text: { chars: `${long.slice(0, 300)}…`, font: "mixed", runs: [{ chars: long.slice(0, 299), font: "Inter Regular", fontSize: 16 }, { chars: "yz", font: "Inter Bold", fontSize: 16 }] } }).plan.screens[0];
  assert.deepEqual([cut.content, cut.runs.map((r: any) => r.text.length)], [long.slice(0, 300), [299, 1]]);
  assert.equal((snapshotToPlan({ ...s, text: { chars: "Loading…", font: "Inter Regular", fontSize: 14 } }).plan.screens[0] as any).content, "Loading…");
});

test("a wrapping row exports wrap and its row gap (counterGap), compiled to counterAxisSpacing; counterGap without wrap is ignored with a warning", () => {
  const s: NodeSnapshot = { id: "80:1", type: "FRAME", name: "Tags", w: 342, h: 80, bound: { counterAxisSpacing: "spacing/sm" },
    layout: { mode: "HORIZONTAL", gap: 8, padding: { top: 0, right: 0, bottom: 0, left: 0 }, wrap: true, counterGap: 8, sizingH: "FIXED", sizingV: "HUG" }, children: [] };
  const raw: any = snapshotToPlan(s, undefined, { values: "raw" }).plan.screens[0];
  assert.deepEqual([raw.layout.wrap, raw.layout.counterGap], [true, 8]);
  const { plan } = snapshotToPlan(s, fixtureDs());
  assert.equal((plan.screens[0] as any).layout.counterGap, "spacing/sm");
  assert.deepEqual((rebuild(plan, fixtureDs()).plan!.roots[0] as ResolvedFrame).layout!.counterGap, { variableId: "v1", variableKey: undefined, value: 8 });
  const cn = rebuild({ name: "n", screens: [{ type: "stack", layout: { direction: "vertical", wrap: true, counterGap: 12 } }] });
  assert.equal((cn.plan!.roots[0] as ResolvedFrame).layout!.counterGap, undefined);
  assert.ok(cn.warnings.some((w) => /counterGap only applies to a horizontal layout with wrap: true/.test(w)));
});
