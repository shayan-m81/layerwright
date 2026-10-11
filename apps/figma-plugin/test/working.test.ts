// "Claude is working": a toast (never a layer, never an undo step) while a session works, renewed by every call, and
// "thinking…" between its steps until it's done.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { host, resetFigma } from "./figma-mock.ts";

resetFigma();
const { working, workingClear, workingStill, workingText, workingTurn, FLICKER_MS, WORKING_MS, THINK_MS, TURN_MS, DONE_MS } = await import("../src/working.ts");
const open = () => host.toasts.filter((t) => t.open);
beforeEach(() => { workingClear(); resetFigma(); });

test("each call says what it does, in the session's name; status checks and links say nothing", () => {
  assert.equal(workingText("Checkout", "scanDesignSystem", {}), "✦ Checkout · scanning the Design System…");
  assert.equal(workingText("Checkout", "inspect", { target: "page" }), "✦ Checkout · reading the page…");
  assert.equal(workingText(undefined, "inspect", { target: "1:2" }), "✦ Claude · reading layers…");
  assert.equal(workingText("Checkout", "exportImage", {}), "✦ Checkout · taking a picture…");
  working("Checkout", "ping", {}, true, 1000);
  working("Checkout", "refs", {}, true, 1000);
  assert.equal(host.toasts.length, 0);
});

test("one toast at a time: a new step replaces it; the same step a moment later leaves it up; it's renewed before it times out", () => {
  working("Checkout", "scanDesignSystem", {}, true, 1000);
  assert.deepEqual(open().map((t) => [t.text, t.timeout]), [["✦ Checkout · scanning the Design System…", WORKING_MS]]);
  working("Checkout", "inspect", {}, true, 1500);
  assert.deepEqual(open().map((t) => t.text), ["✦ Checkout · reading layers…"], "replaced, not stacked");
  working("Checkout", "inspect", {}, true, 2000);
  assert.equal(host.toasts.length, 2, "the same words a moment later: left up (no jump)");
  working("Checkout", "inspect", {}, true, 1500 + WORKING_MS / 2 + 10);
  assert.equal(host.toasts.length, 3, "renewed before Figma closes it");
  assert.equal(open().length, 1);
});

test("the AI cursor switch covers it: off, nothing shows; turning it off takes the toast down", () => {
  working("Checkout", "editNodes", {}, false, 1000);
  assert.equal(host.toasts.length, 0);
  working("Checkout", "editNodes", {}, true, 1000);
  assert.equal(open().length, 1);
  workingClear();
  assert.equal(open().length, 0);
});

test("a long step that reports progress keeps it up; nothing working, progress shows nothing", () => {
  workingStill(1000);
  assert.equal(host.toasts.length, 0, "no toast to keep");
  working("Checkout", "executePlan", {}, true, 1000);
  for (let t = 2000; t <= 30_000; t += 1000) workingStill(t);
  assert.equal(open().length, 1);
  assert.ok(host.toasts.length >= 30_000 / WORKING_MS, "renewed all along a 30-second build");
  assert.ok(open().every((x) => x.text === "✦ Checkout · building…"));
});

test("two sessions at once: the other session's step waits a moment instead of flickering; the same session's next step shows at once", () => {
  working("Checkout", "editNodes", {}, true, 1000);
  working("Blog", "inspect", {}, true, 1200);
  assert.deepEqual(open().map((t) => t.text), ["✦ Checkout · editing layers…"], "kept a moment");
  working("Checkout", "exportImage", {}, true, 1300);
  assert.deepEqual(open().map((t) => t.text), ["✦ Checkout · taking a picture…"], "its own next step");
  working("Blog", "inspect", {}, true, 1300 + FLICKER_MS);
  assert.deepEqual(open().map((t) => t.text), ["✦ Blog · reading layers…"], "then the other one's");
});

test("between steps it says the session is thinking, until its next step; a quiet session's goes after a while", () => {
  working("Checkout", "inspect", {}, true, 1000, "s1");
  open()[0].expire(); // the step's toast ran out: the session is between steps
  assert.deepEqual(open().map((t) => [t.text, t.timeout]), [["✦ Checkout · thinking…", THINK_MS]]);
  working("Checkout", "editNodes", {}, true, 9000, "s1");
  assert.deepEqual(open().map((t) => t.text), ["✦ Checkout · editing layers…"], "its next step takes over");
  open()[0].expire();
  open()[0].expire(); // quiet for THINK_MS
  assert.equal(open().length, 0, "then it goes");
});

test("a session whose turn end Figma hears about: thinking until then, then done ✓, and no thinking after it", () => {
  workingTurn("s1", "Checkout", false, undefined, 500); // its hooks tell the window what it does in its chat
  working("Checkout", "inspect", {}, true, 1000, "s1");
  open()[0].expire();
  assert.deepEqual(open().map((t) => [t.text, t.timeout]), [["✦ Checkout · thinking…", TURN_MS]], "it says when it's done: thinking lasts until then");
  workingTurn("s1", "Checkout", false, "done", 20_000);
  assert.deepEqual(open().map((t) => [t.text, t.timeout]), [["✦ Checkout · done ✓", DONE_MS]]);
  open()[0].expire();
  assert.equal(open().length, 0, "and no thinking after it");
  workingTurn("s2", "Docs", false, "done", 21_000);
  assert.equal(open().length, 0, "another session's turn ending shows nothing here");
});

test("taken down by the user or by Layerwright, it doesn't come back as thinking", () => {
  working("Checkout", "inspect", {}, true, 1000, "s1");
  workingClear();
  assert.equal(open().length, 0);
  working("Checkout", "inspect", {}, true, 2000, "s1");
  working("Checkout", "editNodes", {}, true, 2100, "s1"); // replaced: its dequeue isn't a timeout
  assert.deepEqual(open().map((t) => t.text), ["✦ Checkout · editing layers…"]);
});
