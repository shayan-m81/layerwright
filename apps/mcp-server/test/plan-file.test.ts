// figma_inspect format "plan" → figma_preview_plan, as in issue #8: without a Design System scan the export carries raw
// values and previews as it is; a big plan goes to a file in the project and is previewed from there (planFile).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NodeSnapshot } from "@cde/core";
import type { FigmaTransport } from "../src/bridge.ts";
import { createServer } from "../src/server.ts";

/** A desktop frame bound to tokens of a library this session hasn't scanned, with a pill and a styled text. */
const snap: NodeSnapshot = {
  id: "1:2", type: "FRAME", name: "Home / Desktop", w: 1200, h: 600, fills: ["#ffffff"], bound: { fills: "core/color/bg", itemSpacing: "core/space/4" },
  layout: { mode: "VERTICAL", gap: 16, padding: { top: 0, right: 0, bottom: 0, left: 0 }, sizingH: "FIXED", sizingV: "HUG" },
  children: [
    { id: "1:3", type: "FRAME", name: "Pill", w: 96, h: 32, radius: 33554400, fills: ["#176b66"], layout: { mode: "NONE", sizingH: "FIXED", sizingV: "FIXED" }, children: [] },
    { id: "1:4", type: "TEXT", name: "Title", w: 300, h: 40, fills: ["#101828"], layout: { mode: "NONE", sizingH: "HUG", sizingV: "HUG" },
      text: { chars: "Welcome", fontSize: 32, font: "Inter Bold", styleId: "S:9", style: "style/heading/xl", autoResize: "WIDTH_AND_HEIGHT" } },
  ],
};

async function connect(work: string) {
  const calls: { method: string; params: any }[] = [];
  const bridge: FigmaTransport = {
    connected: () => true,
    info: () => ({ type: "hello", fileName: "TEST", page: "Page 1" }),
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method !== "inspect") throw new Error(`unexpected ${method}`);
      return { page: "Page 1", nodes: [snap] } as any;
    },
  };
  const server = createServer(bridge, { workdir: work, noUpdateCheck: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
  };
  return { call, calls };
}

test("without a scan, a plan export has raw values (and a 9999 pill radius) and previews as it is", async () => {
  const { call, calls } = await connect(mkdtempSync(join(tmpdir(), "lw-plan-")));
  const r = await call("figma_inspect", { target: "1:2", format: "plan" });
  assert.equal(calls[0].params.plan, true, "the plugin is asked for a plan export (whole texts, styled runs)");
  assert.equal(r.data.values, "raw");
  assert.match(r.data.valuesNote, /No Design System scan is cached/);
  const root = r.data.plan.screens[0];
  assert.deepEqual([root.fill, root.layout.gap, root.children[0].radius, root.children[1].style, root.children[1].fontFamily], ["#FFFFFF", 16, 9999, undefined, "Inter"]);
  const p = await call("figma_preview_plan", { plan: r.data.plan });
  assert.ok(!p.isError, JSON.stringify(p.data));
  assert.match(p.data.planId, /^plan_/);
});

test("values: tokens without a scan keeps the names, and the preview says to scan or export raw values", async () => {
  const { call } = await connect(mkdtempSync(join(tmpdir(), "lw-plan-")));
  const r = await call("figma_inspect", { target: "1:2", format: "plan", values: "tokens" });
  assert.equal(r.data.values, "tokens");
  assert.equal(r.data.valuesNote, undefined);
  assert.equal(r.data.plan.screens[0].fill, "core/color/bg");
  const p = await call("figma_preview_plan", { plan: r.data.plan });
  assert.ok(p.isError);
  assert.equal(p.data.errors[0].type, "DESIGN_SYSTEM_NOT_SCANNED");
  assert.match(p.data.errors[0].message, /values: "raw"/);
});

test("save writes the plan to a file in the project instead of answering with it; figma_preview_plan reads it by planFile", async () => {
  const work = mkdtempSync(join(tmpdir(), "lw-plan-"));
  const { call } = await connect(work);
  const r = await call("figma_inspect", { target: "1:2", format: "plan", save: true });
  const file = join(work, ".layerwright", "exports", "Home-Desktop.plan.json");
  assert.equal(r.data.file, file);
  assert.equal(r.data.plan, undefined, "the plan isn't sent inline");
  assert.equal(r.data.bytes, readFileSync(file).length);
  assert.match(r.data.next, /figma_preview_plan\(\{ planFile: "\.layerwright\/exports\/Home-Desktop\.plan\.json" \}\)/);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.screens[0].children[0].radius, 9999);

  // Edited on disk, then previewed from the file: relative to the project, or absolute inside it.
  saved.screens[0].width = 390;
  writeFileSync(file, JSON.stringify(saved));
  const p = await call("figma_preview_plan", { planFile: ".layerwright/exports/Home-Desktop.plan.json" });
  assert.ok(!p.isError, JSON.stringify(p.data));
  const q = await call("figma_preview_plan", { planFile: file });
  assert.equal(q.data.planId, p.data.planId);

  // A folder (named, or ending in /) gets <name>.plan.json; a .json path is the file itself.
  mkdirSync(join(work, "plans"));
  assert.equal((await call("figma_inspect", { target: "1:2", format: "plan", save: "plans" })).data.file, join(work, "plans", "Home-Desktop.plan.json"));
  assert.equal((await call("figma_inspect", { target: "1:2", format: "plan", save: "mobile/" })).data.file, join(work, "mobile", "Home-Desktop.plan.json"));
  assert.equal((await call("figma_inspect", { target: "1:2", format: "plan", save: "plans/mobile.json" })).data.file, join(work, "plans", "mobile.json"));
});

test("save and planFile stay inside the project; preview takes a plan or a planFile, not both", async () => {
  const work = mkdtempSync(join(tmpdir(), "lw-plan-"));
  const outside = mkdtempSync(join(tmpdir(), "lw-outside-"));
  writeFileSync(join(outside, "x.json"), JSON.stringify({ name: "x", screens: [{ type: "frame" }] }));
  symlinkSync(outside, join(work, "link"));
  const { call, calls } = await connect(work);
  for (const save of ["../x.json", join(outside, "y.json"), "link/y.json"]) {
    const r = await call("figma_inspect", { target: "1:2", format: "plan", save });
    assert.ok(r.isError, save);
    assert.match(r.data.errors[0].message, /inside the project/);
  }
  assert.equal(calls.length, 0, "refused before Figma is asked");
  assert.equal(existsSync(join(outside, "y.json")), false);
  for (const planFile of ["../x.json", join(outside, "x.json"), "link/x.json"]) {
    const r = await call("figma_preview_plan", { planFile });
    assert.ok(r.isError, planFile);
    assert.match(r.data.errors[0].message, /planFile must be a file inside the project/);
  }
  assert.match((await call("figma_preview_plan", { planFile: "nope.plan.json" })).data.errors[0].message, /No plan file at/);
  assert.match((await call("figma_preview_plan", { plan: { name: "x", screens: [{ type: "frame" }] }, planFile: "a.json" })).data.errors[0].message, /plan .* or planFile .*, one of them/);
  assert.match((await call("figma_preview_plan", {})).data.errors[0].message, /one of them/);
  writeFileSync(join(work, "broken.json"), "{ nope");
  assert.match((await call("figma_preview_plan", { planFile: "broken.json" })).data.errors[0].message, /Malformed JSON/);
});
