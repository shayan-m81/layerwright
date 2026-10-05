// Tasks written on the canvas: "@session …" in a note (a text layer) or an annotation goes to that session once it
// stops changing, only once, and the session's answer is added under it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NoteWatch, findMention, isNote, type NoteItem } from "../src/notes.ts";

const A = { id: "sa", name: "Checkout" }, B = { id: "sb", name: "Checkout redesign" }, C = { id: "sc", name: "admin-panel" };

test("a mention: the longest session name after an @ wins, and the rest is the task", () => {
  assert.deepEqual(findMention("@Checkout make it responsive", [A, B]), { session: A, text: "make it responsive" });
  assert.deepEqual(findMention("@checkout redesign: use the new card", [A, B]), { session: B, text: "use the new card" });
  assert.deepEqual(findMention("@admin-panel این رو موبایلی کن", [C]), { session: C, text: "این رو موبایلی کن" });
  assert.deepEqual(findMention("@layerwright fix the spacing", [A]), { session: A, text: "fix the spacing" }, "@layerwright: the only session");
  assert.deepEqual(findMention("@layerwright fix the spacing", [A, C]), { unknown: "layerwright", text: "fix the spacing", generic: true }, "but not when there are several");
  assert.deepEqual(findMention("@Shop do it", [A]), { unknown: "shop", text: "do it" });
  assert.equal(findMention("mail me at me@example.com", [A]), null, "an email address isn't a mention");
  assert.equal(findMention("no mention here", [A]), null);
  assert.deepEqual(findMention("@Checkout make it responsive\n↳ Checkout: ✓ done", [A]), { session: A, text: "make it responsive" }, "its own answers aren't part of the task");
  assert.ok(isNote("  @Checkout hi") && !isNote("Price @ 10$"), "a note starts with @");
});

function setup(sessions = [A]) {
  let clock = 0;
  const data = new Map<string, string>();
  const store = { getPluginData: (k: string) => data.get(k) ?? "", setPluginData: (k: string, v: string) => { data.set(k, v); } };
  const item: NoteItem = { key: "5:6", kind: "note", text: "", store };
  const sent: { session: string; text: string }[] = [], notes: string[] = [], written: string[] = [], asks: any[][] = [], steps: (() => void)[] = [];
  const w = new NoteWatch({
    items: () => [item], sessions: () => sessions, notify: (m) => notes.push(m), asks: (l) => asks.push(l), now: () => clock,
    send: (session, _it, text) => { sent.push({ session, text }); return `q${sent.length}`; },
    write: async (_k, _kind, was, text, mark) => { if (item.text !== was) return false; mark(); item.text = text; written.push(text); return true; },
    step: (fn) => { steps.push(fn); fn(); },
  });
  return { w, item, data, sent, notes, written, asks, steps, tick: (ms: number) => { clock += ms; w.check(); } };
}

test("a note goes once it stops changing, only once, and again when the user edits it", () => {
  const t = setup();
  t.item.text = "@Checkout make"; t.tick(0); t.tick(1000);
  t.item.text = "@Checkout make it responsive"; // still typing
  t.tick(500); t.tick(1500);
  assert.equal(t.sent.length, 0, "not half-typed");
  t.tick(600);
  assert.deepEqual(t.sent, [{ session: "sa", text: "make it responsive" }]);
  t.tick(3000); t.tick(3000);
  assert.equal(t.sent.length, 1, "only once (remembered on the layer, for every window)");
  t.item.text = "@Checkout make it responsive, and darker";
  t.tick(0); t.tick(2100);
  assert.equal(t.sent.length, 2, "edited: it goes again");
});

test("a note the user is still on (selected) waits longer", () => {
  const t = setup();
  t.item.text = "@Checkout make it responsive"; t.item.editing = true;
  t.tick(0); t.tick(2500);
  assert.equal(t.sent.length, 0);
  t.tick(4000);
  assert.equal(t.sent.length, 1);
});

