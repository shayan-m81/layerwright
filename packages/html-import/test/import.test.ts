// HTML → Design DSL snapshot tests (landing page, login form, RTL Persian page), DS mapping, and the
// whole pipeline HTML → plan → compile → execute on the strict Figma mock.
// Snapshots compare numbers with a tolerance of ±2px or ±3% (whichever is larger), so text shaping
// differences between operating systems don't fail the suite. Update with: UPDATE_SNAPSHOTS=1 npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePlan, validatePlan } from "@cde/core";
import { fixtureDs } from "../../core/test/fixture.ts";
import { launch, renderToPlan } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (f: string) => join(here, "fixtures", f);
const snapDir = join(here, "__snapshots__");

let browserOk = true;
try { await (await launch()).close(); } catch { browserOk = false; }
const maybe = browserOk ? test : test.skip;
if (!browserOk) console.warn("html-import tests skipped: no Chromium (run `npx playwright install chromium`).");

function close(actual: unknown, expected: unknown, path = "$"): string[] {
  if (typeof expected === "number" && typeof actual === "number") return Math.abs(actual - expected) <= Math.max(2, Math.abs(expected) * 0.03) ? [] : [`${path}: ${actual} ≠ ${expected}`];
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${path}: array length ${Array.isArray(actual) ? actual.length : typeof actual} ≠ ${expected.length}`];
    return expected.flatMap((e, i) => close(actual[i], e, `${path}[${i}]`));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return [`${path}: ${typeof actual} ≠ object`];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual as object)]);
    return [...keys].flatMap((k) => close((actual as any)[k], (expected as any)[k], `${path}.${k}`));
  }
  return actual === expected ? [] : [`${path}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`];
}

function snapshot(name: string, value: unknown) {
  const file = join(snapDir, `${name}.json`);
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) {
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
    return;
  }
  const diff = close(value, JSON.parse(readFileSync(file, "utf8")));
  assert.deepEqual(diff.slice(0, 20), [], `snapshot ${name} differs`);
}

for (const f of ["landing.html", "login.html", "rtl-fa.html"]) {
  maybe(`snapshot: ${f} → Design DSL (1440 + 390)`, async () => {
    const r = await renderToPlan(fixture(f));
    assert.equal(r.plan.screens.length, 2);
    assert.deepEqual(r.warnings, []);
    snapshot(f.replace(".html", ""), r.plan);
    const c = compilePlan({ ...fixtureDs(), typography: [] }, r.plan);
    assert.deepEqual(c.errors, [], "the imported plan compiles against a Design System");
  });
}

maybe("flexbox becomes Auto Layout; RTL rows keep logical order with direction rtl", async () => {
  const { plan } = await renderToPlan(fixture("rtl-fa.html"), { viewports: [390] });
  const screen: any = plan.screens[0];
  const header = screen.children[0];
  assert.equal(header.layout.direction, "horizontal");
  assert.equal(header.direction, "rtl");
  assert.equal(header.children[0].content, "لیست آرزوهای سارا");
  assert.equal(header.children[0].align, "right");
  const main = screen.children[1];
  assert.equal(main.layout.gap, 12);
  assert.equal(main.layout.crossAlign, "end", "in RTL the column's start edge is the right edge");
});

maybe("buttons, inputs and links map to Design System components when a DS is scanned", async () => {
  const { plan, mapped } = await renderToPlan(fixture("login.html"), { viewports: [390], ds: fixtureDs() });
  const form: any = (plan.screens[0] as any).children[0];
  const email = form.children[1].children[1];
  assert.equal(email.type, "input");
  assert.equal(email.props.placeholder, "you@company.com");
  assert.equal(form.children[2].children[1].role, "password-input");
  assert.equal(form.children[3].type, "button");
  assert.equal(form.children[3].props.label, "Sign in");
  assert.ok(Object.values(mapped).reduce((a, b) => a + b, 0) >= 3);
  const c = compilePlan(fixtureDs(), plan);
  assert.deepEqual(c.errors, []);
  assert.ok(Object.keys(c.summary.instances).some((k) => /Button/.test(k)));
});

maybe("end to end: HTML export → plan → execute on the strict Figma mock → editable frame", async () => {
  const { resetFigma } = await import("../../../apps/figma-plugin/test/figma-mock.ts");
  const { executePlan } = await import("../../../apps/figma-plugin/src/execute.ts");
  const { plan } = await renderToPlan(fixture("landing.html"), { viewports: [1440] });
  const v = validatePlan(plan);
  assert.ok(v.success);
  const c = compilePlan({ ...fixtureDs(), typography: [] }, v.plan);
  assert.deepEqual(c.errors, []);
  const page = resetFigma();
  const report = await executePlan(c.plan!);
  const screen = page.children[0];
  assert.equal(screen.type, "FRAME");
  assert.equal(screen.width, 1440);
  assert.equal(screen.layoutMode, "VERTICAL");
  const nav = screen.children[0];
  assert.equal(nav.layoutMode, "HORIZONTAL");
  assert.equal(nav.primaryAxisAlignItems, "SPACE_BETWEEN");
  const texts = screen.findAllWithCriteria({ types: ["TEXT"] }).map((t: any) => t.characters);
  for (const s of ["Acme", "Ship designs faster", "Get started", "Auto Layout", "Tokens"]) assert.ok(texts.includes(s), `missing text ${s}`);
  // "Vazirmatn" Bold resolves against the mock's installed fonts; nothing fell back silently.
  assert.ok(report.warnings.every((w) => !/could be loaded/.test(w)));
});

maybe("single-line labels (buttons, links) hug their text so Figma's font metrics can't wrap them", async () => {
  const { plan } = await renderToPlan(fixture("landing.html"), { viewports: [1440] });
  const texts: any[] = [];
  const walk = (n: any, parent?: any) => { if (n.type === "text") texts.push({ n, parent }); (n.children ?? []).forEach((c: any) => walk(c, n)); };
  walk(plan.screens[0]);
  for (const label of ["Features", "Get started", "Learn more"]) {
    const t = texts.find((x) => x.n.content === label);
    assert.ok(t, label);
    assert.equal(t.n.width, "hug", `${label} label`);
    assert.equal(t.parent.width, "hug", `${label} container`);
  }
});

maybe("display: contents wrappers vanish; fixed CSS sizes stay fixed; content-sized boxes still hug", async () => {
  const { plan } = await renderToPlan(fixture("sizing.html"), { viewports: [1440] });
  const find = (n: any, pred: (x: any) => boolean): any => (pred(n) ? n : (n.children ?? []).map((c: any) => find(c, pred)).find(Boolean));
  const row = find(plan.screens[0], (n) => n.layout?.direction === "horizontal" && n.children?.length === 3);
  assert.ok(row, "row found");
  const [tile, step, chip] = row.children;
  // The icon sits directly in the tile: no frame for the display:contents wrapper, no page-sized padding.
  assert.equal(tile.children.length, 1);
  assert.equal(tile.children[0].type, "icon");
  assert.equal(tile.width, 44);
  assert.equal(tile.height, 44);
  assert.ok(typeof tile.layout.padding !== "object" || Object.values(tile.layout.padding).every((p: any) => p < 44));
  // A 32×32 step circle keeps its size; its single-line label still hugs.
  assert.equal(step.width, 32);
  assert.equal(step.height, 32);
  assert.equal(step.children[0].width, "hug");
  // A padded chip is exactly its content: it hugs.
  assert.equal(chip.width, "hug");
  assert.equal(chip.height, "hug");
  // A timeline column: the 22px step circle defines its width, so the column keeps it (a hugging column would let a
  // filling circle collapse to the 2px stem).
  const col = find(plan.screens[0], (n) => n.layout?.direction === "vertical" && n.children?.length === 2 && n.children[0].children?.[0]?.content === "3");
  assert.ok(col, "timeline column");
  assert.notEqual(col.width, "hug");
});

maybe("DS mapping never uses a shape-only guess: an accordion with one text layer is not a button", async () => {
  const { enrichDesignSystem } = await import("@cde/core");
  const base = fixtureDs();
  // Only an accordion (no "button" in its name) that happens to look like a button by shape.
  const ds = enrichDesignSystem({ ...base,
    componentSets: [{ id: "8:1", key: "k8", name: "QA Accordion", remote: false, variantIds: ["8:2"], properties: [{ key: "State", name: "State", type: "VARIANT", options: ["Collapsed"] }] }],
    components: [{ id: "8:2", key: "k82", name: "State=Collapsed", remote: false, componentSetId: "8:1", variants: { State: "Collapsed" }, dimensions: { width: 354, height: 52 }, textLayers: ["Title"] }] });
  const r = await renderToPlan(fixture("landing.html"), { viewports: [1440], ds });
  assert.deepEqual(r.mapped, {});
  assert.ok(r.warnings.some((w) => /QA Accordion: matched only by shape/.test(w)), r.warnings.join("\n"));
});

maybe("inline runs (<b>, <a>) become one text layer with styled ranges, in logical order (RTL too)", async () => {
  const { plan } = await renderToPlan(fixture("inline.html"), { viewports: [390] });
  const texts: any[] = [];
  const walk = (n: any) => { if (n.type === "text") texts.push(n); (n.children ?? []).forEach(walk); };
  walk(plan.screens[0]);
  assert.equal(texts.length, 2, texts.map((t) => t.content).join(" | "));
  const [fa, en] = texts;
  assert.equal(fa.content, "مرحله ۳ از ۵ · تکمیل شواهد");
  assert.deepEqual(fa.runs.map((r: any) => [r.text, r.weight, r.color]), [["مرحله ۳ از ۵ · ", undefined, undefined], ["تکمیل شواهد", "bold", "#176B66"]]);
  assert.equal(en.content, "Upload two documents, then read the help page.");
  assert.deepEqual(en.runs.filter((r: any) => Object.keys(r).length > 1).map((r: any) => [r.text, r.weight ?? r.href]), [["two", "bold"], ["help page", "https://example.com/help"]]);
  // And the executor applies them as ranges.
  const { resetFigma } = await import("../../../apps/figma-plugin/test/figma-mock.ts");
  const { executePlan } = await import("../../../apps/figma-plugin/src/execute.ts");
  const c = compilePlan({ ...fixtureDs(), typography: [] }, plan);
  assert.deepEqual(c.errors, []);
  const page = resetFigma();
  await executePlan(c.plan!);
  const t = page.children[0].findAllWithCriteria({ types: ["TEXT"] }).find((x: any) => x.characters.startsWith("Upload"));
  assert.ok(t.ranges.some((r: any) => r.font?.style === "Bold" && t.characters.slice(r.start, r.end) === "two"));
  assert.ok(t.ranges.some((r: any) => r.link?.value === "https://example.com/help"));
});

maybe("user mappings turn chosen elements into that component (winning over automatic matching); fontMap swaps families", async () => {
  const r = await renderToPlan(fixture("login.html"), { viewports: [390], ds: fixtureDs(),
    mappings: [{ selector: "button", component: { id: "1:1" }, variant: { Type: "Secondary" }, props: { Label: "$text" } }], fontMap: { Vazirmatn: "Inter" } });
  const nodes: any[] = [];
  const walk = (n: any) => { nodes.push(n); (n.children ?? []).forEach(walk); };
  walk(r.plan.screens[0]);
  const btn = nodes.find((n) => n.type === "component");
  assert.deepEqual([btn.component, btn.variant, btn.props], [{ id: "1:1" }, { Type: "Secondary" }, { Label: "Sign in" }]);
  assert.ok(!nodes.some((n) => n.type === "button"), "no automatic mapping for the element the user mapped");
  assert.ok(nodes.filter((n) => n.type === "text").every((t) => t.fontFamily === "Inter"));
  const c = compilePlan(fixtureDs(), r.plan);
  assert.deepEqual(c.errors, []);
  assert.ok(Object.keys(c.summary.instances).includes("Button / Secondary, Medium"));
});

maybe("an absolute overlay on a one-child box is added once; SVG dash offsets and CSS rotation are kept", async () => {
  const { plan } = await renderToPlan(fixture("ring.html"), { viewports: [390] });
  const find = (n: any, pred: (x: any) => boolean): any => (pred(n) ? n : (n.children ?? []).map((c: any) => find(c, pred)).find(Boolean));
  const ring = find(plan.screens[0], (n) => n.type === "frame" && n.children?.some((c: any) => c.type === "icon"));
  assert.equal(ring.children.length, 2, "svg + one overlay, not two");
  assert.equal(ring.children.filter((c: any) => c.position).length, 1);
  const svg = ring.children.find((c: any) => c.type === "icon").svg;
  // 40% of the circle as a real arc (Figma renders dash patterns differently): no dashes left.
  assert.match(svg, /<path [^>]*d="M 128 68 A 60 60 0 0 1 [\d.-]+ [\d.-]+"/);
  assert.doesNotMatch(svg, /stroke-dasharray/);
  assert.match(svg, /<g transform="translate\(68 68\) matrix\(/);
});

maybe("one line in two fonts is one line: the title and its block hug instead of keeping Chrome's width", async () => {
  const { plan } = await renderToPlan(fixture("mixed.html"), { viewports: [390] });
  const find = (n: any, pred: (x: any) => boolean): any => (pred(n) ? n : (n.children ?? []).map((c: any) => find(c, pred)).find(Boolean));
  const title = find(plan.screens[0], (n) => n.type === "text" && n.content.startsWith("درخواست"));
  const block = find(plan.screens[0], (n) => n.type === "frame" && n.children?.includes(title));
  assert.equal(title.width, "hug");
  assert.equal(block.width, "hug");
});

maybe("oklch, hsl and color-mix colours are converted; an absolute layer before the flow stays behind it", async () => {
  const { plan } = await renderToPlan(fixture("colors.html"), { viewports: [390] });
  const all: any[] = [];
  const walk = (n: any) => { all.push(n); (n.children ?? []).forEach(walk); };
  walk(plan.screens[0]);
  const pill = all.find((n) => n.children?.some((c: any) => c.content === "در انتظار تو"));
  assert.match(pill.fill, /^#F[0-9A-F]{5}$/, "light violet background");
  assert.ok(pill.stroke, "border colour from color-mix");
  assert.match(pill.children[0].color, /^#[0-9A-F]{6}$/);
  const bar = all.find((n) => n.children?.length === 3 && n.children.some((c: any) => c.position));
  assert.ok(bar.children[0].position, "the connector line is the first (bottom) layer");
  assert.match(bar.children[0].fill, /^#[0-9A-F]{6}$/);
});

maybe("radial and conic gradients, layer blur and backdrop blur come across (plan → Figma paints and effects)", async () => {
  const { plan } = await renderToPlan(fixture("effects.html"), { viewports: [390] });
  const all: any[] = [];
  const walk = (n: any) => { all.push(n); (n.children ?? []).forEach(walk); };
  walk(plan.screens[0]);
  const box = (cls: string) => all.find((n) => n.name === cls);
  assert.equal(box(".a").gradient.type, "radial");
  assert.deepEqual([box(".b").gradient.type, box(".b").gradient.angle], ["angular", 90]);
  assert.equal(box(".c").blur, 4);
  assert.equal(box(".d").backgroundBlur, 12);
  // A glow that fades to transparent keeps both stops; the clear one takes the colour, not black.
  assert.deepEqual(box(".glow").gradient.stops.map((s: any) => s.color), ["#7C3AED99", "#7C3AED00"]);
  const { resetFigma } = await import("../../../apps/figma-plugin/test/figma-mock.ts");
  const { executePlan } = await import("../../../apps/figma-plugin/src/execute.ts");
  const c = compilePlan({ ...fixtureDs(), typography: [] }, plan);
  assert.deepEqual(c.errors, []);
  const page = resetFigma();
  await executePlan(c.plan!);
  const nodes = page.children[0].findAll(() => true);
  const named = (n: string) => nodes.find((x: any) => x.name === n);
  assert.equal(named(".a").fills.at(-1).type, "GRADIENT_RADIAL");
  assert.equal(named(".b").fills.at(-1).type, "GRADIENT_ANGULAR");
  assert.equal(named(".c").effects[0].type, "LAYER_BLUR");
  assert.equal(named(".d").effects[0].type, "BACKGROUND_BLUR");
  assert.deepEqual(named(".glow").fills.at(-1).gradientStops.map((s: any) => s.color.a), [0.6, 0]);
  // The pixel-faithful importer: the glow is a gradient; only a hard-edged transparent→colour radial is a corner fillet.
  const { importHtml } = await import("../src/index.ts");
  const [shot] = await importHtml({ file: fixture("effects.html"), viewport: 600 });
  const kids = (shot.tree as any).children;
  assert.deepEqual(kids.map((k: any) => k.type === "svg" ? k.name : k.gradient?.type ?? k.blur ?? k.backdropBlur), ["radial", "angular", 4, 12, "radial", "notch-fillet"]);
});

/** A plan or tree with picture bytes cut to their type: the bytes differ by platform, what they are doesn't. */
const pictureless = (v: any): any => Array.isArray(v) ? v.map(pictureless)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" && x.startsWith("data:image/") ? x.slice(0, x.indexOf(";")) : pictureless(x)])) : v;

maybe("pictures: <img> (PNG, WebP, SVG), sprites, CSS backgrounds and masks, icon fonts and <canvas> become vectors and images", async () => {
  const r = await renderToPlan(fixture("assets.html"), { viewports: [600] });
  assert.deepEqual(r.warnings, []);
  snapshot("assets", pictureless(r.plan));
  const [row, hero] = (r.plan.screens[0] as any).children;
  const by = (name: string) => row.children.find((n: any) => n.name === name);
  assert.match(by("Photo").src, /^data:image\/png;base64,/);
  assert.match(by("Webp photo").src, /^data:image\/png;base64,/, "WebP is decoded to PNG, which Figma takes");
  assert.equal(by("Logo").type, "icon", "an SVG <img> is a vector");
  assert.match(by("Logo").svg, /^<svg[^>]*viewBox="0 0 32 32"[\s\S]*<circle[^>]*fill="#7C3AED"/);
  assert.doesNotMatch(by("Star").svg + by("Heart").svg, /<use/, "sprite icons are expanded, from the page and from a sprite file");
  assert.match(by("Star").svg, /<path[^>]*fill="#0A84FF"/, "currentColor comes from the <use>");
  assert.match(by("Heart").svg, /<path[^>]*d="M12 21/);
  assert.equal(by("Background icon").type, "icon", "an SVG background on an empty element is a vector");
  assert.match(by("Masked icon").svg, /fill="#CC0000"/, "a CSS mask is the SVG in the element's colour");
  assert.doesNotMatch(by("Masked icon").svg, /#7C3AED/);
  assert.match(by("Font icon").src, /^data:image\/png/, "an icon-font glyph is a picture, not a box in Figma");
  assert.equal(row.children.filter((n: any) => n.type === "image").length, 5, "photo, WebP, font icon, ligature icon, canvas");
  assert.deepEqual([hero.image.fit, hero.fill], ["fill", "#000000"]);
  assert.match(hero.image.src, /^data:image\/png/);
  // Built on the strict mock: the pictures are real image fills, the background over the colour.
  const { resetFigma } = await import("../../../apps/figma-plugin/test/figma-mock.ts");
  const { executePlan } = await import("../../../apps/figma-plugin/src/execute.ts");
  const c = compilePlan({ ...fixtureDs(), typography: [] }, r.plan);
  assert.deepEqual(c.errors, []);
  const page = resetFigma();
  const report = await executePlan(c.plan!);
  assert.deepEqual(report.warnings.filter((w) => /image|SVG/i.test(w)), []);
  const heroNode = page.findAll((n: any) => n.name === ".hero")[0];
  assert.deepEqual(heroNode.fills.map((f: any) => f.type), ["SOLID", "IMAGE"]);
  assert.equal(page.findAll((n: any) => n.type === "RECTANGLE" && n.fills[0]?.type === "IMAGE").length, 5);
});

maybe("pictures in the pixel-exact importer: <img>, backgrounds, masks, sprites, icon fonts and <canvas>", async () => {
  const { importHtml } = await import("../src/index.ts");
  const [shot] = await importHtml({ file: fixture("assets.html"), viewport: 600 });
  assert.deepEqual(shot.warnings, []);
  const kids = (shot.tree as any).children;
  assert.deepEqual(kids.map((k: any) => `${k.type}:${k.name}`), ["image:Photo", "image:Webp photo", "svg:Logo", "svg:Star", "svg:Heart", "svg:Background icon", "svg:Masked icon", "image:Font icon", "image:icon", "image:image", "frame:div"]);
  assert.ok(kids.filter((k: any) => k.type === "image").every((k: any) => /^data:image\/png;base64,/.test(k.src)));
  assert.match(kids[6].svg, /fill="#CC0000"/);
  assert.deepEqual([kids[10].image.fit, kids[10].fill.hex], ["FILL", "#000000"]);
  const { resetFigma } = await import("../../../apps/figma-plugin/test/figma-mock.ts");
  const { importTree } = await import("../../../apps/figma-plugin/src/import.ts");
  const page = resetFigma();
  await importTree({ screens: [{ name: shot.name, tree: shot.tree }] });
  assert.equal(page.findAll((n: any) => n.type === "RECTANGLE" && n.fills[0]?.type === "IMAGE").length, 5);
  assert.deepEqual(page.findAll((n: any) => n.name === "div")[0].fills.map((f: any) => f.type), ["SOLID", "IMAGE"]);
});
