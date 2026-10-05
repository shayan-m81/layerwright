// figma_export_image: the picture the agent sees can also be written to disk, so it can be shown to the user.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FigmaTransport } from "../src/bridge.ts";
import { createServer } from "../src/server.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function connect(work: string) {
  const bridge: FigmaTransport = {
    connected: () => true,
    info: () => ({ type: "hello", fileName: "TEST", page: "Page 1" }),
    request: async (method: string) => {
      if (method !== "exportImage") throw new Error(`unexpected ${method}`);
      return { base64: PNG.toString("base64"), format: "png", width: 640, height: 360, scale: 0.5, name: "Candidate Profile -> Justification" } as any;
    },
  };
  const server = createServer(bridge, { workdir: work, noUpdateCheck: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name: "figma_export_image", arguments: { nodeId: "1:2", ...args } });
    return { image: r.content.find((c: any) => c.type === "image"), info: JSON.parse(r.content.find((c: any) => c.type === "text").text) };
  };
}

test("without save the image is only returned, and the agent is told the user can't see it", async () => {
  const work = mkdtempSync(join(tmpdir(), "lw-export-"));
  const call = await connect(work);
  const r = await call({});
  assert.equal(r.image.mimeType, "image/png");
  assert.equal(r.info.file, undefined);
  assert.match(r.info.next, /save: true/);
  assert.equal(existsSync(join(work, ".layerwright", "exports")), false);
});

test("save: true writes .layerwright/exports/<node>.png; a folder or a file path is honoured", async () => {
  const work = mkdtempSync(join(tmpdir(), "lw-export-"));
  const call = await connect(work);

  const a = await call({ save: true });
  assert.equal(a.info.file, join(work, ".layerwright", "exports", "Candidate-Profile-Justification.png"));
  assert.deepEqual(readFileSync(a.info.file), PNG);
  assert.equal(a.image.mimeType, "image/png", "the agent still sees the picture");

  mkdirSync(join(work, "shots"));
  const b = await call({ save: "shots" });
  assert.equal(b.info.file, join(work, "shots", "Candidate-Profile-Justification.png"));

  const c = await call({ save: "out/hero.png" });
  assert.equal(c.info.file, join(work, "out", "hero.png"));
  assert.deepEqual(readFileSync(c.info.file), PNG);
});