test("a word for any session, with several connected: the note waits in the window for the user to pick one, or to let it go", () => {
  const t = setup([A, C]);
  t.item.text = "@claude یه متن رندم بده"; t.tick(0); t.tick(2100);
  assert.equal(t.sent.length, 0);
  assert.deepEqual(t.asks.at(-1), [{ key: "5:6", text: "یه متن رندم بده", name: "claude" }]);
  t.tick(3000);
  assert.equal(t.asks.length, 1, "asked once, not every moment");
  t.w.sendTo("5:6", "sc");
  assert.deepEqual(t.sent, [{ session: "sc", text: "یه متن رندم بده" }]);
  assert.deepEqual(t.asks.at(-1), [], "the card goes");
  t.tick(0); t.tick(3000);
  assert.equal(t.sent.length, 1, "and it isn't sent again");
  t.item.text = "@ai another one"; t.tick(0); t.tick(2100);
  t.w.dismiss("5:6");
  t.tick(0); t.tick(3000);
  assert.deepEqual(t.asks.at(-1), [], "let go: it stays quiet until edited");
  assert.equal(t.sent.length, 1);
});

test("an @name that is no session's (\"@john_doe followed you\" in a design): a low-key card that goes by itself, nothing written to the layer, nothing said in Figma", () => {
  const t = setup([A, C]);
  t.item.text = "@john_doe followed you"; t.tick(0); t.tick(2100);
  assert.deepEqual(t.asks.at(-1), [{ key: "5:6", text: "followed you", name: "john_doe", quiet: true }]);
  assert.equal(t.data.size, 0, "no plugin data on the user's layer");
  assert.equal(t.notes.length, 0, "no notification");
  t.tick(t.w.quietMs);
  assert.deepEqual(t.asks.at(-1), [], "the card goes by itself");
  t.tick(0); t.tick(3000);
  assert.deepEqual(t.asks.at(-1), [], "and doesn't come back while the text stays the same");
  t.item.text = "@john_doe"; t.tick(0); t.tick(2100);
  assert.equal(t.notes.length, 0, "a bare unknown @name: not even a hint");
  t.item.text = "write to me@example.com"; t.tick(0); t.tick(2100);
  assert.equal(t.data.size + t.steps.length, 0, "an @ that mentions nobody leaves the layer alone");
  t.item.text = "@shop make it blue"; t.tick(0); t.tick(2100);
  t.w.sendTo("5:6", "sc");
  assert.deepEqual(t.sent, [{ session: "sc", text: "make it blue" }], "the user can still send it to a session");
  assert.ok(t.data.size, "and then it is remembered on the layer");
});

test("what a note remembers on the layer is written as a step of the host's (an undo step of its own)", () => {
  const t = setup();
  t.item.text = "@Checkout make it responsive"; t.tick(0); t.tick(2100);
  assert.equal(t.sent.length, 1);
  assert.equal(t.steps.length, 1, "the plugin data went through host.step");
});

test("the session's answer goes under the note, and doesn't send it again", async () => {
  const t = setup();
  t.item.text = "@Checkout make it responsive"; t.tick(0); t.tick(2100);
  await t.w.finished("q1", "done", "Made the card fluid on mobile");
  assert.equal(t.item.text, "@Checkout make it responsive\n↳ Checkout: ✓ Made the card fluid on mobile");
  t.tick(0); t.tick(3000);
  assert.equal(t.sent.length, 1);
  await t.w.finished("q9", "done", "not ours");
  assert.equal(t.written.length, 1);
});

test("an annotation's answer goes after a blank line; a changed one is left alone", async () => {
  const t = setup();
  t.item.kind = "annotation"; t.item.key = "1:2#0";
  t.item.text = "@Checkout fix the spacing"; t.tick(0); t.tick(2100);
  t.item.text = "@Checkout fix the spacing please"; // the user changed it meanwhile
  await t.w.finished("q1", "failed", "needs the spacing tokens");
  assert.equal(t.written.length, 0);
  t.tick(0); t.tick(2100);
  await t.w.finished("q2", "failed", "needs the spacing tokens");
  assert.equal(t.item.text, "@Checkout fix the spacing please\n\n↳ Checkout: ✗ needs the spacing tokens");
});
