// Executor tests against a strict in-memory mock of the Figma Plugin API.
// The mock enforces the rules that most often break real plugins: fonts must be loaded
// before text writes, FILL needs an auto-layout parent, HUG needs auto-layout/text,
// setProperties rejects unknown keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePlan, validatePlan, analyzeDesign, type ResolvedPlan } from "@cde/core";
import { fixtureDs, loginPlan } from "../../../packages/core/test/fixture.ts";
import { N, T, loaded, resetFigma, styles } from "./figma-mock.ts";

const { executePlan, applyTransformations, fontAsked } = await import("../src/execute.ts");

function compiledLogin(): ResolvedPlan {
  const v = validatePlan(loginPlan);
  assert.ok(v.success);
  const c = compilePlan(fixtureDs(), v.plan);
  assert.deepEqual(c.errors, []);
  return c.plan!;
}

test("executes the login plan into native frames, instances, tokens and styles", async () => {
  const page = resetFigma();
  const report = await executePlan(compiledLogin());
  assert.deepEqual(report.warnings, []);
  assert.equal(page.children.length, 1);
  const screen = page.children[0];
  assert.equal(screen.type, "FRAME");
  assert.equal(screen.layoutMode, "VERTICAL");
  assert.equal(screen.boundVariables.itemSpacing.id, "v2");
  assert.equal(screen.boundVariables.paddingTop.id, "v3");
  assert.equal(screen.fills[0].boundVariables.color.id, "v5");
  assert.equal(screen.width, 390);
  const [h, body, email, pw, btn, link] = screen.children;
  assert.equal(h.characters, "Welcome back");
  assert.equal(h.textStyleId, "S:h1");
  assert.equal(h.layoutSizingHorizontal, "FILL");
  assert.equal(body.fills[0].boundVariables.color.id, "v6");
  assert.equal(email.type, "INSTANCE");
  assert.equal(email.mainComponent.id, "2:2");
  assert.equal(email.componentProperties["Label#20:0"].value, "Email");
  assert.equal(email.layoutSizingHorizontal, "FILL");
  assert.equal(pw.componentProperties["Label#20:0"].value, "Password");
  assert.equal(btn.mainComponent.id, "1:2");
  assert.equal(btn.componentProperties["Label#10:0"].value, "Continue");
  assert.equal(link.mainComponent.id, "3:1");
  assert.equal(link.children[0].characters, "Forgot password?");
  assert.equal(Object.keys(report.nodeIds).length, 7);
});

test("failed execution rolls back everything it created", async () => {
  const page = resetFigma();
  const plan = compiledLogin();
  (plan.roots[0] as any).children[4].componentId = "404:404"; // component deleted since scan
  await assert.rejects(executePlan(plan), (e: any) => e.detail.type === "COMPONENT_NOT_FOUND" && /rolled back/.test(e.detail.message));
  assert.equal(page.children.length, 0);
});

