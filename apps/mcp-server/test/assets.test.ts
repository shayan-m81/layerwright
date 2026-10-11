// figma_import_assets: files and folders of icons and pictures → one plan → built by the real plugin code on the strict
// Figma mock, SVGs as vectors (and components), pictures as image fills.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { imageSize, svgSize } from "../src/assets.ts";
import { launch } from "@cde/html-import";

const fixtures = fileURLToPath(new URL("../../../packages/html-import/test/fixtures/assets/", import.meta.url));
let browserOk = true;
try { await (await launch()).close(); } catch { browserOk = false; }

test("sizes from the files themselves: an SVG's width/height or viewBox, a PNG's, GIF's or JPEG's header", () => {
  assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="32px" height="16"></svg>'), { w: 32, h: 16 });
  assert.deepEqual(svgSize('<svg viewBox="0 0 24 12"></svg>'), { w: 24, h: 12 });
  assert.deepEqual(svgSize('<svg width="100%" viewBox="0 0 10 10"></svg>'), { w: 10, h: 10 });
  assert.deepEqual(svgSize("<svg></svg>"), { w: 24, h: 24 });
  const png = Buffer.alloc(24); png.set([0x89, 0x50, 0x4e, 0x47]); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(png), { w: 640, h: 480 });
  assert.deepEqual(imageSize(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x00, 0x10, 0x00])), { w: 32, h: 16 });
  // JPEG: SOI, an APP0 segment to skip, then SOF0 with height 300 and width 400.
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { w: 400, h: 300 });
});

test("figma_import_assets: a folder of icons and pictures becomes vectors and images in a grid, SVGs components on request", { skip: !browserOk && "no Chromium (WebP decoding)" }, async () => {
  // The plugin's own code on its strict mock, loaded by path: this package is type-checked without Figma's types.
  const plugin = (f: string) => import(new URL(`../../figma-plugin/${f}`, import.meta.url).href);
  const { resetFigma } = await plugin("test/figma-mock.ts");
  const { executePlan } = await plugin("src/execute.ts");
  const { editNodes } = await plugin("src/edit.ts");
  const work = mkdtempSync(join(tmpdir(), "lw-assets-"));
  mkdirSync(join(work, "icons/arrows"), { recursive: true });
  copyFileSync(join(fixtures, "logo.svg"), join(work, "icons/logo.svg"));
  writeFileSync(join(work, "icons/arrows/left.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" stroke="#111111" fill="none"/></svg>');
  copyFileSync(join(fixtures, "photo.png"), join(work, "icons/photo.png"));
  copyFileSync(join(fixtures, "photo.webp"), join(work, "icons/photo.webp"));
  writeFileSync(join(work, "icons/notes.txt"), "not an asset");
  mkdirSync(join(work, "icons/node_modules"));
  writeFileSync(join(work, "icons/node_modules/skip.svg"), "<svg></svg>");

  const page = resetFigma();
  const calls: string[] = [];
  const bridge = {
    info: () => ({ fileName: "Assets test", page: "Page 1" }),
    request: async (method: string, params: any) => {
      calls.push(method);
      if (method === "executePlan") return executePlan(params.plan);
      if (method === "editNodes") return editNodes(params);
      return {};
    },
  } as any;
  const server = createServer(bridge, { workdir: work, noUpdateCheck: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (args: Record<string, unknown>) => { const r: any = await client.callTool({ name: "figma_import_assets", arguments: args }); return { json: JSON.parse(r.content[0].text), isError: !!r.isError }; };

  const r = await call({ paths: ["icons"], components: true });
  assert.equal(r.isError, false, JSON.stringify(r.json));
  assert.deepEqual(r.json.imported, { vectors: 2, images: 2 });
  assert.equal(r.json.components, 2);
  assert.deepEqual(calls, ["executePlan", "editNodes"]);
  const section = page.children.find((n: any) => n.type === "SECTION");
  assert.equal(section.name, "Assets");
  const grid = section.children[0];
  assert.equal(grid.layoutWrap, "WRAP");
  assert.deepEqual(grid.children.map((n: any) => `${n.type}:${n.name}`), ["COMPONENT:arrows/left", "COMPONENT:logo", "RECTANGLE:photo", "RECTANGLE:photo"],
    "named by their path in the folder, sorted; node_modules and other files left out");
  assert.ok(grid.children.filter((n: any) => n.type === "RECTANGLE").every((n: any) => n.fills[0].type === "IMAGE"), "the WebP was decoded to PNG");
  assert.deepEqual([grid.children[1].width, grid.children[1].height], [32, 32], "an SVG keeps its own size");

  // One file; nothing usable is an error that says what's accepted.
  const one = await call({ paths: ["icons/photo.png"], name: "Photos", maxSize: 20 });
  assert.deepEqual(one.json.imported, { vectors: 0, images: 1 });
  const photos = page.children.filter((n: any) => n.type === "SECTION").find((n: any) => n.name === "Photos");
  assert.deepEqual([photos.children[0].children[0].width, photos.children[0].children[0].height], [20, 12], "shrunk to maxSize, in proportion");
  const none = await call({ paths: ["icons/notes.txt"] });
  assert.equal(none.isError, true);
  assert.match(JSON.stringify(none.json), /No SVG, PNG, JPEG, GIF, WebP or AVIF files/);
});
