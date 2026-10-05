import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { WsBridge } from "../src/bridge.ts";

test("progress from the plugin keeps a long request alive; silence still times out, naming the last progress", async () => {
  const bridge = new WsBridge(7335, () => {});
  await bridge.start();
  const ws = new WebSocket("ws://127.0.0.1:7335");
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "hello", fileName: "F", page: "P" }));
  ws.on("message", (m) => {
    const req = JSON.parse(String(m));
    if (req.method === "scanDesignSystem") {
      // 400ms of work against a 150ms timeout, reporting progress every 60ms.
      let n = 0;
      const t = setInterval(() => { ws.send(JSON.stringify({ type: "progress", label: "Finding library components", done: ++n, total: 6 })); }, 60);
      setTimeout(() => { clearInterval(t); ws.send(JSON.stringify({ id: req.id, ok: true, result: { done: true } })); }, 400);
    }
    // "inspect" never answers.
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await bridge.request("scanDesignSystem", {}, 150), { done: true });
  await assert.rejects(bridge.request("inspect", {}, 120), (e: any) => e.detail.type === "TIMEOUT" && /without progress\. Its last progress was "Finding library components"/.test(e.detail.message));
  ws.close(); bridge.close();
});

test("direct mode: a web page can't reach the bridge, and its status never carries the pairing key", async () => {
  const bridge = new WsBridge(7336, () => {});
  await bridge.start();
  const refused = (path: string, origin: string) => new Promise<boolean>((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:7336${path}`, { origin });
    ws.on("unexpected-response", () => done(true));
    ws.on("error", () => done(true));
    ws.on("open", () => { ws.close(); done(false); });
  });
  assert.equal(await refused("/doctor", "https://evil.example"), true);
  assert.equal(await refused("/", "https://evil.example"), true);
  const plugin = new WebSocket("ws://127.0.0.1:7336", { origin: "null" }); // the Figma plugin window
  await new Promise((r) => plugin.on("open", r));
  plugin.send(JSON.stringify({ type: "hello", fileName: "F", page: "P", key: "secret" }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bridge.info()?.fileName, "F");
  assert.equal((bridge.info() as any).key, undefined);
  const status: any = await new Promise((done) => { const ws = new WebSocket("ws://127.0.0.1:7336/doctor"); ws.on("message", (m) => done(JSON.parse(String(m)))); });
  assert.equal(status.pluginConnected, true);
  assert.doesNotMatch(JSON.stringify(status), /secret/);
  plugin.close(); bridge.close();
});
