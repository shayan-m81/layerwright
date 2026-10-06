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
import { currentTask } from "../src/task.ts";

process.env.LAYERWRIGHT_HOME = mkdtempSync(join(tmpdir(), "lw-links-"));
delete process.env.CLAUDE_CODE_SESSION_ID;

const SHOP: BridgeHello = { type: "hello", fileName: "Shop app", fileKey: "SHOPKEY12345", page: "Home" };
const BLOG: BridgeHello = { type: "hello", fileName: "Blog", fileKey: "BLOGKEY12345", page: "Posts" };

async function connect(o: { hello?: BridgeHello; files?: BridgeHello[] } = {}) {
  let hello = o.hello ?? SHOP;
  const current = () => hello;
  const files = o.files ?? [hello];
  let moved: { from: string; to: string } | undefined;
  const taskFiles: Record<string, BridgeHello> = {};
  const sent: { method: string; params: any }[] = [];
  const bridge: FigmaTransport = {
    connected: () => true,
    info: () => (currentTask() && taskFiles[currentTask()!]) || hello,
    request: (async (method: string, params?: any): Promise<any> => {
      sent.push({ method, params });
      const hello = (currentTask() && taskFiles[currentTask()!]) || current(); // a request's work goes to its window
      if (method === "ping") return { fileName: hello.fileName, page: hello.page };
      if (method === "refs") {
        const nodes = params?.nodeIds?.length ? params.nodeIds.map((id: string) => ({ id, name: `Layer ${id}`, type: "FRAME", page: "Home" }))
          : params?.target === "page" ? [{ id: "0:1", name: "Home", type: "PAGE", page: "Home" }] : [{ id: "12:34", name: "Hero", type: "FRAME", page: "Home" }];
        return { fileKey: hello.fileKey, fileName: hello.fileName, page: { id: "0:1", name: hello.page }, nodes };
      }
      if (method === "select") return { selected: params.nodeIds.length, page: hello.page };
      if (method === "inspect") return { page: hello.page, nodes: [{ id: params.target, type: "FRAME", name: "x", x: 0, y: 0, w: 1, h: 1 }] };
      if (method === "executePlan") return { createdRootIds: ["9:1"], nodeIds: {}, warnings: [], page: { id: "0:1", name: hello.page } };
      return {};
    }) as FigmaTransport["request"],
    windows: async () => files.map((f) => ({ file: f.fileName, fileKey: f.fileKey, page: f.page, current: f === hello })),
    bind: async (file: string) => {
      const f = files.find((x) => x.fileKey === file || x.fileName === file || (!!x.fileKey && file.includes(x.fileKey)));
      if (f) hello = f;
      return { ok: !!f, files: files.map((x) => x.fileName) };
    },
    takeMoved: () => { const m = moved; moved = undefined; return m; },
  };
  const server = createServer(bridge, { workdir: mkdtempSync(join(tmpdir(), "lw-links-w-")), noUpdateCheck: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as any;
    return { json: JSON.parse(r.content[0].text), isError: !!r.isError, more: r.content.slice(1).map((c: any) => JSON.parse(c.text)) };
  };
  return { call, sent, files, now: () => hello, move: (m: { from: string; to: string }) => { moved = m; }, taskFiles };
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

test("a link copied in Figma teaches a plugin that can't read its key, however Figma wrote the name; a link to another file teaches nothing", async () => {
  const t = await connect({ hello: { type: "hello", fileName: "Talent Club - Evaluation (Copy)", page: "Home" } });
  const other = await t.call("figma_select", { nodeIds: ["https://www.figma.com/design/WISHLISTKEY1/Wishlist---Guest?node-id=1-2"] });
  assert.ok(other.isError);
  assert.match(other.json.errors[0].message, /That link is to the Figma file "Wishlist Guest", not "Talent Club - Evaluation \(Copy\)"/);
  assert.equal((await t.call("figma_link")).json.errors[0].type, "FILE_KEY_UNKNOWN", "its key isn't this file's");
  const own = await t.call("figma_select", { nodeIds: ["https://www.figma.com/design/TALENTKEY123/Talent-Club---Evaluation--Copy-?node-id=8071-1674&t=AbC-1"] });
  assert.ok(!own.isError, JSON.stringify(own.json));
  assert.deepEqual(t.sent.at(-1), { method: "select", params: { nodeIds: ["8071:1674"] } });
  assert.match((await t.call("figma_link")).json.links[0].link, /^https:\/\/www\.figma\.com\/design\/TALENTKEY123\//);
});

test("links in edit ops and plan targets are the layers they point at; one call with links to two files is refused before Figma hears of it", async () => {
  const t = await connect({ files: [SHOP, BLOG] });
  const link = (key: string, node: string) => `https://www.figma.com/design/${key}/x?node-id=${node}`;
  await t.call("figma_edit", { ops: [{ op: "rename", node: link("SHOPKEY12345", "1-2"), name: "A" }, { op: "move", node: "3:4", parent: link("SHOPKEY12345", "5-6") }], approved: true });
  assert.deepEqual(t.sent.at(-1)!.params.ops.map((o: any) => [o.node, o.parent]), [["1:2", undefined], ["3:4", "5:6"]]);
  const sent = t.sent.length;
  const mixed = await t.call("figma_edit", { ops: [{ op: "move", node: link("SHOPKEY12345", "1-2"), parent: link("BLOGKEY12345", "5-6") }], approved: true });
  assert.ok(mixed.isError);
  assert.match(mixed.json.errors[0].message, /different Figma files/);
  assert.equal(t.sent.length, sent, "nothing was sent");
  assert.equal(t.now().fileName, "Shop app", "and the session didn't move");
  // A plan's own text may mention any link: only its target is a layer.
  const plan = { name: "Note", target: { parentId: link("SHOPKEY12345", "7-8") }, screens: [{ type: "text", content: `See ${link("BLOGKEY12345", "1-1")}` }] };
  const p = await t.call("figma_preview_plan", { plan });
  assert.ok(!p.isError, JSON.stringify(p.json));
  assert.equal(t.now().fileName, "Shop app");
});

test("a plan is built in the file it was previewed in, or not at all", async () => {
  const t = await connect({ files: [SHOP, BLOG] });
  const plan = { name: "Card", screens: [{ type: "frame", name: "Card" }] };
  const { json: { planId } } = await t.call("figma_preview_plan", { plan });
  await t.call("figma_status", { file: "Blog" });
  const run = await t.call("figma_execute_plan", { planId });
  assert.ok(!run.isError, JSON.stringify(run.json));
  assert.equal(t.now().fileName, "Shop app", "back to the plan's file");
  assert.deepEqual(run.json.links, ["https://www.figma.com/design/SHOPKEY12345/Shop-app?node-id=9-1"]);
  // Previewed in Blog, and Blog's window is gone: refused, nothing built in Shop.
  await t.call("figma_status", { file: "Blog" });
  const again = (await t.call("figma_preview_plan", { plan })).json.planId;
  t.files.splice(t.files.indexOf(BLOG), 1);
  await t.call("figma_status", { file: "Shop app" });
  const runs = t.sent.filter((x) => x.method === "executePlan").length;
  const refused = await t.call("figma_execute_plan", { planId: again });
  assert.ok(refused.isError);
  assert.match(refused.json.errors[0].message, /made for the Figma file "Blog"/);
  assert.equal(t.sent.filter((x) => x.method === "executePlan").length, runs);
});

test("a session the hub moved to another file is told in its next tool result, once", async () => {
  const t = await connect({ files: [SHOP, BLOG] });
  t.move({ from: "Shop app", to: "Blog" });
  const r = await t.call("figma_link");
  assert.equal(r.more.find((x: any) => x.movedToFile)?.movedToFile, "Blog");
  assert.match(r.more.find((x: any) => x.movedToFile).note, /Node ids and plans from "Shop app" don't apply here/);
  assert.equal((await t.call("figma_link")).more.find((x: any) => x.movedToFile), undefined);
});

test("work for a request from a Figma window stays in that window's file: its links are read there, a link to another file is refused", async () => {
  const t = await connect({ files: [SHOP, BLOG] });
  t.taskFiles.q1 = BLOG; // the user sent q1 from the Blog window; the session works in Shop
  await t.call("figma_select", { nodeIds: ["https://www.figma.com/design/BLOGKEY12345/Blog?node-id=4-4"], requestId: "q1" });
  assert.deepEqual(t.sent.at(-1), { method: "select", params: { nodeIds: ["4:4"] } });
  assert.equal(t.now().fileName, "Shop app", "the session didn't move: the link is the request's own file");
  const other = await t.call("figma_select", { nodeIds: ["https://www.figma.com/design/SHOPKEY12345/Shop-app?node-id=1-2"], requestId: "q1" });
  assert.ok(other.isError);
  assert.match(other.json.errors[0].message, /This request came from the Figma file "Blog", and that link is to another file/);
  assert.equal(t.now().fileName, "Shop app");
  const link = await t.call("figma_link", { nodeIds: ["4:4"], requestId: "q1" });
  assert.equal(link.json.links[0].link, "https://www.figma.com/design/BLOGKEY12345/Blog?node-id=4-4");
});

test("a link with no file name can't teach a key", async () => {
  const t = await connect({ hello: { type: "hello", fileName: "Shop app", page: "Home" } });
  const r = await t.call("figma_select", { nodeIds: ["https://www.figma.com/design/LEARNEDKEY12"] });
  assert.ok(r.isError);
  assert.match(r.json.errors[0].message, /doesn't name its file/);
});
