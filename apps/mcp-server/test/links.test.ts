// Figma links in the tools: figma_link makes them, any layer argument takes one (in the open file, another open file,
// or a file whose plugin can't read its own key), and figma_status names the open files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BridgeHello } from "@cde/core";
import type { FigmaTransport } from "../src/bridge.ts";
import { createServer } from "../src/server.ts";

process.env.LAYERWRIGHT_HOME = mkdtempSync(join(tmpdir(), "lw-links-"));
delete process.env.CLAUDE_CODE_SESSION_ID;

const SHOP: BridgeHello = { type: "hello", fileName: "Shop app", fileKey: "SHOPKEY12345", page: "Home" };
const BLOG: BridgeHello = { type: "hello", fileName: "Blog", fileKey: "BLOGKEY12345", page: "Posts" };

async function connect(o: { hello?: BridgeHello; files?: BridgeHello[] } = {}) {
  let hello = o.hello ?? SHOP;
  const files = o.files ?? [hello];
  const sent: { method: string; params: any }[] = [];
  const bridge: FigmaTransport = {
    connected: () => true,
    info: () => hello,
    request: (async (method: string, params?: any): Promise<any> => {
      sent.push({ method, params });
      if (method === "ping") return { fileName: hello.fileName, page: hello.page };
      if (method === "refs") {
        const nodes = params?.nodeIds?.length ? params.nodeIds.map((id: string) => ({ id, name: `Layer ${id}`, type: "FRAME", page: "Home" }))
          : params?.target === "page" ? [{ id: "0:1", name: "Home", type: "PAGE", page: "Home" }] : [{ id: "12:34", name: "Hero", type: "FRAME", page: "Home" }];
        return { fileKey: hello.fileKey, fileName: hello.fileName, page: { id: "0:1", name: hello.page }, nodes };
      }
      if (method === "select") return { selected: params.nodeIds.length, page: hello.page };
      if (method === "inspect") return { page: hello.page, nodes: [{ id: params.target, type: "FRAME", name: "x", x: 0, y: 0, w: 1, h: 1 }] };
      return {};
    }) as FigmaTransport["request"],
    windows: async () => files.map((f) => ({ file: f.fileName, fileKey: f.fileKey, page: f.page, current: f === hello })),
    bind: async (file: string) => {
      const f = files.find((x) => x.fileKey === file || x.fileName === file || (!!x.fileKey && file.includes(x.fileKey)));
      if (f) hello = f;
      return { ok: !!f, files: files.map((x) => x.fileName) };
    },
  };
  const server = createServer(bridge, { workdir: mkdtempSync(join(tmpdir(), "lw-links-w-")), noUpdateCheck: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as any;
    return { json: JSON.parse(r.content[0].text), isError: !!r.isError };
  };
  return { call, sent, now: () => hello };
}

test("figma_link: links to the selection, layers or the page, and the file's own link", async () => {
  const t = await connect();
  const sel = await t.call("figma_link");
  assert.equal(sel.json.fileLink, "https://www.figma.com/design/SHOPKEY12345/Shop-app");
  assert.deepEqual(sel.json.links, [{ name: "Hero", type: "FRAME", page: "Home", link: "https://www.figma.com/design/SHOPKEY12345/Shop-app?node-id=12-34" }]);
  const page = await t.call("figma_link", { target: "page" });
  assert.equal(page.json.links[0].link, "https://www.figma.com/design/SHOPKEY12345/Shop-app?node-id=0-1");
  const two = await t.call("figma_link", { nodeIds: ["1:2", "3:4"] });
  assert.deepEqual(two.json.links.map((l: any) => l.link.split("node-id=")[1]), ["1-2", "3-4"]);
  const status = await t.call("figma_status");
  assert.equal(status.json.fileLink, "https://www.figma.com/design/SHOPKEY12345/Shop-app");
});

test("a link anywhere a layer goes: the layer it points at; a link to a page opens it; a whole-file link isn't a layer", async () => {
  const t = await connect();
  await t.call("figma_select", { nodeIds: ["https://www.figma.com/design/SHOPKEY12345/Shop-app?node-id=12-34&t=x"] });
  assert.deepEqual(t.sent.at(-1), { method: "select", params: { nodeIds: ["12:34"] } });
  await t.call("figma_inspect", { target: "figma.com/design/SHOPKEY12345/Shop-app?node-id=5-6" });
  assert.equal(t.sent.at(-1)!.params.target, "5:6");
  await t.call("figma_inspect", { target: "https://www.figma.com/design/SHOPKEY12345/Shop-app" });
  assert.equal(t.sent.at(-1)!.params.target, "page", "the whole file: the page that's open");
  const whole = await t.call("figma_select", { nodeIds: ["https://www.figma.com/design/SHOPKEY12345/Shop-app"] });
  assert.ok(whole.isError);
  assert.match(whole.json.errors[0].message, /whole file, not a layer/);
  const sel = await t.call("figma_select", { nodeIds: ["7:8"] });
  assert.deepEqual(sel.json.links, ["https://www.figma.com/design/SHOPKEY12345/Shop-app?node-id=7-8"], "and it says where it is");
});

test("a link to another open file moves the session there; a file that isn't open is said plainly", async () => {
  const t = await connect({ files: [SHOP, BLOG] });
  const status = await t.call("figma_status");
  assert.deepEqual(status.json.files, [{ file: "Shop app", page: "Home", current: true }, { file: "Blog", page: "Posts" }]);
  assert.match(status.json.filesNote, /Several Figma files are open/);
  await t.call("figma_inspect", { target: "https://www.figma.com/design/BLOGKEY12345/Blog?node-id=9-9" });
  assert.equal(t.now().fileName, "Blog", "the session works in the link's file now");
  assert.equal(t.sent.at(-1)!.params.target, "9:9");
  const gone = await t.call("figma_select", { nodeIds: ["https://www.figma.com/design/OTHERKEY1234/Other?node-id=1-1"] });
  assert.ok(gone.isError);
  assert.match(gone.json.errors[0].message, /another Figma file than "Blog"\. Open that file in Figma and run the Layerwright plugin there/);
  const byName = await t.call("figma_status", { file: "Shop app" });
  assert.equal(byName.json.file, "Shop app");
  const none = await t.call("figma_status", { file: "Nope" });
  assert.ok(none.isError);
  assert.match(none.json.errors[0].message, /No open Layerwright window shows "Nope"\. .* Open now: Shop app, Blog\./);
});

test("a plugin that can't read its file's key: a link the user pastes teaches it, and links work from then on", async () => {
  const t = await connect({ hello: { type: "hello", fileName: "Shop app", page: "Home" } });
  const before = await t.call("figma_link");
  assert.ok(before.isError);
  assert.equal(before.json.errors[0].type, "FILE_KEY_UNKNOWN");
  assert.match(before.json.errors[0].message, /paste any link from this file once/);
  await t.call("figma_select", { nodeIds: ["https://www.figma.com/design/LEARNEDKEY12/Shop-app?node-id=1-2"] });
  const after = await t.call("figma_link");
  assert.equal(after.json.links[0].link, "https://www.figma.com/design/LEARNEDKEY12/Shop-app?node-id=12-34");
});