test("a text style that can't be applied keeps the text (own font, the style's size) with a warning, not a rollback", async () => {
  const page = resetFigma();
  const plan = compiledLogin();
  const h = (plan.roots[0] as any).children[0];
  h.textStyleId = "S:gone"; h.textStyleKey = undefined; h.textStyleFont = undefined; // deleted since the scan: Figma returns nothing
  const report = await executePlan(plan);
  assert.equal(page.children.length, 1);
  const t = page.children[0].children[0];
  assert.equal(t.characters, "Welcome back");
  assert.equal(t.textStyleId, "");
  assert.equal(t.fontSize, h.textStyleSize);
  assert.ok(report.warnings.some((w) => /text style "Heading\/H1" can't be applied \(not in this file under the id/.test(w)), report.warnings.join("\n"));
});

test("a library style that reports no font gets it from a layer that uses it, and is applied", async () => {
  const page = resetFigma();
  // Like a library style reached by id: its fontName is a placeholder, but a layer in the file uses it.
  const user = Object.assign(new T(), { _f: { family: "Inter", style: "Bold" } }); // a layer as it is in the file (not written now)
  styles.set("S:lib", { id: "S:lib", type: "TEXT", fontName: { family: "", style: "" }, realFont: { family: "Inter", style: "Bold" }, getStyleConsumersAsync: async () => [{ node: user, fields: ["textStyleId"] }] });
  const plan = compiledLogin();
  const h = (plan.roots[0] as any).children[0];
  h.textStyleId = "S:lib"; h.textStyleKey = "klib"; h.textStyleFont = undefined;
  const report = await executePlan(plan);
  assert.deepEqual(report.warnings, []);
  assert.equal(page.children[0].children[0].textStyleId, "S:lib");
  styles.delete("S:lib");
});

test("a library style whose font nobody reports is still applied: the font Figma asks for is loaded and it tries again", async () => {
  const page = resetFigma();
  // Neither the style, the scan nor a consumer says its font (getStyleConsumersAsync finds nothing); Figma knows it.
  styles.set("S:nofont", { id: "S:nofont", type: "TEXT", fontName: { family: "", style: "" }, realFont: { family: "Vazirmatn", style: "Medium" }, getStyleConsumersAsync: async () => [] });
  const plan = compiledLogin();
  const h = (plan.roots[0] as any).children[0];
  h.textStyleId = "S:nofont"; h.textStyleKey = undefined; h.textStyleFont = undefined;
  const report = await executePlan(plan);
  assert.deepEqual(report.warnings.filter((w) => /can't be applied/.test(w)), []);
  const t = page.children[0].children[0];
  assert.equal(t.textStyleId, "S:nofont");
  assert.deepEqual(t.fontName, { family: "Vazirmatn", style: "Medium" });
  assert.equal(t.characters, "Welcome back");
  styles.delete("S:nofont");
});

test("figma_edit applies a text style that reports no font to an existing text", async () => {
  resetFigma();
  styles.set("S:nofont2", { id: "S:nofont2", type: "TEXT", fontName: { family: "", style: "" }, realFont: { family: "Vazirmatn", style: "Bold" }, getStyleConsumersAsync: async () => [] });
  const page = (globalThis as any).figma.currentPage;
  loaded.add("Inter::Regular");
  const t = new T(); t.characters = "Label"; page.appendChild(t);
  const { editNodes } = await import("../src/edit.ts");
  const r: any = await editNodes({ ops: [{ op: "style", node: t.id, kind: "text", styleId: "S:nofont2", styleName: "Fa Text xs/Medium" }], approved: true } as any);
  assert.equal(r.applied?.length, 1, JSON.stringify(r));
  assert.equal(t.textStyleId, "S:nofont2");
  styles.delete("S:nofont2");
});

test("a style Figma links without asking for its font: the font is loaded anyway, so the text can be written", async () => {
  const page = resetFigma();
  // Like the real Figma for some library styles: setTextStyleIdAsync succeeds with the font unloaded.
  styles.set("S:silent", { id: "S:silent", type: "TEXT", fontName: { family: "", style: "" }, realFont: { family: "Vazirmatn", style: "Bold" }, silent: true, getStyleConsumersAsync: async () => [] });
  const plan = compiledLogin();
  const h = (plan.roots[0] as any).children[0];
  h.textStyleId = "S:silent"; h.textStyleKey = undefined; h.textStyleFont = undefined;
  const report = await executePlan(plan);
  assert.deepEqual(report.warnings.filter((w) => /can't be applied/.test(w)), []);
  const t = page.children[0].children[0];
  assert.equal(t.textStyleId, "S:silent");
  assert.equal(t.characters, "Welcome back");
  styles.delete("S:silent");
});

test("fontAsked reads the font out of Figma's refusal", () => {
  assert.deepEqual(fontAsked(new Error('Cannot write to node with unloaded font "IRANYekan X Medium". Please call figma.loadFontAsync({ family: "IRANYekan X", style: "Medium" }) and await the returned promise first.')), { family: "IRANYekan X", style: "Medium" });
  assert.equal(fontAsked(new Error("something else")), undefined);
});

test("a style that can't be had says why (not a guess about the library), and is looked up once per run", async () => {
  const page = resetFigma();
  let imports = 0;
  (globalThis as any).figma.importStyleByKeyAsync = async () => { imports++; throw new Error("No published style with key kold"); };
  const plan = compiledLogin();
  const [h, body] = (plan.roots[0] as any).children;
  for (const t of [h, body]) { t.textStyleId = "S:stale"; t.textStyleKey = "kold"; t.textStyleFont = undefined; t.textStyleName = "Heading/H1"; }
  const report = await executePlan(plan);
  assert.equal(page.children.length, 1);
  assert.equal(imports, 1);
  const w = report.warnings.filter((x) => /can't be applied/.test(x));
  assert.equal(w.length, 1, report.warnings.join("\n"));
  assert.match(w[0], /not in this file under the id from the scan/);
  assert.match(w[0], /No published style with key kold/);
  assert.doesNotMatch(w[0], /isn't enabled/);
});

test("transformations are non-destructive and bind tokens", async () => {
  const page = resetFigma();
  const frame = new N("FRAME"); frame.name = "Old"; page.appendChild(frame);
  frame.layoutMode = "VERTICAL"; frame.itemSpacing = 16;
  const fake = new N("FRAME"); fake.name = "Rectangle 5"; frame.appendChild(fake);
  fake.layoutMode = "HORIZONTAL"; fake.fills = [{ type: "SOLID", color: { r: 0.1, g: 0.45, b: 0.9 } }];
  const label = new T(); loaded.add("Inter::Regular"); label.characters = "Continue"; fake.appendChild(label); loaded.clear();
  const snap = { id: frame.id, type: "FRAME", name: "Old", w: 390, h: 400, layout: { mode: "VERTICAL" as const, gap: 16, padding: { top: 0, right: 0, bottom: 0, left: 0 } }, children: [
    { id: fake.id, type: "FRAME", name: "Rectangle 5", w: 342, h: 48, fills: ["#1a73e8"], layout: { mode: "HORIZONTAL" as const }, children: [{ id: label.id, type: "TEXT", name: "t", text: { chars: "Continue", fontSize: 16 } }] },
  ] };
  const a = analyzeDesign(fixtureDs(), snap);
  const report = await applyTransformations(a.transformations);
  assert.deepEqual(report.failed, []);
  assert.equal(frame.boundVariables.itemSpacing.id, "v2");
  assert.equal(frame.children.length, 2);
  const inst = frame.children[0];
  assert.equal(inst.type, "INSTANCE");
  assert.equal(inst.componentProperties["Label#10:0"].value, "Continue");
  assert.equal(fake.visible, false);
  assert.equal(fake.removed, false);
  assert.match(fake.name, /replaced/);
});
