import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResolvedPlan } from "@cde/core";
import { inlineImages } from "../src/images.ts";

const plan = (src: string): ResolvedPlan => ({ planId: "p", name: "t", target: {}, roots: [{ kind: "frame", role: "screen", path: "s", name: "S", children: [{ kind: "rect", role: "image", path: "s.i", name: "I", src, fit: "FILL" }] }] });
const fake = (status: number, type: string, bytes = [0x89, 0x50]) => (async () => new Response(new Uint8Array(bytes), { status, headers: { "content-type": type } })) as unknown as typeof fetch;

test("https images are inlined as data URLs in Node, not fetched by the plugin", async () => {
  const r = await inlineImages(plan("https://example.com/a.png"), fake(200, "image/png"));
  const img = (r.plan.roots[0] as any).children[0];
  assert.equal(img.src, "data:image/png;base64,iVA=");
  assert.deepEqual(r.warnings, []);
});

test("unsupported or failed images drop to a placeholder with a warning", async () => {
  for (const f of [fake(404, "image/png"), fake(200, "image/webp"), fake(200, "text/html")]) {
    const r = await inlineImages(plan("https://example.com/a"), f);
    assert.equal((r.plan.roots[0] as any).children[0].src, undefined);
    assert.equal(r.warnings.length, 1);
  }
});

test("images inside inserts (nodes added into existing frames) are inlined too", async () => {
  const p: ResolvedPlan = { ...plan("https://example.com/a.png"), inserts: [{ parentId: "1:2", roots: [{ kind: "rect", role: "image", path: "inserts[0].i", name: "I", src: "https://example.com/b.png", fit: "FILL" }] }] };
  const r = await inlineImages(p, fake(200, "image/png"));
  assert.equal((r.plan.inserts![0].roots[0] as any).src, "data:image/png;base64,iVA=");
  assert.equal(r.plan.inserts![0].parentId, "1:2");
});
