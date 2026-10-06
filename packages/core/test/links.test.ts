// Figma links: reading the ones the user pastes, and building them for a layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { figmaLink, linkSlug, parseFigmaLink, slugFits } from "../src/links.ts";

test("a pasted link gives the file and the layer, however Figma wrote it", () => {
  assert.deepEqual(parseFigmaLink("https://www.figma.com/design/zVxSm3xXO5iXrRSekDQz66/Talent-Club---Evaluation--Copy-?node-id=8071-1674&t=AbC-1"),
    { kind: "design", fileKey: "zVxSm3xXO5iXrRSekDQz66", nodeId: "8071:1674", slug: "Talent-Club---Evaluation--Copy-" });
  assert.equal(parseFigmaLink("figma.com/file/zVxSm3xXO5iXrRSekDQz66/Old?node-id=12%3A34")?.nodeId, "12:34", "older /file/ links, no https, node-id with a colon");
  assert.equal(parseFigmaLink("https://www.figma.com/design/zVxSm3xXO5iXrRSekDQz66/X?node-id=0-1")?.nodeId, "0:1", "a page");
  assert.deepEqual(parseFigmaLink("https://www.figma.com/design/zVxSm3xXO5iXrRSekDQz66/branch/BrAnCh1234567890/X?node-id=1-2"),
    { kind: "design", fileKey: "BrAnCh1234567890", nodeId: "1:2", slug: "X" }, "a branch: the branch's own key");
  assert.equal(parseFigmaLink("https://www.figma.com/proto/zVxSm3xXO5iXrRSekDQz66/X?node-id=5-6&starting-point-node-id=5%3A6")?.nodeId, "5:6");
  assert.deepEqual(parseFigmaLink("https://www.figma.com/design/zVxSm3xXO5iXrRSekDQz66"), { kind: "design", fileKey: "zVxSm3xXO5iXrRSekDQz66", nodeId: undefined, slug: undefined }, "the whole file");
  for (const bad of ["12:34", "Header", "https://example.com/design/zVxSm3xXO5iXrRSekDQz66/X", "https://www.figma.com/community/file/123", "not a url"]) assert.equal(parseFigmaLink(bad), undefined, bad);
});

test("a link to a layer reads back to the same file and layer", () => {
  const link = figmaLink({ fileKey: "zVxSm3xXO5iXrRSekDQz66", fileName: "Talent Club - Evaluation (Copy)", nodeId: "8071:1674" });
  assert.equal(link, "https://www.figma.com/design/zVxSm3xXO5iXrRSekDQz66/Talent-Club-Evaluation-Copy?node-id=8071-1674");
  assert.deepEqual(parseFigmaLink(link), { kind: "design", fileKey: "zVxSm3xXO5iXrRSekDQz66", nodeId: "8071:1674", slug: "Talent-Club-Evaluation-Copy" });
  assert.equal(figmaLink({ fileKey: "zVxSm3xXO5iXrRSekDQz66", fileName: "x", nodeId: "I1:2;3:4" }), "https://www.figma.com/design/zVxSm3xXO5iXrRSekDQz66/x?node-id=I1-2%3B3-4", "a layer inside an instance");
  assert.equal(parseFigmaLink(figmaLink({ fileKey: "zVxSm3xXO5iXrRSekDQz66", nodeId: "I1:2;3:4" }))?.nodeId, "I1:2;3:4");
  assert.equal(figmaLink({ fileKey: "zVxSm3xXO5iXrRSekDQz66" }), "https://www.figma.com/design/zVxSm3xXO5iXrRSekDQz66/Untitled");
  assert.equal(linkSlug("لیست آرزو / Guest"), "%D9%84%DB%8C%D8%B3%D8%AA-%D8%A2%D8%B1%D8%B2%D9%88-Guest", "any language, safely in the URL");
});

test("a link's name part is matched to a file's name the way Figma writes it", () => {
  const name = "Talent Club - Evaluation (Copy)";
  assert.ok(slugFits("Talent-Club---Evaluation--Copy-", name), "Figma's own link");
  assert.ok(slugFits(linkSlug(name), name), "a link Layerwright made");
  assert.ok(slugFits(parseFigmaLink(figmaLink({ fileKey: "zVxSm3xXO5iXrRSekDQz66", fileName: "لیست آرزو / Guest" }))?.slug, "لیست آرزو / Guest"), "any language");
  assert.ok(!slugFits("Talent-Club---Evaluation", name), "the original isn't its copy");
  assert.ok(!slugFits(undefined, name), "no name part: can't tell");
  assert.ok(!slugFits("Wishlist-Guest", name), "another file");
  assert.ok(!slugFits("Ta", name), "two letters are not a name");
  assert.equal(parseFigmaLink("https://www.figma.com/design/zVxSm3xXO5iXrRSekDQz66/100%-done?node-id=1-2")?.slug, "100%-done", "a name part that isn't valid percent-encoding doesn't throw");
});
