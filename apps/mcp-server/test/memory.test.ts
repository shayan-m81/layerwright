import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, redact, reportDraft } from "../src/memory.ts";
import { compilePlan, validatePlan, enrichDesignSystem } from "@cde/core";
import { fixtureDs } from "../../../packages/core/test/fixture.ts";

test("memory: fonts, mappings, component choices and notes persist; recurring problems come with a hint", () => {
  const file = join(mkdtempSync(join(tmpdir(), "lw-mem-")), ".layerwright", "memory.json");
  const m = new MemoryStore(file);
  m.rememberFonts({ YekanBakh: "IRANYekanX" });
  m.rememberMappings([{ selector: ".btn", component: "Button" }]);
  m.rememberMappings([{ selector: ".btn", component: { id: "9:1" } }]);
  m.rememberComponent("Accordion", "9:1");
  m.note("Use the Fa styles for Persian text");
  for (let i = 0; i < 3; i++) m.problem("figma_apply_transformations", "FIGMA_API_ERROR", 'The font "IRANYekanX Medium" could not be loaded');
  const again = new MemoryStore(file).read();
  assert.deepEqual(again.fontMap, { YekanBakh: "IRANYekanX" });
  assert.deepEqual(again.mappings, [{ selector: ".btn", component: { id: "9:1" } }]);
  const s = new MemoryStore(file).summary()!;
  assert.deepEqual(s.components, { Accordion: "9:1" });
  assert.equal(s.recurring![0].times, 3);
  assert.match(s.recurring![0].hint!, /layerwright fonts/);
});

test("a remembered choice resolves same-named components without asking again", () => {
  const base = fixtureDs();
  const set = (id: string) => ({ id, key: `k${id}`, name: "Accordion", remote: false, variantIds: [`${id}.0`], properties: [{ key: "State", name: "State", type: "VARIANT" as const, options: ["Open"] }] });
  const comp = (id: string) => ({ id: `${id}.0`, key: `k${id}.0`, name: "State=Open", remote: false, componentSetId: id, variants: { State: "Open" } });
  const ds = enrichDesignSystem({ ...base, componentSets: [...base.componentSets, set("8:1"), set("9:1")], components: [...base.components, comp("8:1"), comp("9:1")] });
  const v = validatePlan({ name: "p", screens: [{ type: "component", component: "Accordion", variant: "Open" }] });
  assert.ok(v.success);
  assert.equal(compilePlan(ds, v.plan).errors[0]?.type, "AMBIGUOUS_COMPONENT");
  const c = compilePlan(ds, v.plan, { preferred: { Accordion: "9:1" } });
  assert.deepEqual(c.errors, []);
  assert.equal((c.plan!.roots[0] as any).componentId, "9:1.0");
});

test("report: a redacted issue draft (no texts, names, ids, paths) with a prefilled GitHub link", () => {
  assert.equal(redact('Component "Accordion" 12:34 at /Users/me/x/y.html: متن نامرتبط'), 'Component "…" <id> at <path>: …');
  // Apostrophes aren't quotes: the reason stays readable.
  assert.equal(redact(`Text style "Body/M" can't be applied: its library isn't enabled for this file.`), `Text style "…" can't be applied: its library isn't enabled for this file.`);
  assert.equal(redact("layer 'Hero title' is hidden"), 'layer "…" is hidden');
  const d = reportDraft({ version: 1, fontMap: {}, mappings: [], components: {}, notes: [], problems: [
    { at: "", tool: "figma_execute_plan", type: "VERIFICATION", message: '2 mismatch(es): size far from the source\'s rendered box' },
    { at: "", tool: "figma_execute_plan", type: "VERIFICATION", message: '1 mismatch(es): "Card" size' } ] }, { version: "0.2.0", node: "22", os: "darwin arm64" });
  assert.match(d.title, /VERIFICATION in figma_execute_plan/);
  assert.match(d.body, /× 2/);
  assert.doesNotMatch(d.body, /Card/);
  assert.match(d.url, /^https:\/\/github\.com\/shayan-m81\/layerwright\/issues\/new\?title=/);
});

test("prefs: the language the user chose is kept for every project; a Figma window used lately counts for two weeks", async () => {
  process.env.LAYERWRIGHT_HOME = mkdtempSync(join(tmpdir(), "lw-prefs-"));
  const { readPrefs, writePrefs, figmaUsedRecently } = await import("../src/prefs.ts");
  assert.deepEqual(readPrefs(), {});
  writePrefs({ language: "Persian" });
  writePrefs({ figmaSeenAt: new Date(Date.UTC(2026, 9, 1)).toISOString() });
  assert.equal(readPrefs().language, "Persian", "one write doesn't lose the other");
  assert.equal(figmaUsedRecently(readPrefs(), Date.UTC(2026, 9, 10)), true);
  assert.equal(figmaUsedRecently(readPrefs(), Date.UTC(2026, 9, 20)), false);
  writePrefs({ language: "" });
  assert.equal(readPrefs().language, undefined, "an empty language clears it");
  delete process.env.LAYERWRIGHT_HOME;
});
